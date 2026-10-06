import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import AdmZip from "adm-zip";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { assertNameAvailable, nfc } from "../lib/filename.js";
import { id, now } from "../lib/ids.js";
import type { EventPublisher } from "../ws/events.js";
import type { AuditService } from "./audit.service.js";
import type { FsService } from "./fs.service.js";
import type { PathService } from "./path.service.js";
import type { Action, PermissionService } from "./permission.service.js";
import type { Actor, FileTask } from "./types.js";

const maxExtractEntries = 10_000;
const maxExtractBytes = 1024 * 1024 * 1024 * 2;
const progressFlushIntervalMs = 500;
const progressFlushBytes = 1024 * 1024 * 16;
const cancelCheckIntervalMs = 300;
const downloadMaxAgeMs = 24 * 60 * 60 * 1000;
const symlinkFileType = 0o120000;
const unixFileTypeMask = 0o170000;

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
    "download_zip",
    "extract",
    "rsync_pull",
    "rsync_push",
    "thumbnail"
  ]),
  sources: z.array(fileRefSchema).default([]),
  destination: fileRefSchema.optional(),
  remote: z.string().min(1).max(1024).refine(isSafeRsyncRemote, "Invalid rsync remote").optional(),
  options: z.object({
    archive: z.boolean().optional(),
    delete: z.boolean().optional(),
    dryRun: z.boolean().optional()
  }).optional()
});

/** Thrown inside a running task once its row is no longer `running`. */
class TaskCancelledError extends Error {}

