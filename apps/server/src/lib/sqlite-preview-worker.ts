import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { AppError } from "./errors.js";
import type { SqliteCell, SqliteOverview, SqlitePage, SqlitePreviewRequest, SqlitePreviewResponse, SqliteTable } from "./sqlite-preview.js";

const HEADER = "SQLite format 3\0";
const MAX_COUNTED_BYTES = 256 * 1024 * 1024;
const MAX_CELL_CHARS = 2000;
const SQLITE_HEAP_LIMIT_BYTES = 64 * 1024 * 1024;
const MAX_SQLITE_VALUE_BYTES = 8 * 1024 * 1024;
const MAX_PAGE_RESPONSE_BYTES = 8 * 1024 * 1024;
const TEXT_MARKER = "@kago-text:";
const INTEGER_MARKER = "@kago-integer:";
const BLOB_MARKER = "@kago-blob:";

function handle(request: SqlitePreviewRequest): SqlitePreviewResponse {
  try {
    const value = request.kind === "overview"
      ? sqliteOverview(request.file)
      : sqliteRows(request.file, request.size, request.table, request.offset, request.limit);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof AppError) {
      return { ok: false, statusCode: error.statusCode, message: error.message, code: error.code };
    }
    return { ok: false, statusCode: 422, message: "The database could not be read", code: "SQLITE_UNREADABLE" };
  }
}

function sqliteOverview(file: string): SqliteOverview {
  return withDatabase(file, (db) => ({
    tables: listTables(db).map((table) => ({ ...table, columns: columnsOf(db, table.name) }))
  }));
}

function sqliteRows(file: string, size: number, table: string, offset: number, limit: number): SqlitePage {
  return withDatabase(file, (db) => {
    const entry = listTables(db).find((candidate) => candidate.name === table);
    if (!entry) throw new AppError(404, "Table not found", "SQLITE_TABLE_NOT_FOUND");

    const shape = db.prepare(`SELECT * FROM ${quote(table)} LIMIT ? OFFSET ?`);
    const columns = shape.columns().map((column) => column.name);
    // Clip text and reduce blobs before Node copies values. SQLite exposes duplicate view columns with stable :1 suffixes.
    const projection = columns.map((name, index) => projectedColumn(name, index)).join(", ");
    const statement = db.prepare(`SELECT ${projection} FROM ${quote(table)} AS ${quote("source")} LIMIT ? OFFSET ?`);
    statement.setReadBigInts(true);
    // Arrays preserve source order, including duplicate names in a view.
    statement.setReturnArrays(true);
    const rows: SqliteCell[][] = [];
    let responseBytes = Buffer.byteLength(JSON.stringify(columns), "utf8") + 128;
    if (responseBytes > MAX_PAGE_RESPONSE_BYTES) {
      throw new AppError(413, "SQLite preview page is too large", "SQLITE_PREVIEW_TOO_LARGE");
    }
    let hasMore = false;
    for (const row of statement.iterate(limit + 1, offset) as IterableIterator<unknown[]>) {
      if (rows.length >= limit) {
        hasMore = true;
        break;
      }
      const converted = row.map(decodeProjectedCell);
      responseBytes += converted.reduce<number>((bytes, value) => bytes + estimatedJsonBytes(value), 0) + converted.length + 2;
      if (responseBytes > MAX_PAGE_RESPONSE_BYTES) {
        throw new AppError(413, "SQLite preview page is too large", "SQLITE_PREVIEW_TOO_LARGE");
      }
      rows.push(converted);
    }
    // A view can run arbitrary built-in SQL even when it returns only a few rows. Avoid a second, full scan for its total.
    const total = entry.type === "table" && size <= MAX_COUNTED_BYTES
      ? Number((db.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get() as { n: number }).n)
      : null;
    return {
      columns,
      rows,
      offset,
      hasMore,
      total
    };
  });
}

function projectedColumn(name: string, index: number): string {
  const column = `${quote("source")}.${quote(name)}`;
  return `CASE typeof(${column})
    WHEN 'blob' THEN '${BLOB_MARKER}' || length(${column})
    WHEN 'text' THEN '${TEXT_MARKER}' || substr(${column}, 1, ${MAX_CELL_CHARS + 1})
    WHEN 'integer' THEN '${INTEGER_MARKER}' || CAST(${column} AS TEXT)
    ELSE ${column}
  END AS ${quote(`__kago_cell_${index}`)}`;
}

function decodeProjectedCell(value: unknown): SqliteCell {
  if (typeof value === "string") {
    if (value.startsWith(BLOB_MARKER)) return { blob: Number(value.slice(BLOB_MARKER.length)) };
    if (value.startsWith(TEXT_MARKER)) return cell(value.slice(TEXT_MARKER.length));
    if (value.startsWith(INTEGER_MARKER)) return cell(BigInt(value.slice(INTEGER_MARKER.length)));
  }
  return cell(value);
}

function estimatedJsonBytes(value: SqliteCell): number {
  if (typeof value === "string") return value.length * 6 + 3;
  if (typeof value === "number") return 32;
  if (value === null) return 5;
  return 32;
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
    // A database at rest is immutable. A database with a WAL is opened normally so its latest rows remain visible.
    db = fs.existsSync(`${file}-wal`) ? new DatabaseSync(file, { readOnly: true }) : new DatabaseSync(`${pathToFileURL(file).href}?immutable=1`, { readOnly: true });
    // Keep parsing and query work inside this disposable process, and bound SQLite-owned and V8 old-generation memory.
    db.prepare(`PRAGMA hard_heap_limit = ${SQLITE_HEAP_LIMIT_BYTES}`).get();
    const limits = (db as DatabaseSync & { limits?: { length: number } }).limits;
    if (limits) limits.length = MAX_SQLITE_VALUE_BYTES;
    db.exec("PRAGMA mmap_size = 0; PRAGMA temp_store = MEMORY; PRAGMA trusted_schema = OFF; PRAGMA query_only = ON;");
    return read(db);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Error && error.message === "string or blob too big") {
      throw new AppError(413, "SQLite preview page is too large", "SQLITE_PREVIEW_TOO_LARGE");
    }
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

if (process.send) {
  process.once("message", (request: SqlitePreviewRequest) => {
    process.send!(handle(request), () => process.disconnect());
  });
}
