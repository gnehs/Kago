import { z } from "zod";
import type { Db } from "../db/db.js";
import { id, now } from "../lib/ids.js";

/** `before` is the last row of the page already shown, as `<created_at>:<id>`. */
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  before: z
    .string()
    .regex(/^\d{1,16}:[\w-]{1,64}$/)
    .transform((value) => {
      const split = value.indexOf(":");
      return { at: Number(value.slice(0, split)), id: value.slice(split + 1) };
    })
    .optional(),
  actor: z.string().min(1).max(64).optional(),
  action: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  result: z.enum(["success", "failure", "denied"]).optional()
});
export type AuditQuery = z.output<typeof auditQuerySchema>;

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

/** What is kept of each thing a caller wrote: enough to read, not enough to fill the disk a row at a time. */
const MAX_TEXT = 512;
const MAX_TARGET = 4096;
/**
 * How many failures a caller who is not signed in may have written down in a stretch of time. Anyone can fail at
 * will, and each failure is a row; past this, the ones already written say what is going on.
 */
const ANONYMOUS_FAILURES = 120;
const ANONYMOUS_WINDOW_MS = 10 * 60_000;
const MAX_TRACKED_ADDRESSES = 10_000;
/** The log is the newest this many rows; a server that has been failed at for years does not keep every one. */
const MAX_ROWS = 500_000;

const clip = (value: string | undefined, length = MAX_TEXT) => (value === undefined ? null : value.length > length ? `${value.slice(0, length)}…` : value);

/** A target as it is stored: its long strings cut short, and the whole of it dropped if it is still too much. */
function targetJson(target: unknown): string | null {
  if (!target) return null;
  const json = JSON.stringify(target, (_key, value: unknown) => (typeof value === "string" ? clip(value) : value));
  return json.length > MAX_TARGET ? JSON.stringify({ truncated: true }) : json;
}

export class AuditService {
  private readonly anonymous = new Map<string, { count: number; since: number }>();

  constructor(private readonly db: Db) {}

  write(input: AuditInput): void {
    // Only what a request brought about is counted; what the server did by itself has no address and is always kept.
    if (input.result !== "success" && input.actorType !== "user" && input.ip !== undefined && !this.admitAnonymous(input.ip)) return;
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
        clip(input.path, 2048),
        targetJson(input.target),
        input.result,
        clip(input.ip, 64),
        clip(input.userAgent),
        now()
      );
  }

  /** Drops what is older than the newest rows the log keeps. Returns how many went. */
  prune(keep = MAX_ROWS): number {
    return Number(this.db.prepare("DELETE FROM audit_logs WHERE created_at <= (SELECT created_at FROM audit_logs ORDER BY created_at DESC LIMIT 1 OFFSET ?)").run(keep).changes);
  }

  private admitAnonymous(address: string): boolean {
    const ts = Date.now();
    let entry = this.anonymous.get(address);
    if (!entry || ts - entry.since > ANONYMOUS_WINDOW_MS) {
      if (this.anonymous.size >= MAX_TRACKED_ADDRESSES) this.anonymous.clear();
      entry = { count: 0, since: ts };
      this.anonymous.set(address, entry);
    }
    entry.count += 1;
    return entry.count <= ANONYMOUS_FAILURES;
  }

  list(query: AuditQuery = { limit: 200 }) {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (query.before !== undefined) {
      // Rows made in the same millisecond are told apart by id, so a page never skips or repeats one.
      where.push("(audit_logs.created_at < ? OR (audit_logs.created_at = ? AND audit_logs.id < ?))");
      args.push(query.before.at, query.before.at, query.before.id);
    }
    if (query.actor) {
      where.push("audit_logs.actor_id = ?");
      args.push(query.actor);
    }
    if (query.action) {
      where.push("audit_logs.action = ?");
      args.push(query.action);
    }
    if (query.result) {
      where.push("audit_logs.result = ?");
      args.push(query.result);
    }
    return this.db
      .prepare(
        `SELECT audit_logs.*, users.display_name AS actor_name, users.email AS actor_email
        FROM audit_logs LEFT JOIN users ON users.id = audit_logs.actor_id
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY audit_logs.created_at DESC, audit_logs.id DESC LIMIT ?`
      )
      .all(...args, query.limit);
  }
}