export class TaskService {
  private readonly progressBuffers = new Map<string, ProgressBuffer>();
  private readonly cancelChecks = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly appDataDir: string,
    private readonly fsService: FsService
  ) {}

  async create(actor: Actor, input: z.infer<typeof taskInputSchema>): Promise<FileTask> {
    if (["copy", "move", "compress", "extract"].includes(input.type) && !input.destination) {
      throw new AppError(400, "Destination required", "DESTINATION_REQUIRED");
    }
    if (["copy", "move", "delete_to_trash", "restore_trash", "compress", "download_zip", "extract", "thumbnail"].includes(input.type) && input.sources.length === 0) {
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
        : input.type === "download_zip"
          ? JSON.stringify({ fileName: downloadFileName(sources) })
          : input.destination
            ? JSON.stringify({ ...input.destination, options: input.options ?? {} })
            : null;

    await this.assertTaskPermissions(actor, input);

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
    this.events.publish({ type: "task.created", userId: task.created_by, task });
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
    const publicColumns = "id, original_root_id, original_path, deleted_by, deleted_at, restored_at";
    if (actor.role === "ADMIN") {
      return this.db.prepare(`SELECT ${publicColumns} FROM trash_items WHERE restored_at IS NULL ORDER BY deleted_at DESC`).all();
    }
    return this.db
      .prepare(`SELECT ${publicColumns} FROM trash_items WHERE deleted_by = ? AND restored_at IS NULL ORDER BY deleted_at DESC`)
      .all(actor.id);
  }

  /** Permanently deletes everything the actor can see in the trash. */
  async emptyTrash(actor: Actor): Promise<{ deleted: number }> {
    const trashDir = path.resolve(this.appDataDir, "trash");
    const items = rows<RestorableTrashItem>(
      actor.role === "ADMIN"
        ? this.db.prepare("SELECT * FROM trash_items WHERE restored_at IS NULL").all()
        : this.db.prepare("SELECT * FROM trash_items WHERE deleted_by = ? AND restored_at IS NULL").all(actor.id)
    );
    for (const item of items) {
      // Trashed entries always sit directly inside the trash dir; never remove anything else.
      if (path.dirname(path.resolve(item.trash_path)) === trashDir) {
        await fsp.rm(item.trash_path, { recursive: true, force: true });
      }
      this.db.prepare("DELETE FROM trash_items WHERE id = ?").run(item.id);
    }
    this.audit.write({ actorType: "user", actorId: actor.id, action: "trash_empty", target: { count: items.length }, result: "success" });
    return { deleted: items.length };
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
    if (task.status === "cancelled") return task;
    if (!["queued", "paused", "running"].includes(task.status)) {
      throw new AppError(409, "Only queued, paused, or running tasks can be cancelled", "TASK_CANCEL_NOT_ALLOWED");
    }
    // A running task belongs to the worker; it sees this status change at its next checkpoint and stops.
    this.db
      .prepare("UPDATE tasks SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ? AND status IN ('queued', 'paused', 'running')")
      .run(now(), now(), taskId);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "task_cancel", target: { taskId }, result: "success" });
    const cancelled = this.get(taskId);
    this.events.publish({ type: "task.progress", userId: cancelled.created_by, taskId, patch: { status: cancelled.status, finished_at: cancelled.finished_at } });
    return cancelled;
  }

  pause(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    if (task.status === "paused") return task;
    if (task.status !== "queued") {
      throw new AppError(409, "Only queued tasks can be paused", "TASK_PAUSE_NOT_ALLOWED");
    }
    this.db
      .prepare("UPDATE tasks SET status = 'paused', updated_at = ? WHERE id = ? AND status = 'queued'")
      .run(now(), taskId);
    const paused = this.get(taskId);
    if (paused.status !== "paused") throw new AppError(409, "Task can no longer be paused", "TASK_PAUSE_NOT_ALLOWED");
    this.audit.write({ actorType: "user", actorId: actor.id, action: "task_pause", target: { taskId }, result: "success" });
    this.events.publish({ type: "task.progress", userId: paused.created_by, taskId, patch: { status: paused.status } });
    return paused;
  }

  resume(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    if (task.status === "queued") return task;
    if (task.status !== "paused") {
      throw new AppError(409, "Only paused tasks can be resumed", "TASK_RESUME_NOT_ALLOWED");
    }
    this.db
      .prepare("UPDATE tasks SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'paused'")
      .run(now(), taskId);
    const resumed = this.get(taskId);
    if (resumed.status !== "queued") throw new AppError(409, "Task can no longer be resumed", "TASK_RESUME_NOT_ALLOWED");
    this.audit.write({ actorType: "user", actorId: actor.id, action: "task_resume", target: { taskId }, result: "success" });
    this.events.publish({ type: "task.progress", userId: resumed.created_by, taskId, patch: { status: resumed.status } });
    return resumed;
  }

  async retry(actor: Actor, taskId: string): Promise<FileTask> {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    if (!["failed", "cancelled", "interrupted"].includes(task.status)) {
      throw new AppError(409, "Only failed, cancelled, or interrupted tasks can be retried", "TASK_RETRY_NOT_ALLOWED");
    }

    const input = this.taskInputFromTask(task);
    await this.assertTaskPermissions(actor, input);
    const retryTask = this.cloneTask(actor, task);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "create_task", target: input, result: "success" });
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "task_retry",
      target: { taskId, retryTaskId: retryTask.id },
      result: "success"
    });
    return retryTask;
  }

  failRunning(taskId: string, errorMessage = "Worker failed before executing task"): void {
    const task = this.get(taskId);
    if (task.status !== "running") return;
    this.finish(taskId, "failed", errorMessage);
    this.audit.write({
      actorType: "system",
      action: "task_failed",
      target: { taskId, type: task.type },
      result: "failure"
    });
    this.events.publish({ type: "task.failed", userId: task.created_by, taskId, error: errorMessage });
  }

  async createRestoreTrash(actor: Actor, trashItemId: string): Promise<FileTask> {
    this.getRestorableTrashItem(actor, trashItemId);
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
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "task_start",
        target: { taskId: task.id, type: task.type },
        result: "success"
      });
      if (task.type === "copy") await this.runCopyLike(task, actor, false);
      else if (task.type === "move") await this.runCopyLike(task, actor, true);
      else if (task.type === "delete_to_trash") await this.runTrash(task, actor);
      else if (task.type === "restore_trash") await this.runRestore(task, actor);
      else if (task.type === "compress") await this.runCompress(task, actor);
      else if (task.type === "download_zip") await this.runDownloadZip(task, actor);
      else if (task.type === "extract") await this.runExtract(task, actor);
      else if (task.type === "rsync_pull") await this.runRsyncPull(task, actor);
      else if (task.type === "rsync_push") await this.runRsyncPush(task, actor);
      else if (task.type === "thumbnail") await this.runThumbnail(task, actor);
      if (this.finish(task.id, "done")) this.events.publish({ type: "task.done", userId: task.created_by, taskId: task.id });
    } catch (error) {
      if (error instanceof TaskCancelledError) {
        this.flushProgress(task.id, true);
        return;
      }
      const message = taskFailureMessage(error);
      if (!this.finish(task.id, "failed", message)) return;
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "task_failed",
        target: { taskId: task.id, type: task.type },
        result: "failure"
      });
      this.events.publish({ type: "task.failed", userId: task.created_by, taskId: task.id, error: message });
    } finally {
      this.cancelChecks.delete(task.id);
    }
  }

  private async runCopyLike(task: FileTask, actor: Actor, move: boolean): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string };
    const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
    this.permissions.require(actor, "upload", dest.root, dest.logicalPath);

    const operations = [];
    const targetPaths = new Set<string>();
    let totalBytes = 0;
    for (const source of sources) {
      const safeSource = await this.paths.resolveExisting(source.rootSlug, source.path);
      if (move) this.requireAny(actor, ["move", "delete"], safeSource.root, safeSource.logicalPath);
      else this.permissions.require(actor, "read", safeSource.root, safeSource.logicalPath);
      await assertNoSymlinksDeep(safeSource.absolutePath);
      const stats = await collectPathStats(safeSource.absolutePath);
      totalBytes += stats.bytes;
      const target = path.join(dest.absolutePath, path.basename(safeSource.absolutePath));
      await assertTargetOutsideSource(safeSource.absolutePath, target);
      // Existing names are carried over as they are, so sources that only differ in normalisation still collide.
      if (targetPaths.has(nfc(target))) throw new AppError(409, "Multiple sources resolve to the same target", "TARGET_COLLISION");
      targetPaths.add(nfc(target));
      await assertNameAvailable(dest.absolutePath, path.basename(target));
      operations.push({ safeSource, target, bytes: stats.bytes });
    }
    await this.updateTotals(task.id, operations.length, totalBytes);

    for (const { safeSource, target, bytes } of operations) {
      await this.progress(task.id, safeSource.logicalPath);
      let shouldCountBytesAfterOperation = false;
      if (move) {
        const streamed = await movePath(safeSource.absolutePath, target, (processedBytes) => this.bumpProcessedBytes(task.id, processedBytes));
        shouldCountBytesAfterOperation = !streamed;
      } else {
        await copyTree(safeSource.absolutePath, target, (processedBytes) => this.bumpProcessedBytes(task.id, processedBytes));
      }
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
      } else {
        this.audit.write({
          actorType: "user",
          actorId: actor.id,
          action: "copy",
          rootId: safeSource.root.id,
          path: safeSource.logicalPath,
          target: { rootSlug: destination.rootSlug, path: path.posix.join(destination.path, path.basename(safeSource.logicalPath)) },
          result: "success"
        });
      }
      if (shouldCountBytesAfterOperation) this.bumpProcessedBytes(task.id, bytes);
      await this.bumpProcessed(task.id);
    }
  }

  private async runTrash(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const trashDir = path.join(this.appDataDir, "trash");
    await fsp.mkdir(trashDir, { recursive: true });

    const operations = [];
    let totalBytes = 0;
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "delete", safe.root, safe.logicalPath);
      await assertNoSymlinksDeep(safe.absolutePath);
      const stats = await collectPathStats(safe.absolutePath);
      totalBytes += stats.bytes;
      const trashName = `${Date.now()}-${id("trash")}-${path.basename(safe.absolutePath)}`;
      const trashPath = path.join(trashDir, trashName);
      operations.push({ safe, trashPath, bytes: stats.bytes });
    }
    await this.updateTotals(task.id, operations.length, totalBytes);

    for (const { safe, trashPath, bytes } of operations) {
      await this.progress(task.id, safe.logicalPath);
      const streamed = await movePath(safe.absolutePath, trashPath, (processedBytes) => this.bumpProcessedBytes(task.id, processedBytes));
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
      if (!streamed) this.bumpProcessedBytes(task.id, bytes);
    }
  }

  private async runRestore(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const trashDir = path.join(this.appDataDir, "trash");
    let totalBytes = 0;
    for (const source of sources) {
      const item = this.getRestorableTrashItem(actor, source.path);
      await assertRealPathInside(trashDir, item.trash_path);
      totalBytes += (await collectPathStats(item.trash_path)).bytes;
    }
    await this.updateTotals(task.id, sources.length, totalBytes);

    for (const source of sources) {
      const item = this.getRestorableTrashItem(actor, source.path);
      const safe = await this.paths.resolveRootById(item.original_root_id, path.posix.dirname(item.original_path));
      this.permissions.require(actor, "upload", safe.root, safe.logicalPath);
      const target = path.join(safe.absolutePath, path.basename(item.original_path));
      await assertRealPathInside(trashDir, item.trash_path);
      await assertNameAvailable(safe.absolutePath, path.basename(target));
      const stats = await collectPathStats(item.trash_path);
      const streamed = await movePath(item.trash_path, target, (processedBytes) => this.bumpProcessedBytes(task.id, processedBytes));
      this.db.prepare("UPDATE trash_items SET restored_at = ? WHERE id = ?").run(now(), item.id);
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "restore_trash",
        rootId: item.original_root_id,
        path: item.original_path,
        result: "success"
      });
      if (!streamed) this.bumpProcessedBytes(task.id, stats.bytes);
      await this.bumpProcessed(task.id);
    }
  }

  private getRestorableTrashItem(actor: Actor, trashItemId: string): RestorableTrashItem {
    const item = row<RestorableTrashItem>(
      this.db.prepare("SELECT * FROM trash_items WHERE id = ? AND restored_at IS NULL").get(trashItemId)
    );
    if (!item) throw new AppError(404, "Trash item not found", "TRASH_ITEM_NOT_FOUND");
    if (actor.role !== "ADMIN" && item.deleted_by !== actor.id) {
      throw new AppError(404, "Trash item not found", "TRASH_ITEM_NOT_FOUND");
    }
    return item;
  }

  private async runCompress(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string };
    const dest = await this.paths.resolveForCreate(destination.rootSlug, destination.path);
    this.permissions.require(actor, "upload", dest.root, path.posix.dirname(dest.logicalPath));
    this.permissions.require(actor, "compress", dest.root, path.posix.dirname(dest.logicalPath));
    await assertNameAvailable(path.dirname(dest.absolutePath), path.basename(dest.absolutePath));
    const zipped = await this.zipSources(task, actor, "read", dest.absolutePath);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "compress",
      rootId: dest.root.id,
      path: dest.logicalPath,
      target: { taskId: task.id, sources: zipped },
      result: "success"
    });
  }

  /** Zips a selection into Kago's own temp dir so a multi-file download leaves nothing behind in the user's folders. */
  private async runDownloadZip(task: FileTask, actor: Actor): Promise<void> {
    const target = this.downloadPath(task.id);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const zipped = await this.zipSources(task, actor, "download", target);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "download_zip",
      target: { taskId: task.id, sources: zipped },
      result: "success"
    });
  }

  private async zipSources(task: FileTask, actor: Actor, sourceAction: Action, targetPath: string): Promise<Array<{ rootSlug: string; path: string }>> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const zip = new AdmZip();
    const operations = [];
    let totalBytes = 0;
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, sourceAction, safe.root, safe.logicalPath);
      await assertNoSymlinksDeep(safe.absolutePath);
      const stats = await collectPathStats(safe.absolutePath);
      totalBytes += stats.bytes;
      operations.push({ safe, bytes: stats.bytes });
    }
    await this.updateTotals(task.id, operations.length, totalBytes);

    for (const { safe, bytes } of operations) {
      await this.progress(task.id, safe.logicalPath);
      const stat = await fsp.stat(safe.absolutePath);
      if (stat.isDirectory()) zip.addLocalFolder(safe.absolutePath, path.basename(safe.absolutePath));
      else zip.addLocalFile(safe.absolutePath);
      await this.bumpProcessedBytes(task.id, bytes);
      await this.bumpProcessed(task.id);
    }
    zip.writeZip(targetPath);
    return operations.map(({ safe }) => ({ rootSlug: safe.root.slug, path: safe.logicalPath }));
  }

  /** The finished archive of a `download_zip` task, re-checking that the actor may still download every source. */
  async openDownload(actor: Actor, taskId: string): Promise<{ path: string; size: number; fileName: string }> {
    const task = this.getForActor(actor, taskId);
    if (task.type !== "download_zip" || task.status !== "done") {
      throw new AppError(409, "Task has no download", "TASK_DOWNLOAD_NOT_READY");
    }
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    for (const source of sources) {
      const safe = await this.paths.resolveForCreate(source.rootSlug, source.path);
      this.permissions.require(actor, "download", safe.root, safe.logicalPath);
    }
    const filePath = this.downloadPath(task.id);
    let size: number;
    try {
      size = (await fsp.stat(filePath)).size;
    } catch (error) {
      if (isMissingPathError(error)) throw new AppError(410, "Download has expired", "TASK_DOWNLOAD_EXPIRED");
      throw error;
    }
    this.audit.write({ actorType: "user", actorId: actor.id, action: "download", target: { taskId, sources }, result: "success" });
    const { fileName } = JSON.parse(task.destination ?? "{}") as { fileName?: string };
    return { path: filePath, size, fileName: fileName || "download.zip" };
  }

  /** Download archives are throwaway; drop the ones nobody fetched within a day. */
  async cleanupExpiredDownloads(): Promise<void> {
    const dir = path.join(this.appDataDir, "temp", "downloads");
    const entries = await fsp.readdir(dir).catch(() => [] as string[]);
    for (const entry of entries) {
      const filePath = path.join(dir, entry);
      const stat = await fsp.stat(filePath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > downloadMaxAgeMs) await fsp.rm(filePath, { force: true });
    }
  }

  private downloadPath(taskId: string): string {
    return path.join(this.appDataDir, "temp", "downloads", `${taskId}.zip`);
  }

  private async runExtract(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string };
    const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
    this.permissions.require(actor, "upload", dest.root, dest.logicalPath);
    this.permissions.require(actor, "extract", dest.root, dest.logicalPath);
    let totalFiles = 0;
    let totalBytes = 0;
    const archives: Array<{ entries: AdmZip.IZipEntry[] }> = [];
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "read", safe.root, safe.logicalPath);
      const zip = new AdmZip(safe.absolutePath);
      const entries = zip.getEntries();
      const stats = this.validateExtractEntries(entries);
      totalFiles += stats.totalFiles;
      totalBytes += stats.totalBytes;
      archives.push({ entries });
    }
    await this.updateTotals(task.id, Math.max(totalFiles, 1), totalBytes);

    for (const archive of archives) {
      for (const entry of archive.entries) {
        await this.progress(task.id, entry.entryName);
        const processedBytes = await this.extractEntry(entry, dest.absolutePath);
        await this.bumpProcessedBytes(task.id, processedBytes);
        await this.bumpProcessed(task.id);
      }
    }
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "extract",
      rootId: dest.root.id,
      path: dest.logicalPath,
      target: { taskId: task.id, sources: sources.map((source) => ({ rootSlug: source.rootSlug, path: source.path })) },
      result: "success"
    });
  }

  private validateExtractEntries(entries: AdmZip.IZipEntry[]): { totalFiles: number; totalBytes: number } {
    if (entries.length > maxExtractEntries) {
      throw new AppError(413, "Zip contains too many entries", "ZIP_ENTRY_LIMIT");
    }
    let totalBytes = 0;
    let totalFiles = 0;
    for (const entry of entries) {
      this.safeZipEntrySegments(entry);
      if (isZipSymlink(entry)) throw new AppError(400, "Symlink zip entries are not allowed", "ZIP_SYMLINK_FORBIDDEN");
      if (!entry.isDirectory) {
        totalFiles += 1;
        totalBytes += entry.header.size;
        if (totalBytes > maxExtractBytes) throw new AppError(413, "Zip is too large to extract", "ZIP_SIZE_LIMIT");
      }
    }
    return { totalFiles: Math.max(totalFiles, 1), totalBytes };
  }

  private async extractEntry(entry: AdmZip.IZipEntry, destinationPath: string): Promise<number> {
    const segments = this.safeZipEntrySegments(entry);
    const target = safeJoin(destinationPath, segments);
    if (entry.isDirectory) {
      await assertNoExistingSymlinkSegments(destinationPath, target);
      await fsp.mkdir(target, { recursive: true });
      await assertRealPathInside(destinationPath, target);
      return 0;
    }
    const parent = path.dirname(target);
    await assertNoExistingSymlinkSegments(destinationPath, parent);
    await fsp.mkdir(parent, { recursive: true });
    await assertRealPathInside(destinationPath, parent);
    const data = entry.getData();
    if (data.length > maxExtractBytes) throw new AppError(413, "Zip is too large to extract", "ZIP_SIZE_LIMIT");
    await fsp.writeFile(target, data, { flag: "wx", mode: 0o644 });
    return data.length;
  }

  private safeZipEntrySegments(entry: AdmZip.IZipEntry): string[] {
    // Archives made on macOS carry NFD names; extracted files are new, so they are written in NFC.
    const name = nfc(entry.entryName.replaceAll("\\", "/"));
    if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:\//.test(name)) {
      throw new AppError(400, "Unsafe zip entry", "UNSAFE_ZIP_ENTRY");
    }
    const segments = name.split("/").filter(Boolean);
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
      throw new AppError(400, "Unsafe zip entry", "UNSAFE_ZIP_ENTRY");
    }
    return segments;
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
    await runRsync([...rsyncFlags(destination.options), "--", ensureTrailingSlash(remote), ensureTrailingSlash(dest.absolutePath)], () => this.isCancelled(task.id));
    await this.bumpProcessed(task.id);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "rsync_pull",
      rootId: dest.root.id,
      path: dest.logicalPath,
      target: { taskId: task.id },
      result: "success"
    });
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
      await runRsync([...rsyncFlags(destination.options), "--", safe.absolutePath, ensureTrailingSlash(destination.remote)], () => this.isCancelled(task.id));
      await this.bumpProcessed(task.id);
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "rsync_push",
        rootId: safe.root.id,
        path: safe.logicalPath,
        target: { taskId: task.id },
        result: "success"
      });
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

  private async assertTaskPermissions(actor: Actor, input: z.infer<typeof taskInputSchema>): Promise<void> {
    if (input.type === "copy" || input.type === "move") {
      const destination = this.requiredDestination(input);
      const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
      this.permissions.require(actor, "upload", dest.root, dest.logicalPath);
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        if (input.type === "move") this.requireAny(actor, ["move", "delete"], safe.root, safe.logicalPath);
        else this.permissions.require(actor, "read", safe.root, safe.logicalPath);
        await assertTargetOutsideSource(safe.absolutePath, path.join(dest.absolutePath, path.basename(safe.absolutePath)));
      }
      return;
    }

    if (input.type === "delete_to_trash") {
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "delete", safe.root, safe.logicalPath);
      }
      return;
    }

    if (input.type === "restore_trash") {
      for (const source of input.sources) {
        if (source.rootSlug !== "trash") throw new AppError(400, "Invalid restore source", "INVALID_RESTORE_SOURCE");
        const item = this.getRestorableTrashItem(actor, source.path);
        await this.requireRestorePermission(actor, item);
      }
      return;
    }

    if (input.type === "compress") {
      const destination = this.requiredDestination(input);
      const dest = await this.paths.resolveForCreate(destination.rootSlug, destination.path);
      const parentLogicalPath = path.posix.dirname(dest.logicalPath);
      const permissionPath = parentLogicalPath === "." ? "/" : parentLogicalPath;
      this.permissions.require(actor, "upload", dest.root, permissionPath);
      this.permissions.require(actor, "compress", dest.root, permissionPath);
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "read", safe.root, safe.logicalPath);
      }
      return;
    }

    if (input.type === "download_zip") {
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "download", safe.root, safe.logicalPath);
      }
      return;
    }

    if (input.type === "extract") {
      const destination = this.requiredDestination(input);
      const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
      this.permissions.require(actor, "upload", dest.root, dest.logicalPath);
      this.permissions.require(actor, "extract", dest.root, dest.logicalPath);
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "read", safe.root, safe.logicalPath);
      }
      return;
    }

    if (input.type === "rsync_pull") {
      const destination = this.requiredDestination(input);
      const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
      this.permissions.require(actor, "upload", dest.root, dest.logicalPath);
      this.permissions.require(actor, "run_rsync", dest.root, dest.logicalPath);
      return;
    }

    if (input.type === "rsync_push") {
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "read", safe.root, safe.logicalPath);
        this.permissions.require(actor, "run_rsync", safe.root, safe.logicalPath);
      }
      return;
    }

    if (input.type === "thumbnail") {
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "read", safe.root, safe.logicalPath);
      }
    }
  }

  private requiredDestination(input: z.infer<typeof taskInputSchema>): { rootSlug: string; path: string } {
    if (!input.destination) throw new AppError(400, "Destination required", "DESTINATION_REQUIRED");
    return input.destination;
  }

  private async requireRestorePermission(actor: Actor, item: RestorableTrashItem): Promise<void> {
    const parentPath = path.posix.dirname(item.original_path);
    const safe = await this.paths.resolveRootById(item.original_root_id, parentPath === "." ? "/" : parentPath);
    this.permissions.require(actor, "upload", safe.root, safe.logicalPath);
  }

  private requireAny(actor: Actor, actions: Action[], root: Parameters<PermissionService["can"]>[2], logicalPath: string): void {
    const results = actions.map((action) => ({ action, result: this.permissions.can(actor, action, root, logicalPath) }));
    if (results.some(({ result }) => result.allowed)) return;
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "permission_denied",
      rootId: root.id,
      path: logicalPath,
      target: { actions, reasons: results.map(({ action, result }) => ({ action, reason: result.reason ?? "Forbidden" })) },
      result: "denied"
    });
    throw new AppError(403, results[0]?.result.reason ?? "Forbidden", "FORBIDDEN");
  }

  private isCancelled(taskId: string): boolean {
    return this.get(taskId).status !== "running";
  }

  /** Checkpoint for running tasks; throttled so it costs one row read every few hundred ms at most. */
  private assertNotCancelled(taskId: string): void {
    const ts = Date.now();
    if (ts - (this.cancelChecks.get(taskId) ?? 0) < cancelCheckIntervalMs) return;
    this.cancelChecks.set(taskId, ts);
    if (this.isCancelled(taskId)) throw new TaskCancelledError();
  }

  private async progress(taskId: string, currentPath: string): Promise<void> {
    this.assertNotCancelled(taskId);
    const buffer = this.progressBuffer(taskId);
    buffer.currentPath = currentPath;
    this.flushProgress(taskId);
  }

  private async bumpProcessed(taskId: string): Promise<void> {
    this.assertNotCancelled(taskId);
    const buffer = this.progressBuffer(taskId);
    buffer.processedFiles += 1;
    this.flushProgress(taskId);
  }

  private bumpProcessedBytes(taskId: string, bytes: number): void {
    if (bytes <= 0) return;
    this.assertNotCancelled(taskId);
    const buffer = this.progressBuffer(taskId);
    buffer.processedBytes += bytes;
    this.flushProgress(taskId);
  }

  private async updateTotals(taskId: string, totalFiles: number, totalBytes: number): Promise<void> {
    this.flushProgress(taskId, true);
    this.db
      .prepare("UPDATE tasks SET total_files = ?, total_bytes = ?, updated_at = ? WHERE id = ?")
      .run(Math.max(totalFiles, 1), Math.max(totalBytes, 0), now(), taskId);
    const task = this.get(taskId);
    this.events.publish({
      type: "task.progress",
      userId: task.created_by,
      taskId,
      patch: { total_files: Math.max(totalFiles, 1), total_bytes: Math.max(totalBytes, 0) }
    });
  }

  /** Returns false when the task was cancelled in the meantime, in which case its row is left alone. */
  private finish(taskId: string, status: "done" | "failed", error?: string): boolean {
    this.flushProgress(taskId, true);
    const result = this.db
      .prepare("UPDATE tasks SET status = ?, error_message = ?, updated_at = ?, finished_at = ? WHERE id = ? AND status = 'running'")
      .run(status, error ?? null, now(), now(), taskId);
    return Number(result.changes) > 0;
  }

  private progressBuffer(taskId: string): ProgressBuffer {
    const existing = this.progressBuffers.get(taskId);
    if (existing) return existing;
    const buffer = { processedFiles: 0, processedBytes: 0, lastFlushAt: 0 };
    this.progressBuffers.set(taskId, buffer);
    return buffer;
  }

  private flushProgress(taskId: string, force = false): void {
    const buffer = this.progressBuffers.get(taskId);
    if (!buffer) return;
    const ts = Date.now();
    const shouldFlush =
      force ||
      buffer.lastFlushAt === 0 ||
      ts - buffer.lastFlushAt >= progressFlushIntervalMs ||
      buffer.processedBytes >= progressFlushBytes;
    if (!shouldFlush) return;
    if (!buffer.currentPath && buffer.processedFiles === 0 && buffer.processedBytes === 0) return;

    this.db
      .prepare(
        `UPDATE tasks
        SET current_path = COALESCE(?, current_path),
            processed_files = processed_files + ?,
            processed_bytes = processed_bytes + ?,
            updated_at = ?
        WHERE id = ?`
      )
      .run(buffer.currentPath ?? null, buffer.processedFiles, buffer.processedBytes, now(), taskId);

    const task = this.get(taskId);
    const patch: Record<string, unknown> = {
      processed_files: task.processed_files,
      processed_bytes: task.processed_bytes
    };
    if (buffer.currentPath) patch.current_path = task.current_path;
    this.events.publish({ type: "task.progress", userId: task.created_by, taskId, patch });

    buffer.currentPath = undefined;
    buffer.processedFiles = 0;
    buffer.processedBytes = 0;
    buffer.lastFlushAt = ts;
    if (force) this.progressBuffers.delete(taskId);
  }

  private requireTaskAccess(actor: Actor, task: FileTask): void {
    if (actor.role === "ADMIN" || task.created_by === actor.id) return;
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "permission_denied",
      target: { action: "task_access", taskId: task.id },
      result: "denied"
    });
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
    this.events.publish({ type: "task.created", userId: retryTask.created_by, task: retryTask });
    return retryTask;
  }

  private taskInputFromTask(task: FileTask): z.infer<typeof taskInputSchema> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = task.destination
      ? JSON.parse(task.destination) as { rootSlug?: string; path?: string; remote?: string; options?: RsyncOptions }
      : undefined;
    if (task.type === "rsync_pull") {
      return taskInputSchema.parse({
        type: task.type,
        sources: [],
        remote: sources[0]?.path,
        destination: destination?.rootSlug && destination.path ? { rootSlug: destination.rootSlug, path: destination.path } : undefined,
        options: destination?.options
      });
    }
    if (task.type === "rsync_push") {
      return taskInputSchema.parse({
        type: task.type,
        sources,
        remote: destination?.remote,
        options: destination?.options
      });
    }
    return taskInputSchema.parse({
      type: task.type,
      sources,
      destination: destination?.rootSlug && destination.path ? { rootSlug: destination.rootSlug, path: destination.path } : undefined,
      options: destination?.options
    });
  }
}

