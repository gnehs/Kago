import { parentPort, workerData } from "node:worker_threads";
import type { Env } from "../config/env.js";
import { openDb } from "../db/db.js";
import { logger } from "../lib/logger.js";
import { SecretBox } from "../lib/secret-box.js";
import { RcloneClient, rcloneSocketPath } from "../storage/rclone-client.js";
import { RemoteStorage } from "../storage/remote-storage.js";
import { StorageService } from "../services/storage.service.js";
import { AuditService } from "../services/audit.service.js";
import { AuthService } from "../services/auth.service.js";
import { FsService } from "../services/fs.service.js";
import { PathService } from "../services/path.service.js";
import { PermissionService } from "../services/permission.service.js";
import { PreferenceService } from "../services/preference.service.js";
import { RootService } from "../services/root.service.js";
import { TaskService } from "../services/task.service.js";
import type { FileTask } from "../services/types.js";
import type { EventPublisher, ServerEvent } from "../ws/events.js";

type WorkerInput = {
  env: Env;
};

type WorkerToMainMessage =
  | { type: "ready" }
  | { type: "event"; event: ServerEvent }
  | { type: "current"; taskId: string | null }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; data?: unknown };

const input = workerData as WorkerInput;
const port = parentPort;

if (!port) {
  throw new Error("task-worker must run inside a worker thread");
}
const workerPort = port;

const parentEvents: EventPublisher = {
  publish(event) {
    post({ type: "event", event });
  }
};

const db = openDb(input.env, { interruptRunningTasks: false });
const audit = new AuditService(db);
const roots = new RootService(db, input.env.dataDir, new SecretBox(input.env.appDataDir));
// The daemon belongs to the main thread; the worker only talks to it.
const remote = new RemoteStorage(new RcloneClient(rcloneSocketPath(input.env.appDataDir)), roots, input.env);
const storage = new StorageService(remote);
const paths = new PathService(roots, remote);
const permissions = new PermissionService(db, audit);
const auth = new AuthService(db, input.env);
const preferences = new PreferenceService(db, roots, paths, parentEvents);
const fsService = new FsService(paths, permissions, audit, storage, input.env.appDataDir, preferences);
const tasks = new TaskService(db, paths, permissions, audit, parentEvents, input.env.appDataDir, fsService, storage, preferences);

let stopped = false;
let running = false;
let timer: NodeJS.Timeout | null = null;
let failureCount = 0;

port.on("message", (message: { type?: string }) => {
  if (message.type !== "stop") return;
  stopped = true;
  if (timer) clearTimeout(timer);
  db.close();
  process.exit(0);
});

post({ type: "ready" });
schedule(0);
void tasks.cleanupExpiredDownloads().catch(() => undefined);
setInterval(() => void tasks.cleanupExpiredDownloads().catch(() => undefined), 60 * 60 * 1000).unref();

function schedule(delayMs: number): void {
  if (stopped) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), delayMs);
}

async function tick(): Promise<void> {
  if (running || stopped) return;
  running = true;
  let task: FileTask | null = null;
  try {
    task = tasks.claimNext();
    if (!task) {
      failureCount = 0;
      schedule(1000);
      return;
    }

    post({ type: "current", taskId: task.id });
    const user = auth.getUser(task.created_by);
    await tasks.runTask(task, {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      disabled: Boolean(user.disabled)
    });
    post({ type: "current", taskId: null });
    failureCount = 0;
    schedule(0);
  } catch (error) {
    if (task) {
      tasks.failRunning(task.id);
      post({ type: "current", taskId: null });
    }
    failureCount += 1;
    const delayMs = Math.min(30_000, 1000 * 2 ** failureCount);
    post({ type: "log", level: "error", message: "task worker tick failed", data: serializeError(error) });
    schedule(delayMs);
  } finally {
    running = false;
  }
}

function post(message: WorkerToMainMessage): void {
  workerPort.postMessage(message);
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return { value: String(error) };
}

process.on("uncaughtException", (error) => {
  logger.error("task worker uncaught exception", error);
  post({ type: "log", level: "error", message: "task worker uncaught exception", data: serializeError(error) });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("task worker unhandled rejection", reason);
  post({ type: "log", level: "error", message: "task worker unhandled rejection", data: serializeError(reason) });
  process.exit(1);
});
