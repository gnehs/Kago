import { z } from "zod";
import type { Db } from "../db/db.js";
import { rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { AuditService } from "./audit.service.js";
import type { Actor, Root } from "./types.js";

export const actions = [
  "list",
  "read",
  "download",
  "upload",
  "create_folder",
  "rename",
  "move",
  "copy",
  "delete",
  "share",
  "manage_tags",
  "manage_permissions",
  "run_rsync",
  "compress",
  "extract"
] as const;

export type Action = (typeof actions)[number];

export const permissionInputSchema = z.object({
  principalType: z.enum(["user", "group", "share_link"]),
  principalId: z.string().min(1),
  rootId: z.string().min(1),
  pathPrefix: z.string().min(1).default("/"),
  allow: z.array(z.enum(actions)).default([]),
  deny: z.array(z.enum(actions)).default([]),
  recursive: z.boolean().default(true)
});

type PermissionRule = {
  id: string;
  principal_type: "user" | "group" | "share_link";
  principal_id: string;
  root_id: string;
  path_prefix: string;
  allow_json: string;
  deny_json: string;
  recursive: number;
};

const readonlyBlocked = new Set<Action>([
  "upload",
  "create_folder",
  "rename",
  "move",
  "delete",
  "manage_tags",
  "manage_permissions",
  "compress",
  "extract"
]);

export class PermissionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService
  ) {}

  can(actor: Actor, action: Action, root: Root, logicalPath: string): { allowed: boolean; reason?: string } {
    if (actor.disabled) return { allowed: false, reason: "User disabled" };
    if (root.readonly && readonlyBlocked.has(action)) return { allowed: false, reason: "Root is readonly" };
    if (actor.role === "ADMIN") return { allowed: true };

    const principals = this.principalsFor(actor.id);
    const rules = rows<PermissionRule>(
      this.db
        .prepare(
          `SELECT * FROM permission_rules
          WHERE root_id = ? AND (${principals.map(() => "(principal_type = ? AND principal_id = ?)").join(" OR ")})
          ORDER BY length(path_prefix) DESC`
        )
        .all(root.id, ...principals.flatMap((principal) => [principal.type, principal.id]))
    ).filter((rule) => this.pathMatches(rule, logicalPath));

    for (const rule of rules) {
      if ((JSON.parse(rule.deny_json) as string[]).includes(action)) return { allowed: false, reason: "Denied" };
    }

    for (const rule of rules) {
      if ((JSON.parse(rule.allow_json) as string[]).includes(action)) return { allowed: true };
    }

    return { allowed: false, reason: "No permission" };
  }

  require(actor: Actor, action: Action, root: Root, logicalPath: string): void {
    const result = this.can(actor, action, root, logicalPath);
    if (!result.allowed) {
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "permission_denied",
        rootId: root.id,
        path: logicalPath,
        target: { action, reason: result.reason ?? "Forbidden" },
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

  create(input: z.infer<typeof permissionInputSchema>) {
    const ts = now();
    const item = {
      id: id("perm"),
      principal_type: input.principalType,
      principal_id: input.principalId,
      root_id: input.rootId,
      path_prefix: input.pathPrefix.startsWith("/") ? input.pathPrefix : `/${input.pathPrefix}`,
      allow_json: JSON.stringify(input.allow),
      deny_json: JSON.stringify(input.deny),
      recursive: input.recursive ? 1 : 0,
      created_at: ts,
      updated_at: ts
    };
    this.db
      .prepare(
        `INSERT INTO permission_rules
        (id, principal_type, principal_id, root_id, path_prefix, allow_json, deny_json, recursive, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        item.id,
        item.principal_type,
        item.principal_id,
        item.root_id,
        item.path_prefix,
        item.allow_json,
        item.deny_json,
        item.recursive,
        item.created_at,
        item.updated_at
      );
    return item;
  }

  delete(ruleId: string): void {
    this.db.prepare("DELETE FROM permission_rules WHERE id = ?").run(ruleId);
  }

  private principalsFor(userId: string): Array<{ type: "user" | "group"; id: string }> {
    const groups = rows<{ group_id: string }>(
      this.db.prepare("SELECT group_id FROM group_members WHERE user_id = ?").all(userId)
    );
    return [{ type: "user", id: userId }, ...groups.map((group) => ({ type: "group" as const, id: group.group_id }))];
  }

  private pathMatches(rule: PermissionRule, logicalPath: string): boolean {
    if (logicalPath === rule.path_prefix) return true;
    if (!rule.recursive) return false;
    return logicalPath.startsWith(rule.path_prefix.endsWith("/") ? rule.path_prefix : `${rule.path_prefix}/`);
  }
}
