import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { AuditService } from "./audit.service.js";
import type { Actor, Root } from "./types.js";

/** What a rule grants in its location: `view` lists, opens and downloads; `edit` adds every change to what is there. */
export const levels = ["view", "edit"] as const;

export type Level = (typeof levels)[number];

/** What one user or group gets in one location; `level: null` leaves them with nothing there. */
export const permissionSetSchema = z.object({
  principalType: z.enum(["user", "group"]),
  principalId: z.string().min(1),
  rootId: z.string().min(1),
  level: z.enum(levels).nullable()
});

type PermissionRule = {
  id: string;
  principal_type: "user" | "group";
  principal_id: string;
  root_id: string;
  level: Level;
};

/**
 * A rule is for a whole location: whoever it names gets its level on everything inside, and nothing in a location
 * can be set apart from the rest of it. What must be kept from someone who may see a location belongs in another.
 */
export class PermissionService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService
  ) {}

  can(actor: Actor, level: Level, root: Root): { allowed: boolean; reason?: string } {
    if (actor.disabled) return { allowed: false, reason: "User disabled" };
    if (root.readonly && level === "edit") return { allowed: false, reason: "Root is readonly" };
    if (actor.role === "ADMIN") return { allowed: true };

    // Rules only grant: the user's own and their groups' add up, and an edit rule covers viewing too.
    const granted = this.rulesForPrincipals(this.principalsFor(actor.id), root.id);
    if (granted.some((rule) => rule.level === "edit" || level === "view")) return { allowed: true };
    return { allowed: false, reason: "No permission" };
  }

  /** `logicalPath` is where the actor was reaching, kept for the audit log; it does not change the answer. */
  require(actor: Actor, level: Level, root: Root, logicalPath: string): void {
    const result = this.can(actor, level, root);
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

  /** Replace whatever the principal has in this location with one rule, or with none. */
  set(input: z.infer<typeof permissionSetSchema>) {
    this.assertPrincipalExists(input.principalType, input.principalId);
    if (!input.level) {
      this.db
        .prepare("DELETE FROM permission_rules WHERE principal_type = ? AND principal_id = ? AND root_id = ?")
        .run(input.principalType, input.principalId, input.rootId);
      return null;
    }
    const ts = now();
    this.db
      .prepare(
        `INSERT INTO permission_rules (id, principal_type, principal_id, root_id, level, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (principal_type, principal_id, root_id) DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`
      )
      .run(id("perm"), input.principalType, input.principalId, input.rootId, input.level, ts, ts);
    return row<PermissionRule>(
      this.db
        .prepare("SELECT * FROM permission_rules WHERE principal_type = ? AND principal_id = ? AND root_id = ?")
        .get(input.principalType, input.principalId, input.rootId)
    );
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
          WHERE root_id = ? AND (${principals.map(() => "(principal_type = ? AND principal_id = ?)").join(" OR ")})`
        )
        .all(rootId, ...principals.flatMap((principal) => [principal.type, principal.id]))
    );
  }

  private assertPrincipalExists(principalType: "user" | "group", principalId: string): void {
    const table = principalType === "user" ? "users" : "groups";
    const existing = row<{ id: string }>(this.db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(principalId));
    if (!existing) throw new AppError(400, "Permission principal not found", "PRINCIPAL_NOT_FOUND");
  }
}
