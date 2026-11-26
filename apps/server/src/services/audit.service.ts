import path from "node:path";
import { z } from "zod";
import type { AuditAction, AuditBurst, AuditCategory, AuditLog } from "@kago/contract";
import type { Db } from "../db/db.js";
import { auditCategories, classificationKey, classify, auditActions } from "../lib/audit-actions.js";
import { id, now } from "../lib/ids.js";
import { logger } from "../lib/logger.js";

const reading = (value: string) => value === "true";
const results = z.enum(["success", "failure", "denied"]);

/** `before` is the last row of the page already shown, as `<created_at>:<id>`. */
export const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  before: z
    .string()
    .regex(/^\d{1,16}:[\w-]{1,64}$/)
    .transform(cursor)
    .optional(),
  actor: z.string().min(1).max(64).optional(),
  action: z.string().regex(/^[a-z_]{1,64}$/).optional(),
  /** One result, or several separated by commas. */
  result: z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(results).min(1).max(3))
    .optional(),
  category: z.enum(auditCategories).optional(),
  important: z.enum(["true", "false"]).transform(reading).optional(),
  from: z.coerce.number().int().min(0).optional(),
  to: z.coerce.number().int().min(0).optional(),
  q: z.string().trim().min(1).max(100).optional()
});
export type AuditQuery = z.output<typeof auditQuerySchema>;

function cursor(value: string) {
  const split = value.indexOf(":");
  return { at: Number(value.slice(0, split)), id: value.slice(split + 1) };
}

export const auditRunMembersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  before: z
    .string()
    .regex(/^\d{1,16}:[\w-]{1,64}$/)
    .transform(cursor)
    .optional()
});

