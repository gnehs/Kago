import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AppError } from "./errors.js";

const MAX_CONCURRENT_SQLITE_PREVIEWS = 2;
const SQLITE_PREVIEW_TIMEOUT_MS = 2500;
const MAX_WORKER_OLD_SPACE_MB = 64;
export const MAX_SQLITE_PAGE = 200;

export type SqliteCell = string | number | null | { blob: number };
export type SqliteTable = { name: string; type: "table" | "view"; columns: Array<{ name: string; type: string; pk: boolean; notNull: boolean }> };
export type SqliteOverview = { tables: SqliteTable[] };
export type SqlitePage = { columns: string[]; rows: SqliteCell[][]; offset: number; hasMore: boolean; total: number | null };

export type SqlitePreviewRequest =
  | { kind: "overview"; file: string }
  | { kind: "rows"; file: string; size: number; table: string; offset: number; limit: number };

export type SqlitePreviewResponse =
  | { ok: true; value: SqliteOverview | SqlitePage }
  | { ok: false; statusCode: number; message: string; code: string };

const workerJsPath = fileURLToPath(new URL("./sqlite-preview-worker.js", import.meta.url));
const workerPath = fs.existsSync(workerJsPath) ? workerJsPath : workerJsPath.replace(/\.js$/, ".ts");
const workers = new Set<ChildProcess>();

// A child may still be evaluating a synchronous SQLite query when the server is shutting down.
process.once("exit", () => {
  for (const worker of workers) worker.kill("SIGKILL");
});

/** The tables and views of a database file. */
export function sqliteOverview(file: string): Promise<SqliteOverview> {
  return runInChild({ kind: "overview", file });
}

/** One page of a table or view. A view has no total because even counting its rows may run arbitrary work. */
export function sqliteRows(file: string, size: number, table: string, offset: number, limit: number): Promise<SqlitePage> {
  return runInChild({ kind: "rows", file, size, table, offset, limit });
}

function runInChild<T>(request: SqlitePreviewRequest): Promise<T> {
  if (workers.size >= MAX_CONCURRENT_SQLITE_PREVIEWS) {
    return Promise.reject(new AppError(503, "SQLite preview is busy; try again later", "SQLITE_PREVIEW_BUSY"));
  }

  let child: ChildProcess;
  try {
    child = fork(workerPath, [], {
      execArgv: workerExecArgv(),
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });
  } catch {
    return Promise.reject(new AppError(422, "The database could not be read", "SQLITE_UNREADABLE"));
  }

  workers.add(child);
  return new Promise<T>((resolve, reject) => {
    let response: SqlitePreviewResponse | undefined;
    let startError: Error | undefined;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, SQLITE_PREVIEW_TIMEOUT_MS);

    child.on("message", (message: SqlitePreviewResponse) => {
      if (message && typeof message === "object" && "ok" in message) response = message;
    });
    child.once("error", (error) => {
      startError = error;
      child.kill("SIGKILL");
    });
    child.once("close", () => {
      clearTimeout(timeout);
      workers.delete(child);
      if (timedOut) {
        reject(new AppError(504, "SQLite preview timed out", "SQLITE_PREVIEW_TIMEOUT"));
      } else if (response?.ok) {
        resolve(response.value as T);
      } else if (response && !response.ok) {
        reject(new AppError(response.statusCode, response.message, response.code));
      } else {
        reject(startError ?? new AppError(422, "The database could not be read", "SQLITE_UNREADABLE"));
      }
    });

    child.send(request, (error) => {
      if (!error) return;
      startError = error;
      child.kill("SIGKILL");
    });
  });
}

/** Keep the source TypeScript loader in development, while dropping parent-only flags such as --eval and --test. */
function workerExecArgv(): string[] {
  const args: string[] = [];
  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index]!;
    if (arg === "--require" || arg === "-r" || arg === "--import") {
      const value = process.execArgv[index + 1];
      if (value !== undefined) args.push(arg, value);
      index += 1;
    } else if (arg.startsWith("--require=") || arg.startsWith("--import=")) {
      args.push(arg);
    }
  }
  args.push(`--max-old-space-size=${MAX_WORKER_OLD_SPACE_MB}`);
  return args;
}
