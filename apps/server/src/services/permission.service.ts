import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { nfc } from "../lib/filename.js";
import { id, now } from "../lib/ids.js";
import type { AuditService } from "./audit.service.js";
import type { Actor, Root } from "./types.js";

/** What a rule grants: `view` lists, opens and downloads; `edit` adds every change to what is there. */
export const levels = ["view", "edit"] as const;

export type Level = (typeof levels)[number];

export const permissionInputSchema = z.object({
  principalType: z.enum(["user", "group"]),
  principalId: z.string().min(1),
  rootId: z.string().min(1),
  pathPrefix: z.string().min(1).default("/"),
  level: z.enum(levels),
  recursive: z.boolean().default(true)
});

type PermissionRule = {
  id: string;
  principal_type: "user" | "group";
  principal_id: string;
  root_id: string;
  path_prefix: string;
  level: Level;
  recursive: number;
};

export class PermissionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService
  ) {}

  can(actor: Actor, level: Level, root: Root, logicalPath: string): { allowed: boolean; reason?: string } {
    if (actor.disabled) return { allowed: false, reason: "User disabled" };
    if (root.readonly && level === "edit") return { allowed: false, reason: "Root is readonly" };
    if (actor.role === "ADMIN") return { allowed: true };

    // Rules only grant: the user's own and their groups' add up, and an edit rule covers viewing too.
    const granted = this.rulesForPrincipals(this.principalsFor(actor.id), root.id).filter((rule) => this.pathMatches(rule, logicalPath));
    if (granted.some((rule) => rule.level === "edit" || level === "view")) return { allowed: true };
    return { allowed: false, reason: "No permission" };
  }

  /** Whether a rule grants something further down, so the folders leading to it can be walked through. */
  canReachDescendant(actor: Actor, root: Root, logicalPath: string): boolean {
    if (actor.disabled) return false;
    if (actor.role === "ADMIN") return true;
    return this.rulesForPrincipals(this.principalsFor(actor.id), root.id).some((rule) => isDescendantPath(rule.path_prefix, logicalPath));
  }

  require(actor: Actor, level: Level, root: Root, logicalPath: string): void {
    const result = this.can(actor, level, root, logicalPath);
    if (!result.allowed) {
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "permission_denied",
        rootId: root.id,
        path: logicalPath,
        target: { level, reason: result.reason ?? "Forbidden" },
        result: "denied"
      });
      throw new AppError(403, result.reason ?? "Forbidden", "FORBIDDEN");
    }
  }

  list(rootId?: string) {
    if (rootId) return this.db.prepare("SELECT * FROM permission_rules WHERE root_id = ?").all(rootId);
    return this.db.prepare("SELECT * FROM permission_rules ORDER BY created_at DESC").all();
  }

  listForPath(rootId: string, logicalPath: string) {
    return rows<PermissionRule>(
      this.db
        .prepare("SELECT * FROM permission_rules WHERE root_id = ? ORDER BY length(path_prefix) DESC, created_at DESC")
        .all(rootId)
    ).filter((rule) => this.pathMatches(rule, logicalPath));
  }

  get(ruleId: string): PermissionRule {
    const rule = row<PermissionRule>(this.db.prepare("SELECT * FROM permission_rules WHERE id = ?").get(ruleId));
    if (!rule) throw new AppError(404, "Permission rule not found", "PERMISSION_RULE_NOT_FOUND");
    return rule;
  }

  create(input: z.infer<typeof permissionInputSchema>) {
    this.assertPrincipalExists(input.principalType, input.principalId);
    const ts = now();
    const item = {
      id: id("perm"),
      principal_type: input.principalType,
      principal_id: input.principalId,
      root_id: input.rootId,
      path_prefix: input.pathPrefix,
      level: input.level,
      recursive: input.recursive ? 1 : 0,
      created_at: ts,
      updated_at: ts
    };
    this.db
      .prepare(
        `INSERT INTO permission_rules
        (id, principal_type, principal_id, root_id, path_prefix, level, recursive, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.principal_type,
        item.principal_id,
        item.root_id,
        item.path_prefix,
        item.level,
        item.recursive,
        item.created_at,
        item.updated_at
      );
    return item;
  }

  delete(ruleId: string): void {
    this.db.prepare("DELETE FROM permission_rules WHERE id = ?").run(ruleId);
  }

  /** Rebase rules anchored at a moved path, keeping the move and related database updates atomic. */
  rebasePathRules(
    fromRootId: string,
    fromPath: string,
    toRootId: string,
    toPath: string,
    updateRelatedRows?: () => void
  ): void {
    const sourcePrefix = nfc(fromPath);
    const targetPrefix = nfc(toPath);
    let transactionStarted = false;

    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionStarted = true;

      const rules = rows<Pick<PermissionRule, "id" | "path_prefix">>(
        this.db.prepare("SELECT id, path_prefix FROM permission_rules WHERE root_id = ?").all(fromRootId)
      );
      const update = this.db.prepare(
        "UPDATE permission_rules SET root_id = ?, path_prefix = ?, updated_at = ? WHERE id = ?"
      );
      const updatedAt = now();

      for (const rule of rules) {
        const rulePrefix = nfc(rule.path_prefix);
        if (!isPathWithin(rulePrefix, sourcePrefix)) continue;

        // The destination's own rules stay as they are: rules only grant, so the two sets add up.
        const suffix = sourcePrefix === "/" ? rulePrefix : rulePrefix.slice(sourcePrefix.length);
        const rebasedPath = suffix
          ? targetPrefix === "/" ? suffix : `${targetPrefix}${suffix}`
          : targetPrefix;
        update.run(toRootId, rebasedPath, updatedAt, rule.id);
      }

      updateRelatedRows?.();
      this.db.exec("COMMIT");
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // SQLite may already have rolled the transaction back after a storage error.
        }
      }
      throw error;
    }
  }

  private principalsFor(userId: string): Array<{ type: "user" | "group"; id: string }> {
    const groups = rows<{ group_id: string }>(
      this.db.prepare("SELECT group_id FROM group_members WHERE user_id = ?").all(userId)
    );
    return [{ type: "user", id: userId }, ...groups.map((group) => ({ type: "group" as const, id: group.group_id }))];
  }

  private rulesForPrincipals(
    principals: Array<{ type: "user" | "group"; id: string }>,
    rootId: string
  ): PermissionRule[] {
    if (principals.length === 0) return [];
    return rows<PermissionRule>(
      this.db
        .prepare(
          `SELECT * FROM permission_rules
          WHERE root_id = ? AND (${principals.map(() => "(principal_type = ? AND principal_id = ?)").join(" OR ")})
          ORDER BY length(path_prefix) DESC`
        )
        .all(rootId, ...principals.flatMap((principal) => [principal.type, principal.id]))
    );
  }

  private assertPrincipalExists(principalType: "user" | "group", principalId: string): void {
    const table = principalType === "user" ? "users" : "groups";
    const existing = row<{ id: string }>(this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(principalId));
    if (!existing) throw new AppError(400, "Permission principal not found", "PRINCIPAL_NOT_FOUND");
  }

  // Compared in NFC so a rule covers a name however the filesystem happens to store it.
  private pathMatches(rule: PermissionRule, rawLogicalPath: string): boolean {
    const logicalPath = nfc(rawLogicalPath);
    const prefix = nfc(rule.path_prefix);
    if (logicalPath === prefix) return true;
    if (!rule.recursive) return false;
    return logicalPath.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`);
  }
}

function isPathWithin(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true;
  if (prefix === "/") return candidate.startsWith("/");
  return candidate.startsWith(`${prefix}/`);
}

function isDescendantPath(rawCandidate: string, rawLogicalPath: string): boolean {
  const candidate = nfc(rawCandidate);
  const logicalPath = nfc(rawLogicalPath);
  if (candidate === logicalPath) return true;
  if (logicalPath === "/") return candidate.startsWith("/");
  return candidate.startsWith(logicalPath.endsWith("/") ? logicalPath : `${logicalPath}/`);
}