export type AuditInput = {
  actorType: "user" | "share_link" | "system";
  actorId?: string;
  action: AuditAction;
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
/** From this many rows the class is written again with a line before and after, so a slow start is not a silent one. */
const CLASS_AGAIN_ALOUD = 200_000;
/** A row joins the run of the one before it when that was at most this many seconds earlier... */
const RUN_GAP = 60;
/** ...unless the run is already this old: a run that never pauses is still cut into pieces an admin can read. */
const RUN_SPAN = 3600;
/** Folders a run lists; past this it only says there are more. */
const RUN_FOLDERS = 50;
const MAX_SUBJECT = 512;
/** People, groups and locations a search for a name stands for, at most. */
const NAMED_AT_MOST = 50;

type Folder = { root_id: string | null; path: string };
type Folders = { f: Folder[]; more: boolean };

const clip = (value: string | undefined, length = MAX_TEXT) => (value === undefined ? null : value.length > length ? `${value.slice(0, length)}…` : value);

/** A target as it is stored: its long strings cut short, and the whole of it dropped if it is still too much. */
function targetJson(target: unknown): string | null {
  if (!target) return null;
  const json = JSON.stringify(target, (_key, value: unknown) => (typeof value === "string" ? clip(value) : value));
  return json.length > MAX_TARGET ? JSON.stringify({ truncated: true }) : json;
}

/** Every string a target holds, which is what a search reads: names and emails and ids, never the keys around them. */
function subjectOf(json: string | null): string | null {
  if (!json) return null;
  const found: string[] = [];
  const walk = (value: unknown, depth: number) => {
    if (found.length >= 60 || depth > 4) return;
    if (typeof value === "string") found.push(value);
    else if (Array.isArray(value)) for (const item of value) walk(item, depth + 1);
    else if (value && typeof value === "object") for (const item of Object.values(value)) walk(item, depth + 1);
  };
  try {
    walk(JSON.parse(json), 0);
  } catch {
    return null;
  }
  return found.length ? found.join(" ").slice(0, MAX_SUBJECT) : null;
}

function foldersWith(previous: string | null, rootId: string | null, filePath: string | null): Folders {
  const folders: Folders = previous ? (JSON.parse(previous) as Folders) : { f: [], more: false };
  if (filePath === null) return folders;
  const folder = { root_id: rootId, path: path.posix.dirname(filePath) };
  const rest = folders.f.filter((item) => item.root_id !== folder.root_id || item.path !== folder.path);
  const more = folders.more || rest.length + 1 > RUN_FOLDERS;
  return { f: [folder, ...rest].slice(0, RUN_FOLDERS), more };
}

const like = (text: string) => `%${text.replace(/[\\%_]/g, "\\$&")}%`;

type Row = {
  id: string;
  actor_type: AuditLog["actor_type"];
  actor_id: string | null;
  actor_name: string | null;
  actor_email: string | null;
  action: AuditAction;
  category: AuditCategory | null;
  signal: AuditLog["signal"];
  root_id: string | null;
  root_name: string | null;
  root_slug: string | null;
  path: string | null;
  target_json: string | null;
  result: AuditLog["result"];
  ip: string | null;
  user_agent: string | null;
  created_at: number;
  run_id: string | null;
  run_count: number;
  run_first_at: number | null;
  run_folders: string | null;
};

const SELECT_ENTRY = `SELECT a.id, a.actor_type, a.actor_id, u.display_name AS actor_name, u.email AS actor_email, a.action, a.category, a.signal,
  a.root_id, r.name AS root_name, r.slug AS root_slug, a.path, a.target_json, a.result, a.ip, a.user_agent, a.created_at,
  a.run_id, a.run_count, a.run_first_at, a.run_folders
  FROM audit_logs a
  LEFT JOIN users u ON u.id = a.actor_id AND a.actor_type = 'user'
  LEFT JOIN roots r ON r.id = a.root_id`;

function entry(row: Row, withBurst: boolean): AuditLog {
  const { run_id, run_count, run_first_at, run_folders, category, ...rest } = row;
  let burst: AuditBurst | null = null;
  if (withBurst && run_count > 1 && run_id) {
    const folders = run_folders ? (JSON.parse(run_folders) as Folders) : { f: [], more: false };
    burst = { id: run_id, count: run_count, first_at: run_first_at ?? row.created_at, folders: folders.f, folders_truncated: folders.more };
  }
  return { ...rest, category: category ?? "system", burst };
}

export class AuditService {
  private readonly anonymous = new Map<string, { count: number; since: number }>();
  private statements: { join: ReturnType<Db["prepare"]>; insert: ReturnType<Db["prepare"]>; release: ReturnType<Db["prepare"]> } | undefined;

  constructor(private readonly db: Db) {}

  write(input: AuditInput): void {
    // Only what a request brought about is counted; what the server did by itself has no address and is always kept.
    if (input.result !== "success" && input.actorType !== "user" && input.ip !== undefined && !this.admitAnonymous(input.ip)) return;
    const { join, insert, release } = (this.statements ??= {
      release: this.db.prepare("UPDATE audit_logs SET run_folders = NULL WHERE id = ?"),
      join: this.db.prepare(
        `UPDATE audit_logs SET head = 0
        WHERE id = (SELECT id FROM audit_logs WHERE head = 1 AND run_id IS NOT NULL AND actor_type = ? AND actor_id IS ? AND action = ? AND result = ? AND signal = ?
          AND created_at >= ? AND run_first_at >= ? ORDER BY created_at DESC LIMIT 1)
        RETURNING id, run_id, run_count, run_first_at, run_folders`
      ),
      insert: this.db.prepare(
        `INSERT INTO audit_logs
        (id, actor_type, actor_id, action, root_id, path, target_json, result, ip, user_agent, created_at, category, signal, subject, run_id, run_count, run_first_at, run_folders, head)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
      )
    });
    const rowId = id("audit");
    const at = now();
    const target = targetJson(input.target);
    const kind = classify(input.action, input.target);
    const filePath = clip(input.path, 2048);
    // The run is joined and the row written under one lock, so that two writers never leave a run with two heads.
    this.db.exec("SAVEPOINT audit_write");
    try {
      const previous = join.get(input.actorType, input.actorId ?? null, input.action, input.result, kind.signal, at - RUN_GAP, at - RUN_SPAN) as { id: string; run_id: string; run_count: number; run_first_at: number; run_folders: string | null } | undefined;
      // The returned row is as it is after the update, so what the old head held is cleared once it has been read.
      if (previous) release.run(previous.id);
      insert.run(
        rowId,
        input.actorType,
        input.actorId ?? null,
        input.action,
        input.rootId ?? null,
        filePath,
        target,
        input.result,
        clip(input.ip, 64),
        clip(input.userAgent),
        at,
        kind.category,
        kind.signal,
        subjectOf(target),
        previous?.run_id ?? rowId,
        (previous?.run_count ?? 0) + 1,
        previous?.run_first_at ?? at,
        JSON.stringify(foldersWith(previous?.run_folders ?? null, input.rootId ?? null, filePath))
      );
      this.db.exec("RELEASE audit_write");
    } catch (error) {
      this.db.exec("ROLLBACK TO audit_write; RELEASE audit_write");
      throw error;
    }
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

  /**
   * The log newest first, one row to a run (the run's newest). Every filter but the text and the dates looks at the
   * run's head alone, since a run is of one actor, action and result; those two look at every row of the run, so a run
   * is found by any one of its files, and a run that straddled midnight is in either day.
   */
  list(query: AuditQuery = { limit: 200 }): AuditLog[] {
    const where: string[] = ["a.head = 1"];
    const args: Array<string | number> = [];
    if (query.before !== undefined) {
      // Rows made in the same second are told apart by id, so a page never skips or repeats one.
      where.push("(a.created_at < ? OR (a.created_at = ? AND a.id < ?))");
      args.push(query.before.at, query.before.at, query.before.id);
    }
    if (query.actor === "system" || query.actor === "share_link") {
      where.push("a.actor_type = ?");
      args.push(query.actor);
    } else if (query.actor) {
      where.push("a.actor_type = ? AND a.actor_id = ?");
      args.push(query.actor.startsWith("share_") ? "share_link" : "user", query.actor);
    }
    if (query.action) {
      where.push("a.action = ?");
      args.push(query.action);
    }
    if (query.result) {
      // The log of "not success" is its own index, which only a request for exactly that can use.
      if (query.result.length === 2 && query.result.includes("failure") && query.result.includes("denied")) where.push("a.result <> 'success'");
      else {
        where.push(`a.result IN (${query.result.map(() => "?").join(", ")})`);
        args.push(...query.result);
      }
    }
    if (query.category) {
      where.push("a.category = ?");
      args.push(query.category);
    }
    if (query.important) where.push("a.signal = 'normal'");
    if (query.from !== undefined) {
      where.push("a.created_at >= ?");
      args.push(query.from);
    }
    if (query.to !== undefined) {
      // A run starting before `to` ended no later than a span and a gap after it.
      where.push("a.run_first_at < ? AND a.created_at < ?");
      args.push(query.to, query.to + RUN_SPAN + RUN_GAP);
    }
    if (query.q) {
      const found = this.matching(query.q);
      where.push(`a.run_id IN (SELECT m.run_id FROM audit_logs m WHERE ${found.sql})`);
      args.push(...found.args);
    }
    const rows = this.db
      .prepare(`${SELECT_ENTRY} WHERE ${where.join(" AND ")} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
      .all(...args, query.limit) as Row[];
    return rows.map((row) => entry(row, true));
  }

  /** The rows of one run, newest first, or null when there is no such run (it may have been pruned). */
  runMembers(runId: string, query: z.output<typeof auditRunMembersSchema>): AuditLog[] | null {
    const args: Array<string | number> = [runId];
    let before = "";
    if (query.before !== undefined) {
      before = "AND (a.created_at < ? OR (a.created_at = ? AND a.id < ?))";
      args.push(query.before.at, query.before.at, query.before.id);
    }
    const rows = this.db
      .prepare(`${SELECT_ENTRY} WHERE a.run_id = ? ${before} ORDER BY a.created_at DESC, a.id DESC LIMIT ?`)
      .all(...args, query.limit) as Row[];
    if (rows.length === 0 && !this.db.prepare("SELECT 1 FROM audit_logs WHERE run_id = ? LIMIT 1").get(runId)) return null;
    return rows.map((row) => entry(row, false));
  }

  /**
   * What a typed text stands for: the paths and subjects that contain it, and everything done by or to the people,
   * and in the groups and locations, whose names or emails contain it. A person is looked up first, so that a
   * search for a name does not read every row's name.
   */
  private matching(text: string): { sql: string; args: Array<string | number> } {
    const pattern = like(text);
    // `actor_id = text` is a share's or a person's own id, typed whole.
    const clauses = ["m.path LIKE ? ESCAPE '\\'", "m.subject LIKE ? ESCAPE '\\'", "m.actor_id = ?"];
    const args: Array<string | number> = [pattern, pattern, text];
    const named = (table: string, columns: string[]) =>
      (this.db.prepare(`SELECT id FROM ${table} WHERE ${columns.map((column) => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")} LIMIT ${NAMED_AT_MOST}`).all(...columns.map(() => pattern)) as Array<{ id: string }>).map((item) => item.id);
    const users = named("users", ["display_name", "email"]);
    const groups = named("groups", ["name"]);
    if (users.length) {
      clauses.push(`m.actor_id IN (${users.map(() => "?").join(", ")})`);
      args.push(...users);
    }
    for (const subject of [...users, ...groups]) {
      clauses.push("m.subject LIKE ? ESCAPE '\\'");
      args.push(like(subject));
    }
    const roots = this.db.prepare(`SELECT id, name, slug FROM roots WHERE name LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\' LIMIT ${NAMED_AT_MOST}`).all(pattern, pattern) as Array<{ id: string }>;
    if (roots.length) {
      clauses.push(`m.root_id IN (${roots.map(() => "?").join(", ")})`);
      args.push(...roots.map((root) => root.id));
    }
    // A path as it is shown starts with the location's name: `Documents/Contracts/NDA.docx`.
    const slash = text.indexOf("/");
    if (slash > 0) {
      const first = text.slice(0, slash);
      const rest = text.slice(slash);
      const owners = this.db.prepare("SELECT id FROM roots WHERE lower(name) = lower(?) OR lower(slug) = lower(?) LIMIT 5").all(first, first) as Array<{ id: string }>;
      for (const owner of owners) {
        clauses.push("(m.root_id = ? AND m.path LIKE ? ESCAPE '\\')");
        args.push(owner.id, like(rest));
      }
    }
    return { sql: clauses.join(" OR "), args };
  }
}

/** Places the rows written before runs existed in runs, and classes them. Safe to run twice, or in two processes at once. */
export function placeAuditRows(db: Db, batch = 5000): number {
  const rows = db.prepare(
    "SELECT id, actor_type, actor_id, action, result, root_id, path, target_json, created_at FROM audit_logs WHERE run_id IS NULL ORDER BY created_at, id LIMIT ?"
  );
  const place = db.prepare("UPDATE audit_logs SET category = ?, signal = ?, subject = ?, run_id = ?, run_count = ?, run_first_at = ?, run_folders = ?, head = 1 WHERE id = ? AND run_id IS NULL");
  const fold = db.prepare("UPDATE audit_logs SET head = 0, run_folders = NULL WHERE id = ?");
  type Old = { id: string; actor_type: string; actor_id: string | null; action: string; result: string; root_id: string | null; path: string | null; target_json: string | null; created_at: number };
  const open = new Map<string, { runId: string; first: number; last: number; count: number; folders: string | null; head: string }>();
  let placed = 0;
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    let page: Old[];
    try {
      page = rows.all(batch) as Old[];
      for (const old of page) {
        let target: unknown;
        try {
          target = old.target_json ? JSON.parse(old.target_json) : undefined;
        } catch {
          target = undefined;
        }
        const kind = classify(old.action, target);
        const key = JSON.stringify([old.actor_type, old.actor_id, old.action, old.result, kind.signal]);
        const run = open.get(key);
        const joins = run !== undefined && old.created_at - run.last <= RUN_GAP && old.created_at - run.first <= RUN_SPAN;
        const folders = JSON.stringify(foldersWith(joins ? run.folders : null, old.root_id, old.path));
        const runId = joins ? run.runId : old.id;
        const count = joins ? run.count + 1 : 1;
        const first = joins ? run.first : old.created_at;
        place.run(kind.category, kind.signal, subjectOf(old.target_json), runId, count, first, folders, old.id);
        if (joins) fold.run(run.head);
        open.set(key, { runId, first, last: old.created_at, count, folders, head: old.id });
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    placed += page.length;
    if (page.length < batch) return placed;
  }
}

/** Writes the class of every row again when the table that sets it, or the routes that quieten refusals, are not the ones the rows were written under. */
export function classAuditRows(db: Db): void {
  const stored = db.prepare("SELECT value_json FROM app_settings WHERE key = 'audit_classes'").get() as { value_json: string } | undefined;
  if (stored && (JSON.parse(stored.value_json) as string) === classificationKey) return;
  // One pass per action over every row: about 3 s for the 500 000 the log is capped at, on a slower disk more.
  const { rows } = db.prepare("SELECT COUNT(*) AS rows FROM audit_logs").get() as { rows: number };
  const aloud = rows >= CLASS_AGAIN_ALOUD;
  const started = Date.now();
  if (aloud) logger.info(`classing ${rows} audit log rows again; the server listens once this is done`);
  db.exec("BEGIN IMMEDIATE");
  try {
    const set = db.prepare("UPDATE audit_logs SET category = ?, signal = ? WHERE action = ? AND (category IS NOT ? OR signal IS NOT ?)");
    for (const action of Object.keys(auditActions) as AuditAction[]) {
      const kind = classify(action);
      set.run(kind.category, kind.signal, action, kind.category, kind.signal);
    }
    const requests = db.prepare("SELECT id, action, target_json FROM audit_logs WHERE action IN ('request_failed', 'request_denied')").all() as Array<{ id: string; action: string; target_json: string | null }>;
    const quiet = db.prepare("UPDATE audit_logs SET signal = ? WHERE id = ? AND signal IS NOT ?");
    for (const request of requests) {
      let target: unknown;
      try {
        target = request.target_json ? JSON.parse(request.target_json) : undefined;
      } catch {
        target = undefined;
      }
      const { signal } = classify(request.action, target);
      quiet.run(signal, request.id, signal);
    }
    db.prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES ('audit_classes', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at").run(JSON.stringify(classificationKey), now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  if (aloud) logger.info(`classed ${rows} audit log rows again in ${((Date.now() - started) / 1000).toFixed(1)} s`);
}
