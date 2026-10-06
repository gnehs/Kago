import { Worker } from "node:worker_threads";
import type { Env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import type { TaskService } from "../services/task.service.js";
import type { EventHub, ServerEvent } from "../ws/events.js";

type WorkerToMainMessage =
  | { type: "ready" }
  | { type: "event"; event: ServerEvent }
  | { type: "current"; taskId: string | null }
  | { type: "log"; level: "info" | "warn" | "error"; message: string; data?: unknown };

export class WorkerManager {
  private worker: Worker | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private currentTaskId: string | null = null;
  private failureCount = 0;

  constructor(
    private readonly tasks: TaskService,
    private readonly env: Env,
    private readonly events: EventHub
  ) {}

  start(): void {
    if (this.worker || this.restartTimer) return;
    this.stopping = false;
    this.spawnWorker();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    const worker = this.worker;
    this.worker = null;
    this.currentTaskId = null;
    if (!worker) return;
    worker.postMessage({ type: "stop" });
    await worker.terminate();
  }

  private spawnWorker(): void {
    this.restartTimer = null;
    const worker = new Worker(workerEntryUrl(), {
      name: "kago-task-worker",
      workerData: { env: this.env }
    });
    this.worker = worker;
    this.currentTaskId = null;

    worker.on("message", (message: WorkerToMainMessage) => this.handleWorkerMessage(message));
    worker.once("error", (error) => {
      logger.error("task worker failed", error);
    });
    worker.once("exit", (code) => {
      if (this.worker === worker) this.worker = null;
      const taskId = this.currentTaskId;
      this.currentTaskId = null;
      if (this.stopping) return;
      if (taskId) this.tasks.failRunning(taskId, "Worker exited before completing task");
      const delayMs = this.nextBackoffDelay();
      logger.warn("task worker exited; scheduling restart", { code, delayMs });
      this.restartTimer = setTimeout(() => this.spawnWorker(), delayMs);
    });
  }

  private handleWorkerMessage(message: WorkerToMainMessage): void {
    if (message.type === "ready") {
      logger.info("task worker ready");
      return;
    }
    if (message.type === "event") {
      this.events.publish(message.event);
      return;
    }
    if (message.type === "current") {
      this.currentTaskId = message.taskId;
      if (!message.taskId) this.failureCount = 0;
      return;
    }
    logger[message.level](message.message, message.data);
  }

  private nextBackoffDelay(): number {
    this.failureCount += 1;
    return Math.min(30_000, 1000 * 2 ** this.failureCount);
  }
}

function workerEntryUrl(): URL {
  if (import.meta.url.endsWith(".ts")) return new URL("./task-worker.ts", import.meta.url);
  return new URL("./task-worker.js", import.meta.url);
}
