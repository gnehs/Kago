import type { Db } from "../db/db.js";
import { id, now } from "../lib/ids.js";

export type AuditInput = {
  actorType: "user" | "share_link" | "system";
  actorId?: string;
  action: string;
  rootId?: string;
  path?: string;
  target?: unknown;
  result: "success" | "failure" | "denied";
  ip?: string;
  userAgent?: string;
};

export class AuditService {
  constructor(private readonly db: Db) {}

  write(input: AuditInput): void {
    this.db
      .prepare(
        `INSERT INTO audit_logs
        (id, actor_type, actor_id, action, root_id, path, target_json, result, ip, user_agent, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id("audit"),
        input.actorType,
        input.actorId ?? null,
        input.action,
        input.rootId ?? null,
        input.path ?? null,
        input.target ? JSON.stringify(input.target) : null,
        input.result,
        input.ip ?? null,
        input.userAgent ?? null,
        now()
      );
  }

  list(limit = 200) {
    return this.db
      .prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?")
      .all(Math.min(Math.max(limit, 1), 500));
  }
}
