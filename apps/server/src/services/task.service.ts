import fsp from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { EventHub } from "../ws/events.js";
import type { AuditService } from "./audit.service.js";
import type { PathService } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { Actor, FileTask } from "./types.js";

const fileRefSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1)
});

export const taskInputSchema = z.object({
  type: z.enum(["copy", "move", "delete_to_trash", "restore_trash", "compress", "extract"]),
  sources: z.array(fileRefSchema).min(1),
  destination: fileRefSchema.optional()
});

export class TaskService {
  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly events: EventHub,
    private readonly appDataDir: string
  ) {}

  create(actor: Actor, input: z.infer<typeof taskInputSchema>): FileTask {
    if (["copy", "move", "compress", "extract"].includes(input.type) && !input.destination) {
      throw new AppError(400, "Destination required", "DESTINATION_REQUIRED");
    }

    const ts = now();
    const task: FileTask = {
      id: id("task"),
      type: input.type,
      status: "queued",
      created_by: actor.id,
      sources_json: JSON.stringify(input.sources),
      destination: input.destination ? JSON.stringify(input.destination) : null,
      total_files: input.sources.length,
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

  get(taskId: string): FileTask {
    const task = row<FileTask>(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    if (!task) throw new AppError(404, "Task not found", "TASK_NOT_FOUND");
    return task;
  }

  cancel(taskId: string): FileTask {
    this.db
      .prepare("UPDATE tasks SET status = 'cancelled', updated_at = ?, finished_at = ? WHERE id = ? AND status = 'queued'")
      .run(now(), now(), taskId);
    return this.get(taskId);
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
      else if (task.type === "restore_trash") await this.runRestore(task);
      else if (task.type === "compress") await this.runCompress(task, actor);
      else if (task.type === "extract") await this.runExtract(task, actor);
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

  private async runRestore(task: FileTask): Promise<void> {
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
}
