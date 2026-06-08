import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import AdmZip from "adm-zip";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { EventHub } from "../ws/events.js";
import type { AuditService } from "./audit.service.js";
import type { FsService } from "./fs.service.js";
import type { PathService } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { Actor, FileTask } from "./types.js";

const fileRefSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1)
});

export const taskInputSchema = z.object({
  type: z.enum([
    "copy",
    "move",
    "delete_to_trash",
    "restore_trash",
    "compress",
    "extract",
    "rsync_pull",
    "rsync_push",
    "thumbnail"
  ]),
  sources: z.array(fileRefSchema).default([]),
  destination: fileRefSchema.optional(),
  remote: z.string().min(1).optional(),
  options: z.object({
    archive: z.boolean().optional(),
    delete: z.boolean().optional(),
    dryRun: z.boolean().optional()
  }).optional()
});

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly events: EventHub,
    private readonly appDataDir: string,
    private readonly fsService: FsService
  ) {}

  create(actor: Actor, input: z.infer<typeof taskInputSchema>): FileTask {
    if (["copy", "move", "compress", "extract"].includes(input.type) && !input.destination) {
      throw new AppError(400, "Destination required", "DESTINATION_REQUIRED");
    }
    if (["copy", "move", "delete_to_trash", "compress", "extract", "thumbnail"].includes(input.type) && input.sources.length === 0) {
      throw new AppError(400, "Sources required", "SOURCES_REQUIRED");
    }
    if (input.type === "rsync_pull" && (!input.remote || !input.destination)) {
      throw new AppError(400, "Remote and destination are required", "RSYNC_INPUT_REQUIRED");
    }
    if (input.type === "rsync_push" && (!input.remote || input.sources.length === 0)) {
      throw new AppError(400, "Remote and sources are required", "RSYNC_INPUT_REQUIRED");
    }

    const sources = input.type === "rsync_pull" ? [{ rootSlug: "remote", path: input.remote! }] : input.sources;
    const destination =
      input.type === "rsync_push"
        ? JSON.stringify({ remote: input.remote, options: input.options ?? {} })
        : input.destination
          ? JSON.stringify({ ...input.destination, options: input.options ?? {} })
          : null;

    const ts = now();
    const task: FileTask = {
      id: id("task"),
      type: input.type,
      status: "queued",
      created_by: actor.id,
      sources_json: JSON.stringify(sources),
      destination,
      total_files: Math.max(sources.length, 1),
      processed_files: 0,
      total_bytes: 0,
      processed_bytes: 0,
      current_path: null,
      error_message: null,
      auth_snapshot_json: JSON.stringify({ actorId: actor.id, role: actor.role }),
      created_at: ts,
      updated_at: ts,
      started_at: null,
      finished_at: null
    };

    this.db
      .prepare(
        `INSERT INTO tasks
        (id, type, status, created_by, sources_json, destination, total_files, processed_files, total_bytes,
         processed_bytes, current_path, error_message, auth_snapshot_json, created_at, updated_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        task.id,
        task.type,
        task.status,
        task.created_by,
        task.sources_json,
        task.destination,
        task.total_files,
        task.processed_files,
        task.total_bytes,
        task.processed_bytes,
        task.current_path,
        task.error_message,
        task.auth_snapshot_json,
        task.created_at,
        task.updated_at,
        task.started_at,
        task.finished_at
      );
    this.audit.write({ actorType: "user", actorId: actor.id, action: "create_task", target: input, result: "success" });
    this.events.publish({ type: "task.created", task });
    return task;
  }

  list(actor: Actor): FileTask[] {
    if (actor.role === "ADMIN") {
      return rows<FileTask>(this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200").all());
    }
    return rows<FileTask>(
      this.db.prepare("SELECT * FROM tasks WHERE created_by = ? ORDER BY created_at DESC LIMIT 200").all(actor.id)
    );
  }

  listTrash(actor: Actor) {
    if (actor.role === "ADMIN") {
      return this.db.prepare("SELECT * FROM trash_items WHERE restored_at IS NULL ORDER BY deleted_at DESC").all();
    }
    return this.db
      .prepare("SELECT * FROM trash_items WHERE deleted_by = ? AND restored_at IS NULL ORDER BY deleted_at DESC")
      .all(actor.id);
  }

  get(taskId: string): FileTask {
    const task = row<FileTask>(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    if (!task) throw new AppError(404, "Task not found", "TASK_NOT_FOUND");
    return task;
  }

  getForActor(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    return task;
  }

  cancel(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    this.db
      .prepare("UPDATE tasks SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ? AND status = 'queued'")
      .run(now(), now(), taskId);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "task_cancel", target: { taskId }, result: "success" });
    return this.get(taskId);
  }

  retry(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    if (!["failed", "cancelled", "interrupted"].includes(task.status)) {
      throw new AppError(409, "Only failed, cancelled, or interrupted tasks can be retried", "TASK_RETRY_NOT_ALLOWED");
    }

    const retryTask = this.cloneTask(actor, task);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "task_retry",
      target: { taskId, retryTaskId: retryTask.id },
      result: "success"
    });
    return retryTask;
  }

  createRestoreTrash(actor: Actor, trashItemId: string): FileTask {
    return this.create(actor, {
      type: "restore_trash",
      sources: [{ rootSlug: "trash", path: trashItemId }]
    });
  }

  claimNext(): FileTask | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = row<FileTask>(
        this.db.prepare("SELECT * FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1").get()
      );
      if (!task) {
        this.db.exec("COMMIT");
        return null;
      }
      const ts = now();
      this.db
        .prepare("UPDATE tasks SET status = 'running', started_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'")
        .run(ts, ts, task.id);
      this.db.exec("COMMIT");
      return this.get(task.id);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async runTask(task: FileTask, actor: Actor): Promise<void> {
    try {
      if (task.type === "copy") await this.runCopyLike(task, actor, false);
      else if (task.type === "move") await this.runCopyLike(task, actor, true);
      else if (task.type === "delete_to_trash") await this.runTrash(task, actor);
      else if (task.type === "restore_trash") await this.runRestore(task, actor);
      else if (task.type === "compress") await this.runCompress(task, actor);
      else if (task.type === "extract") await this.runExtract(task, actor);
      else if (task.type === "rsync_pull") await this.runRsyncPull(task, actor);
      else if (task.type === "rsync_push") await this.runRsyncPush(task, actor);
      else if (task.type === "thumbnail") await this.runThumbnail(task, actor);
      this.finish(task.id, "done");
      this.events.publish({ type: "task.done", taskId: task.id });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Task failed";
      this.finish(task.id, "failed", message);
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "task_failed",
        target: { taskId: task.id, type: task.type },
        result: "failure"
      });
      this.events.publish({ type: "task.failed", taskId: task.id, error: message });
    }
  }

  private async runCopyLike(task: FileTask, actor: Actor, move: boolean): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string };
    const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
    this.permissions.require(actor, "upload", dest.root, dest.logicalPath);

    for (const source of sources) {
      const safeSource = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, move ? "move" : "read", safeSource.root, safeSource.logicalPath);
      const target = path.join(dest.absolutePath, path.basename(safeSource.absolutePath));
      await this.progress(task.id, safeSource.logicalPath);
      if (move) await fsp.rename(safeSource.absolutePath, target);
      else await fsp.cp(safeSource.absolutePath, target, { recursive: true, errorOnExist: false });
      if (move) {
        this.audit.write({
          actorType: "user",
          actorId: actor.id,
          action: "move",
          rootId: safeSource.root.id,
          path: safeSource.logicalPath,
          target: { rootSlug: destination.rootSlug, path: path.posix.join(destination.path, path.basename(safeSource.logicalPath)) },
          result: "success"
        });
      }
      await this.bumpProcessed(task.id);
    }
  }

  private async runTrash(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const trashDir = path.join(this.appDataDir, "trash");
    await fsp.mkdir(trashDir, { recursive: true });

    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "delete", safe.root, safe.logicalPath);
      const trashName = `${Date.now()}-${id("trash")}-${path.basename(safe.absolutePath)}`;
      const trashPath = path.join(trashDir, trashName);
      await this.progress(task.id, safe.logicalPath);
      await fsp.rename(safe.absolutePath, trashPath);
      this.db
        .prepare(
          `INSERT INTO trash_items
          (id, original_root_id, original_path, trash_path, deleted_by, deleted_at, restored_at)
          VALUES (?, ?, ?, ?, ?, ?, NULL)`
        )
        .run(id("trashitem"), safe.root.id, safe.logicalPath, trashPath, actor.id, now());
      await this.bumpProcessed(task.id);
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "delete_to_trash",
        rootId: safe.root.id,
        path: safe.logicalPath,
        result: "success"
      });
    }
  }

  private async runRestore(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    for (const source of sources) {
      const item = row<{ id: string; original_path: string; trash_path: string; original_root_id: string }>(
        this.db.prepare("SELECT * FROM trash_items WHERE id = ? AND restored_at IS NULL").get(source.path)
      );
      if (!item) throw new AppError(404, "Trash item not found", "TRASH_ITEM_NOT_FOUND");
      const safe = await this.paths.resolveRootById(item.original_root_id, path.posix.dirname(item.original_path));
      const target = path.join(safe.absolutePath, path.basename(item.original_path));
      await fsp.rename(item.trash_path, target);
      this.db.prepare("UPDATE trash_items SET restored_at = ? WHERE id = ?").run(now(), item.id);
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "restore_trash",
        rootId: item.original_root_id,
        path: item.original_path,
        result: "success"
      });
      await this.bumpProcessed(task.id);
    }
  }

  private async runCompress(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string };
    const dest = await this.paths.resolveForCreate(destination.rootSlug, destination.path);
    this.permissions.require(actor, "upload", dest.root, path.posix.dirname(dest.logicalPath));
    this.permissions.require(actor, "compress", dest.root, path.posix.dirname(dest.logicalPath));
    const zip = new AdmZip();
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "read", safe.root, safe.logicalPath);
      const stat = await fsp.stat(safe.absolutePath);
      if (stat.isDirectory()) zip.addLocalFolder(safe.absolutePath, path.basename(safe.absolutePath));
      else zip.addLocalFile(safe.absolutePath);
      await this.bumpProcessed(task.id);
    }
    zip.writeZip(dest.absolutePath);
  }

  private async runExtract(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string };
    const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
    this.permissions.require(actor, "upload", dest.root, dest.logicalPath);
    this.permissions.require(actor, "extract", dest.root, dest.logicalPath);
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "read", safe.root, safe.logicalPath);
      const zip = new AdmZip(safe.absolutePath);
      for (const entry of zip.getEntries()) {
        if (entry.entryName.startsWith("/") || entry.entryName.includes("..")) {
          throw new AppError(400, "Unsafe zip entry", "UNSAFE_ZIP_ENTRY");
        }
      }
      zip.extractAllTo(dest.absolutePath, false);
      await this.bumpProcessed(task.id);
    }
  }

  private async runRsyncPull(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const remote = sources[0]?.path;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string; options?: RsyncOptions };
    if (!remote) throw new AppError(400, "Remote is required", "RSYNC_REMOTE_REQUIRED");
    const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
    this.permissions.require(actor, "upload", dest.root, dest.logicalPath);
    this.permissions.require(actor, "run_rsync", dest.root, dest.logicalPath);
    await this.progress(task.id, remote);
    await runRsync([...rsyncFlags(destination.options), ensureTrailingSlash(remote), ensureTrailingSlash(dest.absolutePath)]);
    await this.bumpProcessed(task.id);
  }

  private async runRsyncPush(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { remote: string; options?: RsyncOptions };
    if (!destination.remote) throw new AppError(400, "Remote is required", "RSYNC_REMOTE_REQUIRED");
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "read", safe.root, safe.logicalPath);
      this.permissions.require(actor, "run_rsync", safe.root, safe.logicalPath);
      await this.progress(task.id, safe.logicalPath);
      await runRsync([...rsyncFlags(destination.options), safe.absolutePath, ensureTrailingSlash(destination.remote)]);
      await this.bumpProcessed(task.id);
    }
  }

  private async runThumbnail(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    for (const source of sources) {
      await this.progress(task.id, source.path);
      await this.fsService.warmThumbnail(actor, source.rootSlug, source.path);
      await this.bumpProcessed(task.id);
    }
  }

  private async progress(taskId: string, currentPath: string): Promise<void> {
    this.db.prepare("UPDATE tasks SET current_path = ?, updated_at = ? WHERE id = ?").run(currentPath, now(), taskId);
    this.events.publish({ type: "task.progress", taskId, patch: { current_path: currentPath } });
  }

  private async bumpProcessed(taskId: string): Promise<void> {
    this.db
      .prepare("UPDATE tasks SET processed_files = processed_files + 1, updated_at = ? WHERE id = ?")
      .run(now(), taskId);
    const task = this.get(taskId);
    this.events.publish({ type: "task.progress", taskId, patch: { processed_files: task.processed_files } });
  }

  private finish(taskId: string, status: "done" | "failed", error?: string): void {
    this.db
      .prepare("UPDATE tasks SET status = ?, error_message = ?, updated_at = ?, finished_at = ? WHERE id = ?")
      .run(status, error ?? null, now(), now(), taskId);
  }

  private requireTaskAccess(actor: Actor, task: FileTask): void {
    if (actor.role === "ADMIN" || task.created_by === actor.id) return;
    throw new AppError(403, "Task access denied", "TASK_ACCESS_DENIED");
  }

  private cloneTask(actor: Actor, task: FileTask): FileTask {
    const ts = now();
    const retryTask: FileTask = {
      ...task,
      id: id("task"),
      status: "queued",
      created_by: actor.id,
      processed_files: 0,
      processed_bytes: 0,
      current_path: null,
      error_message: null,
      auth_snapshot_json: JSON.stringify({ actorId: actor.id, role: actor.role, retriedFrom: task.id }),
      created_at: ts,
      updated_at: ts,
      started_at: null,
      finished_at: null
    };

    this.db
      .prepare(
        `INSERT INTO tasks
        (id, type, status, created_by, sources_json, destination, total_files, processed_files, total_bytes,
         processed_bytes, current_path, error_message, auth_snapshot_json, created_at, updated_at, started_at, finished_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        retryTask.id,
        retryTask.type,
        retryTask.status,
        retryTask.created_by,
        retryTask.sources_json,
        retryTask.destination,
        retryTask.total_files,
        retryTask.processed_files,
        retryTask.total_bytes,
        retryTask.processed_bytes,
        retryTask.current_path,
        retryTask.error_message,
        retryTask.auth_snapshot_json,
        retryTask.created_at,
        retryTask.updated_at,
        retryTask.started_at,
        retryTask.finished_at
      );
    this.events.publish({ type: "task.created", task: retryTask });
    return retryTask;
  }
}

type RsyncOptions = {
  archive?: boolean;
  delete?: boolean;
  dryRun?: boolean;
};

function rsyncFlags(options: RsyncOptions = {}): string[] {
  return [
    options.archive === false ? "-r" : "-a",
    ...(options.delete ? ["--delete"] : []),
    ...(options.dryRun ? ["--dry-run"] : [])
  ];
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function runRsync(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("rsync", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new AppError(500, stderr.trim() || `rsync exited with code ${code}`, "RSYNC_FAILED"));
    });
  });
}
