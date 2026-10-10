import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../config/env.js";
import { id, now } from "../lib/ids.js";

export type Db = DatabaseSync;

export function openDb(env: Env, options: { interruptRunningTasks?: boolean } = {}): Db {
  const dbPath = path.join(env.appDataDir, "app.db");
  const schemaPath = path.join(import.meta.dirname, "schema.sql");
  const db = new DatabaseSync(dbPath);
  const schema = fs.readFileSync(schemaPath, "utf8");

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  db.exec(schema);
  addMissingColumns(db, "users", { avatar_at: "INTEGER" });
  addMissingColumns(db, "roots", { provider: "TEXT NOT NULL DEFAULT 'local'", config: "TEXT" });
  addMissingColumns(db, "external_apps", { embed: "INTEGER NOT NULL DEFAULT 0", auth_user: "TEXT", auth_secret: "TEXT" });
  addMissingColumns(db, "sessions", { identity_id: "TEXT", oidc_refresh: "TEXT", oidc_checked_at: "INTEGER" });
  addMissingColumns(db, "group_members", { source: "TEXT" });
  addMissingColumns(db, "tasks", { cleared: "INTEGER NOT NULL DEFAULT 0" });
  migratePermissionLevels(db);
  migratePermissionLocations(db);
  dropRsync(db);
  if (options.interruptRunningTasks ?? true) {
    db.prepare(
      "UPDATE tasks SET status = 'interrupted', updated_at = ?, finished_at = ? WHERE status = 'running'"
    ).run(now(), now());
  }

  return db;
}

/** `CREATE TABLE IF NOT EXISTS` leaves an older database's tables as they were; columns added since are added here. */
function addMissingColumns(db: Db, table: string, columns: Record<string, string>): void {
  const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name));
  for (const [name, definition] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    } catch (error) {
      // The task worker opens the database at the same moment and may have added it first.
      if (!(error instanceof Error && error.message.includes("duplicate column"))) throw error;
    }
  }
}

/**
 * Rules used to allow and deny fifteen separate actions; each now grants one level. A rule that allowed any change
 * becomes `edit`, one that only allowed looking becomes `view`, and one that allowed nothing is dropped, as are the
 * rules share links used to carry. Denies have no counterpart: what a rule denied is no longer held back by it.
 */
function migratePermissionLevels(db: Db): void {
  const columns = () => new Set((db.prepare("PRAGMA table_info(permission_rules)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns().has("allow_json")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // The task worker opens the database at the same moment and may have migrated it while this waited for the lock.
    if (columns().has("allow_json")) {
      addMissingColumns(db, "permission_rules", { level: "TEXT NOT NULL DEFAULT 'view'" });
      const setLevel = db.prepare("UPDATE permission_rules SET level = ? WHERE id = ?");
      const remove = db.prepare("DELETE FROM permission_rules WHERE id = ?");
      const changing = new Set(["upload", "create_folder", "rename", "move", "delete", "manage_tags", "compress", "extract"]);
      for (const rule of db.prepare("SELECT id, principal_type, allow_json, deny_json FROM permission_rules").all() as Array<{ id: string; principal_type: string; allow_json: string; deny_json: string }>) {
        const denied = new Set(JSON.parse(rule.deny_json) as string[]);
        const allowed = (JSON.parse(rule.allow_json) as string[]).filter((action) => !denied.has(action));
        if (rule.principal_type === "share_link" || allowed.length === 0) remove.run(rule.id);
        else setLevel.run(allowed.some((action) => changing.has(action)) ? "edit" : "view", rule.id);
      }
      db.exec("ALTER TABLE permission_rules DROP COLUMN allow_json");
      db.exec("ALTER TABLE permission_rules DROP COLUMN deny_json");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Rules used to be written for a path inside a location; each is now for a whole location. A rule for a subfolder
 * is dropped rather than widened to the location around it, which would hand out more than it ever granted, and so
 * is one kept to a folder without what is under it. Each rule dropped is written to the audit log. Of several rules
 * a user or group is left with in one location, the highest stays.
 */
function migratePermissionLocations(db: Db): void {
  const columns = () => new Set((db.prepare("PRAGMA table_info(permission_rules)").all() as Array<{ name: string }>).map((column) => column.name));
  if (!columns().has("path_prefix")) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // The task worker opens the database at the same moment and may have migrated it while this waited for the lock.
    if (columns().has("path_prefix")) {
      const audit = db.prepare(
        "INSERT INTO audit_logs (id, actor_type, action, root_id, path, target_json, result, created_at) VALUES (?, 'system', 'permission_change', ?, ?, ?, 'success', ?)"
      );
      const narrow = db.prepare("SELECT * FROM permission_rules WHERE path_prefix != '/' OR recursive = 0").all() as Array<{
        principal_type: string;
        principal_id: string;
        root_id: string;
        path_prefix: string;
        level: string;
      }>;
      for (const rule of narrow) {
        const target = { principalType: rule.principal_type, principalId: rule.principal_id, level: rule.level, deleted: true, note: "Permissions are set per location" };
        audit.run(id("audit"), rule.root_id, rule.path_prefix.slice(0, 2048), JSON.stringify(target), now());
      }
      db.exec(`
        CREATE TABLE permission_rules_per_location (
          id TEXT PRIMARY KEY,
          principal_type TEXT NOT NULL,
          principal_id TEXT NOT NULL,
          root_id TEXT NOT NULL,
          level TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (principal_type, principal_id, root_id),
          FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
        );
        INSERT OR IGNORE INTO permission_rules_per_location (id, principal_type, principal_id, root_id, level, created_at, updated_at)
          SELECT id, principal_type, principal_id, root_id, level, created_at, updated_at FROM permission_rules
          WHERE path_prefix = '/' AND recursive != 0
          ORDER BY level = 'edit' DESC, created_at DESC;
        DROP TABLE permission_rules;
        ALTER TABLE permission_rules_per_location RENAME TO permission_rules;
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Syncs could once reach another machine over rsync. The jobs that did, and the tasks that ran them, can no longer run and are dropped. */
function dropRsync(db: Db): void {
  db.exec(`
    DELETE FROM sync_jobs WHERE json_extract(source_json, '$.kind') = 'rsync' OR json_extract(destination_json, '$.kind') = 'rsync';
    DELETE FROM tasks WHERE type IN ('rsync_pull', 'rsync_push')
      OR (type = 'sync' AND 'rsync' IN (json_extract(destination, '$.sync.source.kind'), json_extract(destination, '$.sync.destination.kind')));
  `);
}

export function row<T>(value: unknown): T | null {
  return (value as T | undefined) ?? null;
}

export function rows<T>(value: unknown[]): T[] {
  return value as T[];
}