type RsyncOptions = {
  archive?: boolean;
  delete?: boolean;
  dryRun?: boolean;
};

type RestorableTrashItem = {
  id: string;
  original_path: string;
  trash_path: string;
  original_root_id: string;
  deleted_by: string;
};

type PathStats = {
  bytes: number;
};

type ProgressBuffer = {
  processedFiles: number;
  processedBytes: number;
  currentPath?: string;
  lastFlushAt: number;
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

function isSafeRsyncRemote(value: string): boolean {
  if (!value || value.includes("\0") || /[\s;&|`$<>]/.test(value)) return false;
  if (value.startsWith("-") || value.startsWith("/") || value.startsWith(".")) return false;
  if (value.includes("::")) return false;
  const match = value.match(/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?:(.+)$/);
  if (!match) return false;
  const remotePath = match[1] ?? "";
  if (!remotePath || remotePath.startsWith("-")) return false;
  return /^[A-Za-z0-9._~+/@:%=-]+$/.test(remotePath);
}

function runRsync(args: string[], isCancelled: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("rsync", args, { stdio: ["ignore", "ignore", "pipe"] });
    let cancelled = false;
    const watcher = setInterval(() => {
      if (!isCancelled()) return;
      cancelled = true;
      child.kill();
    }, 500);
    child.stderr.resume();
    child.on("error", (error) => {
      clearInterval(watcher);
      reject(error);
    });
    child.on("close", (code) => {
      clearInterval(watcher);
      if (cancelled) reject(new TaskCancelledError());
      else if (code === 0) resolve();
      else reject(new AppError(500, "rsync failed", "RSYNC_FAILED"));
    });
  });
}

function downloadFileName(sources: Array<{ path: string }>): string {
  const single = sources.length === 1 ? nfc(path.posix.basename(sources[0]!.path)) : "";
  if (single) return `${single}.zip`;
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "").replace("T", "-");
  return `Kago-${stamp}.zip`;
}

function taskFailureMessage(error: unknown): string {
  return error instanceof AppError ? error.message : "Task failed";
}

function isZipSymlink(entry: AdmZip.IZipEntry): boolean {
  const unixMode = (entry.header.attr >>> 16) & unixFileTypeMask;
  return unixMode === symlinkFileType;
}

function safeJoin(rootPath: string, segments: string[]): string {
  const target = path.resolve(rootPath, ...segments);
  const relative = path.relative(rootPath, target);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError(400, "Unsafe zip entry", "UNSAFE_ZIP_ENTRY");
  }
  return target;
}

async function assertRealPathInside(rootPath: string, targetPath: string): Promise<void> {
  const rootReal = await fsp.realpath(rootPath);
  const targetReal = await fsp.realpath(targetPath);
  const relative = path.relative(rootReal, targetReal);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError(403, "Extract target escapes destination", "ZIP_TARGET_ESCAPES_DESTINATION");
  }
}

async function collectPathStats(targetPath: string): Promise<PathStats> {
  const stat = await fsp.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
  }
  if (stat.isFile()) return { bytes: stat.size };
  if (!stat.isDirectory()) {
    throw new AppError(403, "Only files and folders are supported", "UNSUPPORTED_FILE_TYPE");
  }
  let bytes = 0;
  const entries = await fsp.readdir(targetPath);
  for (const entry of entries) {
    const childStats = await collectPathStats(path.join(targetPath, entry));
    bytes += childStats.bytes;
  }
  return { bytes };
}

async function assertTargetOutsideSource(sourcePath: string, targetPath: string): Promise<void> {
  const stat = await fsp.lstat(sourcePath);
  if (!stat.isDirectory()) return;
  const relative = path.relative(path.resolve(sourcePath), path.resolve(targetPath));
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new AppError(409, "Cannot copy or move a folder into itself", "TARGET_INSIDE_SOURCE");
  }
}

async function copyPath(sourcePath: string, targetPath: string, onBytes: (bytes: number) => void): Promise<void> {
  const stat = await fsp.lstat(sourcePath);
  if (stat.isSymbolicLink()) {
    throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
  }
  if (stat.isDirectory()) {
    await fsp.mkdir(targetPath, { mode: stat.mode });
    const entries = await fsp.readdir(sourcePath);
    for (const entry of entries) {
      await copyPath(path.join(sourcePath, entry), path.join(targetPath, entry), onBytes);
    }
    await preservePathMetadata(targetPath, stat);
    return;
  }
  if (!stat.isFile()) {
    throw new AppError(403, "Only files and folders are supported", "UNSUPPORTED_FILE_TYPE");
  }
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const byteCounter = new Transform({
    transform(chunk, _encoding, callback) {
      // onBytes is also the cancellation checkpoint; route its throw through the pipeline.
      try {
        onBytes(Buffer.byteLength(chunk));
        callback(null, chunk);
      } catch (error) {
        callback(error as Error);
      }
    }
  });
  await pipeline(createReadStream(sourcePath), byteCounter, createWriteStream(targetPath, { flags: "wx", mode: Number(stat.mode) }));
  await preservePathMetadata(targetPath, stat);
}

/**
 * Copies a file or folder to a target that did not exist before. A cancelled copy removes the
 * partial target again; cancellation only fires mid-stream, after this call created it.
 */
async function copyTree(sourcePath: string, targetPath: string, onBytes: (bytes: number) => void): Promise<void> {
  try {
    await copyPath(sourcePath, targetPath, onBytes);
  } catch (error) {
    if (error instanceof TaskCancelledError) await fsp.rm(targetPath, { recursive: true, force: true });
    throw error;
  }
}

async function preservePathMetadata(targetPath: string, stat: Awaited<ReturnType<typeof fsp.lstat>>): Promise<void> {
  await fsp.chmod(targetPath, Number(stat.mode)).catch(() => undefined);
  await fsp.utimes(targetPath, stat.atime, stat.mtime).catch(() => undefined);
}

async function movePath(sourcePath: string, targetPath: string, onBytes: (bytes: number) => void): Promise<boolean> {
  try {
    await fsp.rename(sourcePath, targetPath);
    return false;
  } catch (error) {
    if (!isNodeError(error, "EXDEV")) throw error;
    await copyTree(sourcePath, targetPath, onBytes);
    await fsp.rm(sourcePath, { recursive: true, force: false });
    return true;
  }
}

async function assertNoSymlinksDeep(targetPath: string): Promise<void> {
  const stat = await fsp.lstat(targetPath);
  if (stat.isSymbolicLink()) {
    throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
  }
  if (!stat.isDirectory()) return;
  const entries = await fsp.readdir(targetPath);
  for (const entry of entries) {
    await assertNoSymlinksDeep(path.join(targetPath, entry));
  }
}

async function assertNoExistingSymlinkSegments(rootPath: string, targetPath: string): Promise<void> {
  const relative = path.relative(rootPath, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new AppError(403, "Extract target escapes destination", "ZIP_TARGET_ESCAPES_DESTINATION");
  }
  if (!relative) return;

  let current = rootPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
    }
  }
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error, "ENOENT");
}

function isNodeError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === code);
}
