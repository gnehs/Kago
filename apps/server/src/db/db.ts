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
  if (options.interruptRunningTasks ?? true) {
    db.prepare(
      "UPDATE tasks SET status = 'interrupted', updated_at = ?, finished_at = ? WHERE status = 'running'"
    ).run(now(), now());
  }

  return db;
}

export function row<T>(value: unknown): T | null {
  return (value as T | undefined) ?? null;
}

export function rows<T>(value: unknown[]): T[] {
  return value as T[];
}
