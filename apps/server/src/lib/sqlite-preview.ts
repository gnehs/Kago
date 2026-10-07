import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { AppError } from "./errors.js";

const HEADER = "SQLite format 3\0";
/** Counting rows walks the whole table on the server's only thread, so the largest databases go without a total. */
const MAX_COUNTED_BYTES = 256 * 1024 * 1024;
const MAX_CELL_CHARS = 2000;
export const MAX_SQLITE_PAGE = 200;

export type SqliteCell = string | number | null | { blob: number };
export type SqliteTable = { name: string; type: "table" | "view"; columns: Array<{ name: string; type: string; pk: boolean; notNull: boolean }> };

/** The tables and views of a database file, with their columns. */
export function sqliteOverview(file: string): { tables: SqliteTable[] } {
  return withDatabase(file, (db) => ({ tables: listTables(db).map((table) => ({ ...table, columns: columnsOf(db, table.name) })) }));
}

/** One page of a table in rowid order. `total` is null when the file is too large to count cheaply. */
export function sqliteRows(file: string, size: number, table: string, offset: number, limit: number) {
  return withDatabase(file, (db) => {
    // The name is checked against the schema before it goes into a statement; identifiers cannot be bound.
    if (!listTables(db).some((entry) => entry.name === table)) throw new AppError(404, "Table not found", "SQLITE_TABLE_NOT_FOUND");
    const statement = db.prepare(`SELECT * FROM ${quote(table)} LIMIT ? OFFSET ?`);
    statement.setReadBigInts(true);
    // Arrays keep every column of a view that names two of them alike.
    statement.setReturnArrays(true);
    const page = statement.all(limit + 1, offset) as unknown as unknown[][];
    const total = size <= MAX_COUNTED_BYTES ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n) : null;
    return {
      columns: statement.columns().map((column) => column.name),
      rows: page.slice(0, limit).map((row) => row.map(cell)),
      offset,
      hasMore: page.length > limit,
      total
    };
  });
}

function withDatabase<T>(file: string, read: (db: DatabaseSync) => T): T {
  const header = Buffer.alloc(HEADER.length);
  const handle = fs.openSync(file, "r");
  try {
    fs.readSync(handle, header, 0, header.length, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (header.toString("latin1") !== HEADER) throw new AppError(422, "Not a SQLite database", "NOT_SQLITE");

  let db: DatabaseSync | undefined;
  try {
    // A database at rest is opened immutable so that looking at it leaves no -shm or journal beside the user's file.
    // One with a write-ahead log is in use, and its latest rows are only visible through the log.
    db = fs.existsSync(`${file}-wal`) ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    // The file is the user's, not ours: its views and triggers must not reach functions with side effects.
    db.exec("PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;");
    return read(db);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(422, "The database could not be read", "SQLITE_UNREADABLE");
  } finally {
    db?.close();
  }
}

function listTables(db: DatabaseSync) {
  return db.prepare("SELECT name, type FROM sqlite_schema WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name").all() as Array<{ name: string; type: "table" | "view" }>;
}

function columnsOf(db: DatabaseSync, table: string): SqliteTable["columns"] {
  try {
    const columns = db.prepare('SELECT name, type, "notnull", pk FROM pragma_table_info(?)').all(table) as Array<{ name: string; type: string; notnull: number; pk: number }>;
    return columns.map((column) => ({ name: column.name, type: column.type, pk: column.pk > 0, notNull: column.notnull > 0 }));
  } catch {
    // A virtual table whose module this build lacks still gets listed.
    return [];
  }
}

function cell(value: unknown): SqliteCell {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (typeof value === "number") return value;
  if (value instanceof Uint8Array) return { blob: value.byteLength };
  const text = String(value);
  return text.length > MAX_CELL_CHARS ? `${text.slice(0, MAX_CELL_CHARS)}…` : text;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;
