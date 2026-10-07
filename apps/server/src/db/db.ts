import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Env } from "../config/env.js";
import { now } from "../lib/ids.js";

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
  addMissingColumns(db, "roots", { provider: "TEXT NOT NULL DEFAULT 'local'", config: "TEXT" });
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

export function row<T>(value: unknown): T | null {
  return (value as T | undefined) ?? null;
}

export function rows<T>(value: unknown[]): T[] {
  return value as T[];
}
