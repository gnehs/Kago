import { constants as fsConstants, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { ConvertStopped } from "../lib/convert.js";
import { AppError, errnoIs, fileSystemRefusal } from "../lib/errors.js";
import { isSafeLogicalSegment, nfc, safeRelativeZipPath } from "../lib/filename.js";
import { id, now } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { bytesToCarry, collectPathStats, copyTree, countEntries, freeName, limiter, mergeTree, movePath, nearestFolder, recoverRemoteReplaced, recoverReplaced, removeTree, replacePath, StoredNames, swapIn, swapInRemote, treeConcurrency, assertTargetOutsideSource, type Clash, type Found, type FolderEntry, type PathStats } from "../lib/tree-ops.js";
import { isZipDirectory, isZipSymlink, openZipArchive, zipEntryName } from "../lib/zip-archive.js";
import { openEncryptedZipEntry, readZipCipherHead, zipCipherOf, zipPasswordFits, ZipPasswordError, type ZipCipher } from "../lib/zip-crypto.js";
import { SecretBox } from "../lib/secret-box.js";
import { zipStream, type ZipEntry, type ZipOptions } from "../lib/zip-stream.js";
import { RcloneJobStopped, refusedForPermission, type RcloneItem, type RcloneStats } from "../storage/rclone-client.js";
import { runRclone } from "../storage/rclone-daemon.js";
import { isReservedName, REPLACE_PARTIAL, TRASH_FOLDER } from "../lib/system-files.js";
import { isRemote, joinFs, transferProgress } from "../storage/remote-storage.js";
import type { TaskPace as Pace, TaskType, TransferConflict } from "@kago/contract";
import type { EventPublisher } from "../ws/events.js";
import { ArchivePasswordService } from "./archive-password.service.js";
import type { AuditService } from "./audit.service.js";
import { convertInputSchema, convertJobOptionsSchema, ConvertService, remuxInputSchema, type ConvertInput, type ConvertJobRun, type RemuxInputSpec, type TaskHandle } from "./convert.service.js";
import type { FsService } from "./fs.service.js";
import { liesWithin, sharesAreFixed, type PathService, type SafePath } from "./path.service.js";
import type { Level, PermissionService } from "./permission.service.js";
import type { PreferenceService } from "./preference.service.js";
import type { StorageService } from "./storage.service.js";
import { SyncReport } from "./sync-report.js";
import { mediaTaskTypes, taskChanges, taskKinds, type TaskLane } from "./task-kinds.js";
import { TrashService, type RestorableTrashItem } from "./trash.service.js";
import { allowsTransition, endsTask, taskTransitions, transitionTask, type Transition, type TaskTransition } from "./task-status.js";
import { finishedTaskStatuses, sqlStatuses, type Actor, type FileTask, type Root } from "./types.js";
import { jobBusy, jobIdOf } from "./job-run.js";

const maxExtractEntries = 10_000;
const maxExtractBytes = 1024 * 1024 * 1024 * 2;
const progressFlushIntervalMs = 500;
const progressFlushBytes = 1024 * 1024 * 16;
const cancelCheckIntervalMs = 300;
/** How many files rclone carries at a time. */
const transferConcurrency = 8;
const downloadMaxAgeMs = 24 * 60 * 60 * 1000;
const finishedStatuses = sqlStatuses(finishedTaskStatuses);
/** A worker still holds these, and may write what it has counted. */
const heldStatuses = sqlStatuses(["running", "cancelling"]);
/** A replacement begun before this was loaded belongs to a run that stopped; see `recoverReplaced`. */
const LOADED_AT = Date.now();
const finishedTaskMaxAgeSeconds = 7 * 24 * 60 * 60;

const fileRefSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1)
});

/**
 * What a `copy` or `move` does with a source whose name the destination already has. `keep` puts it beside the one
 * there under a name of its own. A folder landing on a folder may be merged into it instead, and the word after
 * `merge_` is what then happens to a file the folder there already has.
 */
const conflictActions = ["skip", "replace", "keep", "merge_skip", "merge_replace", "merge_keep"] as const;
type ConflictAction = (typeof conflictActions)[number];
type Conflicts = Record<string, ConflictAction>;

export const transferCheckSchema = z.object({
  sources: z.array(fileRefSchema).min(1),
  destination: fileRefSchema
});

export const taskInputSchema = z.object({
  type: z.enum([
    "copy",
    "move",
    "delete_to_trash",
    "delete",
    "restore_trash",
    "empty_trash",
    "compress",
    "download_zip",
    "extract",
    "thumbnail"
  ]),
  sources: z.array(fileRefSchema).default([]),
  destination: fileRefSchema.optional(),
  options: z.object({
    /** How hard a `compress` task squeezes, and what it locks the archive with. */
    level: z.enum(["store", "fast", "normal", "best"]).optional(),
    encryption: z.enum(["aes256", "zipcrypto"]).optional(),
    /** What a `compress` task locks the archive with, or what an `extract` task tries before the saved ones. */
    password: z.string().min(1).max(1024).optional(),
    /** Whether an `extract` task keeps the password among the saved ones once it has opened the archive. */
    remember: z.boolean().optional(),
    /** What a `copy` or `move` does where the destination already has a source's name: an action for each such name, in NFC. Without one the task stops there. */
    conflicts: z.record(z.string(), z.enum(conflictActions)).optional()
  }).optional()
});

const zipLevels = { store: 0, fast: 1, normal: 6, best: 9 } as const;
type CompressOptions = { level?: keyof typeof zipLevels; encryption?: "aes256" | "zipcrypto"; password?: string };
type ExtractOptions = { password?: string; remember?: boolean };
/** How many locked entries a password is checked against before anything is written. */
const maxPasswordProbes = 16;

/** One end of a sync: a folder of a location. */
export const syncEndpointSchema = z.object({ kind: z.literal("location"), rootSlug: z.string().min(1), path: z.string().min(1) });

export const syncOptionsSchema = z.object({
  /** `mirror` also removes from the destination what the source no longer has. */
  mode: z.enum(["copy", "mirror"]).default("copy"),
  dryRun: z.boolean().default(false)
});

export type SyncEndpoint = z.infer<typeof syncEndpointSchema>;
export type SyncSpec = { jobId?: string; name: string; source: SyncEndpoint; destination: SyncEndpoint; options: z.infer<typeof syncOptionsSchema> };

type ZipSourcesResult = { sources: Array<{ rootSlug: string; path: string }> };
type PlannedZipEntry = { entry: ZipEntry; safe: SafePath; logicalPath: string; absolutePath?: string };
type PlannedZipSource = { safe: SafePath; entries: PlannedZipEntry[] };

/** Thrown inside a running task once its row is no longer `running`. */
class TaskCancelledError extends Error {}

export class TaskService {
  private readonly progressBuffers = new Map<string, ProgressBuffer>();
  private readonly cancelChecks = new Map<string, number>();
  private secretBox: SecretBox | null = null;
  readonly archivePasswords: ArchivePasswordService;
  readonly convert: ConvertService;
  readonly trash: TrashService;

  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly appDataDir: string,
    private readonly fsService: FsService,
    private readonly storage: StorageService,
    private readonly preferences: PreferenceService
  ) {
    this.archivePasswords = new ArchivePasswordService(db, () => this.secrets());
    this.trash = new TrashService(db, paths, permissions, audit, storage, appDataDir, events);
    this.convert = new ConvertService(db, paths, permissions, audit, storage, appDataDir, (actor, safe, taskId) => this.trashNow(actor, safe, taskId));
  }

  async create(actor: Actor, input: z.infer<typeof taskInputSchema>): Promise<FileTask> {
    if (["copy", "move", "compress", "extract"].includes(input.type) && !input.destination) {
      throw new AppError(400, "Destination required", "DESTINATION_REQUIRED");
    }
    if (input.sources.length === 0) {
      throw new AppError(400, "Sources required", "SOURCES_REQUIRED");
    }

    const { sources } = input;
    const { level, password, encryption, remember, conflicts } = input.options ?? {};
    // The task row is shown to its owner and kept for a week, so the password only ever sits in it sealed.
    const sealed = password ? this.secrets().seal(password) : undefined;
    const archiveOptions: CompressOptions | ExtractOptions =
      input.type === "compress"
        ? { level, ...(sealed ? { encryption: encryption ?? "aes256", password: sealed } : {}) }
        : sealed ? { password: sealed, remember } : {};
    const destination =
      input.type === "download_zip"
        ? JSON.stringify({ fileName: downloadFileName(sources) })
        : input.destination
          ? JSON.stringify({ ...input.destination, options: input.type === "compress" || input.type === "extract" ? archiveOptions : (input.type === "copy" || input.type === "move") && conflicts ? { conflicts } : {} })
          : null;

    await this.assertTaskPermissions(actor, input);

    const task = this.insertQueued(actor, input.type, sources, destination, {});
    this.audit.write({ actorType: "user", actorId: actor.id, action: "create_task", target: withoutPassword(input), result: "success" });
    this.events.publish({ type: "task.created", userId: task.created_by, task });
    return task;
  }

  private secrets(): SecretBox {
    this.secretBox ??= new SecretBox(this.appDataDir);
    return this.secretBox;
  }

  /** Queues one run of a sync. Syncs are not asked for like other tasks: a saved job is their only way in. */
  async createSync(actor: Actor, spec: SyncSpec, scheduled = false): Promise<FileTask> {
    await this.assertSyncPermissions(actor, spec);
    const task = this.insertQueued(actor, "sync", [{ rootSlug: spec.source.rootSlug, path: spec.source.path }], JSON.stringify({ sync: spec }), { scheduled });
    this.audit.write({ actorType: "user", actorId: actor.id, action: "create_task", target: { type: "sync", jobId: spec.jobId, scheduled }, result: "success" });
    this.events.publish({ type: "task.created", userId: task.created_by, task });
    return task;
  }

  /** Queues a conversion of the given files, or with `job` one run of a saved job over its input folder. */
  async createConvert(actor: Actor, input: ConvertInput, job?: ConvertJobRun, scheduled = false): Promise<FileTask> {
    if (job) await this.convert.assertJob(actor, { input: job.input, destination: input.destination, options: job.options });
    else await this.convert.assertConvert(actor, input);
    const task = this.queue(actor, "convert", input.sources, JSON.stringify({ ...input.destination, convert: input.spec, ...(job ? { job } : {}) }), scheduled);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "create_task", target: { type: "convert", format: input.spec.format, count: input.sources.length, jobId: job?.id, scheduled }, result: "success" });
    return task;
  }

  /** Queues the packing of a video's tracks into a Matroska file beside it. */
  async createRemux(actor: Actor, input: RemuxInputSpec): Promise<FileTask> {
    await this.convert.assertRemux(actor, input);
    const task = this.queue(actor, "remux", [input.source], JSON.stringify({ rootSlug: input.source.rootSlug, path: path.posix.dirname(input.source.path), remux: input }));
    this.audit.write({ actorType: "user", actorId: actor.id, action: "create_task", target: { type: "remux", source: input.source, name: input.name }, result: "success" });
    return task;
  }

  private queue(actor: Actor, type: TaskType, sources: Array<{ rootSlug: string; path: string }>, destination: string, scheduled = false): FileTask {
    const task = this.insertQueued(actor, type, sources, destination, scheduled ? { scheduled } : {});
    this.events.publish({ type: "task.created", userId: task.created_by, task });
    return task;
  }

  /** Inserts a fresh queued task. `auth` is what goes into its auth snapshot beside the actor. */
  private insertQueued(actor: Actor, type: TaskType, sources: Array<{ rootSlug: string; path: string }>, destination: string | null, auth: Record<string, unknown>): FileTask {
    const ts = now();
    const task: FileTask = {
      id: id("task"),
      type,
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
      auth_snapshot_json: JSON.stringify({ actorId: actor.id, role: actor.role, ...auth }),
      created_at: ts,
      updated_at: ts,
      started_at: null,
      finished_at: null
    };
    this.insertTask(task);
    return task;
  }

  /** Checks again what a conversion was allowed when it was first asked for. */
  async assertMediaTask(actor: Actor, task: FileTask): Promise<void> {
    const { convert: spec, job, remux, ...destination } = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string; convert?: unknown; job?: ConvertJobRun; remux?: unknown };
    if (task.type === "remux") return this.convert.assertRemux(actor, remuxInputSchema.parse(remux));
    if (job) await this.convert.assertJob(actor, { input: job.input, destination, options: convertJobOptionsSchema.parse(job.options) });
    else await this.convert.assertConvert(actor, convertInputSchema.parse({ sources: JSON.parse(task.sources_json), destination, spec }));
  }

  /** What a conversion is given to say how it is getting on. */
  handle(taskId: string): TaskHandle {
    return {
      show: (currentPath) => this.show(taskId, currentPath),
      totals: (files, bytes) => this.updateTotals(taskId, files, bytes),
      bytes: (bytes) => this.countBytes(taskId, bytes),
      files: (files) => this.countFiles(taskId, files),
      pace: (fps, height) => this.setPace(taskId, fps, height),
      stopped: () => this.isCancelled(taskId)
    };
  }

  private insertTask(task: FileTask): void {
    try {
      this.db
        .prepare(
          `INSERT INTO tasks
          (id, type, status, created_by, sources_json, destination, total_files, processed_files, total_bytes,
           processed_bytes, current_path, error_message, auth_snapshot_json, created_at, updated_at, started_at, finished_at, job_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          task.finished_at,
          jobIdOf(task)
        );
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: tasks.job_id")) throw jobBusy();
      throw error;
    }
  }

  list(actor: Actor): Array<FileTask & { pace?: Pace }> {
    type TaskRow = FileTask & { pace_fps: number | null; pace_height: number | null; job_id: string | null };
    const tasks =
      actor.role === "ADMIN"
        ? rows<TaskRow>(this.db.prepare("SELECT * FROM tasks WHERE cleared = 0 ORDER BY created_at DESC LIMIT 200").all())
        : rows<TaskRow>(this.db.prepare("SELECT * FROM tasks WHERE cleared = 0 AND created_by = ? ORDER BY created_at DESC LIMIT 200").all(actor.id));
    return tasks.map(({ pace_fps, pace_height, job_id, ...task }) =>
      task.status === "running" && pace_fps !== null ? { ...task, pace: { fps: pace_fps, height: pace_height } } : task
    );
  }

  /** Forgets the finished tasks the actor can see. */
  async clearFinished(actor: Actor): Promise<{ cleared: number }> {
    const cleared = await this.forgetFinished(now(), actor.role === "ADMIN" ? undefined : actor.id);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "tasks_clear", target: { count: cleared }, result: "success" });
    return { cleared };
  }

  /** Finished tasks are only history; forget the ones that ended more than a week ago. */
  pruneFinished(): Promise<number> {
    return this.forgetFinished(now() - finishedTaskMaxAgeSeconds);
  }

  private async forgetFinished(endedBy: number, createdBy?: string): Promise<number> {
    const finished = `status IN (${finishedStatuses}) AND COALESCE(finished_at, updated_at) <= ?`;
    // A sync or auto-convert job reads the outcome of its last run from that task, so that one stays, only out of the list.
    const kept = "(id IN (SELECT last_task_id FROM sync_jobs WHERE last_task_id IS NOT NULL) OR id IN (SELECT last_task_id FROM convert_jobs WHERE last_task_id IS NOT NULL))";
    const tasks = rows<{ id: string; type: string; cleared: number; kept: number }>(
      createdBy
        ? this.db.prepare(`SELECT id, type, cleared, ${kept} AS kept FROM tasks WHERE ${finished} AND created_by = ?`).all(endedBy, createdBy)
        : this.db.prepare(`SELECT id, type, cleared, ${kept} AS kept FROM tasks WHERE ${finished}`).all(endedBy)
    );
    for (const task of tasks) {
      if (task.kept) {
        this.db.prepare("UPDATE tasks SET cleared = 1 WHERE id = ?").run(task.id);
        continue;
      }
      this.db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);
      if (task.type !== "download_zip") continue;
      // Nothing can ask for the archive once its task is gone.
      await fsp.rm(this.downloadPath(task.id), { force: true });
    }
    // One cleared earlier was already out of the list, whether or not its job has moved on since.
    return tasks.filter((task) => !task.cleared).length;
  }

  /**
   * Queues the removal for good of everything the actor can see in the trash. It is a task like any other removal:
   * a trash that holds many files takes minutes to empty, which a request would spend without a word.
   */
  async emptyTrash(actor: Actor): Promise<FileTask> {
    return this.create(actor, { type: "empty_trash", sources: this.trash.visibleIds(actor).map((trashItemId) => ({ rootSlug: "trash", path: trashItemId })) });
  }

  /** Removes for good the items of the trash a task names. One that has gone since, or is not the actor's, is passed over. */
  async runEmptyTrash(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const operations = [];
    let total = 0;
    const found = this.counter(task.id);
    for (const source of sources) {
      const target = await this.trash.emptiable(actor, source.path);
      if (!target) continue;
      const entries = target.local ? await countEntries(target.local, found) : 1;
      total += entries;
      operations.push({ target, entries });
    }
    await this.updateTotals(task.id, total, 0);
    for (const { target, entries } of operations) {
      await this.progress(task.id, target.item.original_path);
      let counted = 0;
      await this.trash.discard(target, () => {
        this.assertNotCancelled(task.id);
        counted += 1;
        this.countFiles(task.id, 1);
      });
      await this.bumpProcessed(task.id, entries - counted);
    }
    // One item is named, so that the log says which file was removed for good; many are only counted.
    const [only] = operations.length === 1 ? operations : [];
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "trash_empty",
      ...(only ? { rootId: only.target.item.original_root_id, path: only.target.item.original_path } : {}),
      target: { count: operations.length },
      result: "success"
    });
  }

  get(taskId: string): FileTask {
    const found = row<FileTask & { job_id: string | null }>(this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId));
    if (!found) throw new AppError(404, "Task not found", "TASK_NOT_FOUND");
    // The job is named in the destination too; the column is only there to hold a job to one active run.
    const { job_id, ...task } = found;
    return task;
  }

  getForActor(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    return task;
  }

  /**
   * Moves a task along `taskTransitions` and tells whoever can see it. False, with the row untouched, when the task's
   * status does not allow the move. What a task had counted is written before it ends.
   */
  transition<N extends TaskTransition>(taskId: string, name: N, ...[error]: N extends "fail" ? [error: string] : []): boolean {
    if (endsTask(name)) this.flushProgress(taskId, true);
    if (!transitionTask(this.db, taskId, name, error)) return false;
    const { tell }: Transition = taskTransitions[name];
    if (!tell) return true;
    const task = this.get(taskId);
    if (tell === "task.done") this.events.publish({ type: "task.done", userId: task.created_by, taskId });
    else if (tell === "task.failed") this.events.publish({ type: "task.failed", userId: task.created_by, taskId, error: error! });
    else this.events.publish({ type: "task.progress", userId: task.created_by, taskId, patch: Object.fromEntries(tell.map((field) => [field, task[field]])) });
    return true;
  }

  cancel(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    if (task.status === "cancelled" || task.status === "cancelling") return task;
    if (!allowsTransition(task.status, "cancel") && !allowsTransition(task.status, "stop")) {
      throw new AppError(409, "Only queued, paused, or running tasks can be cancelled", "TASK_CANCEL_NOT_ALLOWED");
    }
    // In this order, a task that starts running in between is still stopped.
    if (!this.transition(taskId, "cancel")) this.transition(taskId, "stop");
    this.audit.write({ actorType: "user", actorId: actor.id, action: "task_cancel", target: { taskId }, result: "success" });
    return this.get(taskId);
  }

  pause(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    if (task.status === "paused") return task;
    if (!allowsTransition(task.status, "pause")) {
      throw new AppError(409, "Only queued tasks can be paused", "TASK_PAUSE_NOT_ALLOWED");
    }
    if (!this.transition(taskId, "pause") && this.get(taskId).status !== "paused") throw new AppError(409, "Task can no longer be paused", "TASK_PAUSE_NOT_ALLOWED");
    this.audit.write({ actorType: "user", actorId: actor.id, action: "task_pause", target: { taskId }, result: "success" });
    return this.get(taskId);
  }

  resume(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    if (task.status === "queued") return task;
    if (!allowsTransition(task.status, "resume")) {
      throw new AppError(409, "Only paused tasks can be resumed", "TASK_RESUME_NOT_ALLOWED");
    }
    if (!this.transition(taskId, "resume") && this.get(taskId).status !== "queued") throw new AppError(409, "Task can no longer be resumed", "TASK_RESUME_NOT_ALLOWED");
    this.audit.write({ actorType: "user", actorId: actor.id, action: "task_resume", target: { taskId }, result: "success" });
    return this.get(taskId);
  }

  /** The task, when the actor may run it again. */
  retryable(actor: Actor, taskId: string): FileTask {
    const task = this.get(taskId);
    this.requireTaskAccess(actor, task);
    if (!["failed", "cancelled", "interrupted"].includes(task.status)) {
      throw new AppError(409, "Only failed, cancelled, or interrupted tasks can be retried", "TASK_RETRY_NOT_ALLOWED");
    }
    return task;
  }

  /** Queues the task again as it was. A run of a saved job is run again through its job instead, which keeps its runs. */
  async retry(actor: Actor, taskId: string): Promise<FileTask> {
    const task = this.retryable(actor, taskId);
    const asked = await taskKinds[task.type].recheck(this, task, actor);
    const again = this.cloneTask(actor, task);
    if (asked) this.audit.write({ actorType: "user", actorId: actor.id, action: "create_task", target: asked, result: "success" });
    this.audit.write({ actorType: "user", actorId: actor.id, action: "task_retry", target: { taskId, retryTaskId: again.id }, result: "success" });
    return again;
  }

  /** Checks again what a task asked for through `create` was allowed, and gives what `create` logged of it. */
  async assertInputTask(actor: Actor, task: FileTask): Promise<z.infer<typeof taskInputSchema>> {
    const input = this.taskInputFromTask(task);
    await this.assertTaskPermissions(actor, input);
    return withoutPassword(input);
  }

  failRunning(taskId: string, errorMessage = "Worker failed before executing task"): void {
    const task = this.get(taskId);
    // Not running any more, or asked to stop since it was read: a task asked to stop has stopped now.
    if (!this.transition(taskId, "fail", errorMessage)) {
      this.transition(taskId, "settle");
      return;
    }
    this.audit.write({
      actorType: "system",
      action: "task_failed",
      target: { taskId, type: task.type },
      result: "failure"
    });
  }

  async createRestoreTrash(actor: Actor, trashItemId: string): Promise<FileTask> {
    this.trash.getRestorable(actor, trashItemId);
    return this.create(actor, {
      type: "restore_trash",
      sources: [{ rootSlug: "trash", path: trashItemId }]
    });
  }

  /** Takes the oldest task that is waiting, of the given lane's when one is named. */
  claimNext(lane?: TaskLane): FileTask | null {
    const mine = lane ? ` AND type ${lane === "media" ? "IN" : "NOT IN"} (${mediaTaskTypes.map(() => "?").join(", ")})` : "";
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const task = row<FileTask>(
        this.db.prepare(`SELECT * FROM tasks WHERE status = 'queued'${mine} ORDER BY created_at ASC LIMIT 1`).get(...(lane ? mediaTaskTypes : []))
      );
      if (!task) {
        this.db.exec("COMMIT");
        return null;
      }
      this.transition(task.id, "start");
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
      await taskKinds[task.type].run(this, task, actor);
      this.transition(task.id, "done");
      for (const change of taskChanges(this.db, task)) this.events.publish(change);
    } catch (error) {
      if (error instanceof TaskCancelledError || error instanceof RcloneJobStopped || error instanceof ConvertStopped) return;
      if (!this.transition(task.id, "fail", taskFailureMessage(error))) return;
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "task_failed",
        target: { taskId: task.id, type: task.type },
        result: "failure"
      });
    } finally {
      this.transition(task.id, "settle");
      this.cancelChecks.delete(task.id);
      this.db.prepare("UPDATE tasks SET pace_fps = NULL, pace_height = NULL WHERE id = ? AND pace_fps IS NOT NULL").run(task.id);
    }
  }

  /** What is in a folder, by its names in NFC: the way `assertNameAvailable` compares them. */
  private async entries(folder: SafePath): Promise<Map<string, FolderEntry>> {
    let found: FolderEntry[];
    if (isRemote(folder.root)) {
      const listed = await this.storage.remote.list(folder.root, folder.logicalPath);
      // Each listing is a round trip, so the folder is listed again only when a replacement had to be put right.
      found = (await recoverRemoteReplaced(this.storage.remote, folder, listed, LOADED_AT)) ? await this.storage.remote.list(folder.root, folder.logicalPath) : listed;
    } else {
      await recoverReplaced(folder.absolutePath, LOADED_AT);
      found = (await fsp.readdir(folder.absolutePath, { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() }));
    }
    return new Map(found.map((entry) => [nfc(entry.name), { name: entry.name, directory: entry.directory }]));
  }

  /** Whether the entry `name` of a folder is the source itself: on disk told by what it is, since two locations may show the one folder. */
  private async isItself(source: SafePath, folder: SafePath, name: string): Promise<boolean> {
    if (isRemote(source.root) || isRemote(folder.root)) return source.root.id === folder.root.id && source.logicalPath === path.posix.join(folder.logicalPath, name);
    const [one, other] = await Promise.all([fsp.lstat(source.absolutePath), fsp.lstat(path.join(folder.absolutePath, name))]);
    return one.dev === other.dev && one.ino === other.ino;
  }

  /** Whether the source lies inside the entry `name` of a folder, which then cannot make way for it. */
  private async holdsSource(source: SafePath, folder: SafePath, name: string): Promise<boolean> {
    if (isRemote(source.root) || isRemote(folder.root)) return source.root.id === folder.root.id && source.logicalPath.startsWith(`${path.posix.join(folder.logicalPath, name)}/`);
    return liesWithin(path.dirname(source.absolutePath), path.join(folder.absolutePath, name));
  }

  /**
   * Which of the sources would land on a name the destination already has, for whoever is about to copy or move
   * them to ask what is to be done, with what tells the two apart. `same` is a source found where it already is.
   */
  async transferConflicts(actor: Actor, input: z.infer<typeof transferCheckSchema>): Promise<{ conflicts: TransferConflict[] }> {
    const dest = await this.paths.resolveExisting(input.destination.rootSlug, input.destination.path);
    this.permissions.require(actor, "edit", dest.root, dest.logicalPath);
    const there = await this.entries(dest);
    const conflicts: TransferConflict[] = [];
    for (const ref of input.sources) {
      const source = await this.paths.resolveExisting(ref.rootSlug, ref.path);
      this.permissions.require(actor, "view", source.root, source.logicalPath);
      const name = this.storage.name(source);
      const occupant = there.get(nfc(name));
      if (!occupant) continue;
      const coming = await this.storage.stat(source);
      const held = isRemote(dest.root) ? await this.storage.remote.stat(dest.root, path.posix.join(dest.logicalPath, occupant.name)) : await fsp.lstat(path.join(dest.absolutePath, occupant.name));
      conflicts.push({
        rootSlug: ref.rootSlug,
        path: ref.path,
        name: nfc(name),
        kind: coming.isDirectory() ? "folder" : "file",
        size: coming.isDirectory() ? 0 : coming.size,
        mtime: coming.mtimeMs,
        existing: { kind: occupant.directory ? "folder" : "file", size: occupant.directory ? 0 : (held?.size ?? 0), mtime: held?.mtimeMs ?? 0 },
        same: await this.isItself(source, dest, occupant.name)
      });
    }
    return { conflicts };
  }

  /** How a source lands in a folder that may already have its name, going by what was chosen for that name. */
  private async landing(source: SafePath, directory: boolean, dest: SafePath, there: Map<string, FolderEntry>, conflicts: Conflicts, move: boolean): Promise<Landing> {
    const name = this.storage.name(source);
    const occupant = there.get(nfc(name));
    if (!occupant) return { mode: "new", name, directory };
    const action = conflicts[nfc(name)];
    if (!action) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
    // Onto itself there is nothing to carry, unless a second one is wanted beside it.
    if (await this.isItself(source, dest, occupant.name)) return { mode: action === "keep" && !move ? "keep" : "skip", name, directory };
    const merging = action.startsWith("merge_") ? (action.slice("merge_".length) as Clash) : null;
    // Only a folder goes into a folder; anything else that was to be merged is treated like a file inside one.
    const mergeable = directory && occupant.directory;
    const clash = merging && !mergeable ? merging : merging ? null : (action as Clash);
    if (clash === "skip" || clash === "keep") return { mode: clash, name, directory };
    if (occupant.directory && (await this.holdsSource(source, dest, occupant.name))) throw new AppError(409, "Cannot replace or merge into a folder that holds the source", "TARGET_HOLDS_SOURCE");
    return merging && mergeable ? { mode: "merge", name, directory, clash: merging, occupant } : { mode: "replace", name, directory, occupant };
  }

  async runCopyLike(task: FileTask, actor: Actor, move: boolean): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string; options?: { conflicts?: Conflicts } };
    const conflicts = destination.options?.conflicts ?? {};
    const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
    this.permissions.require(actor, "edit", dest.root, dest.logicalPath);
    const resolving = limiter(treeConcurrency);
    const resolved = await Promise.all(sources.map((source) => resolving(() => this.paths.resolveExisting(source.rootSlug, source.path))));
    // Anything with a remote end is carried by rclone, which reaches both sides itself.
    if (isRemote(dest.root) || resolved.some((source) => isRemote(source.root))) return this.runTransfer(task, actor, resolved, dest, move, conflicts);

    const operations: Array<{ safeSource: SafePath; landing: Landing; bytes: number; files: number }> = [];
    const targetPaths = new Set<string>();
    // Read once for all of them: what is there already.
    const there = await this.entries(dest);
    let totalBytes = 0;
    let totalFiles = 0;
    const found = this.counter(task.id);
    for (const safeSource of resolved) {
      this.permissions.require(actor, move ? "edit" : "view", safeSource.root, safeSource.logicalPath);
      // A location's top holds its trash, which is nobody's to carry elsewhere.
      if (move) this.assertNotFixed(safeSource);
      else if (safeSource.logicalPath === "/") throw new AppError(400, "Invalid path", "INVALID_PATH");
      this.assertNotFixed(dest, this.storage.name(safeSource));
      // A move is a rename wherever one is to be had, and what is renamed is one thing however much it holds: only
      // what turns out to need copying is added up, when it does. A copy reads everything, and is added up here.
      const stats = move ? { files: 1, bytes: 0 } : await collectPathStats(safeSource.absolutePath, found);
      // A folder with no file in it still counts as one thing to carry.
      const files = Math.max(stats.files, 1);
      totalBytes += stats.bytes;
      totalFiles += files;
      const target = path.join(dest.absolutePath, path.basename(safeSource.absolutePath));
      await assertTargetOutsideSource(safeSource.absolutePath, target);
      // Existing names are carried over as they are, so sources that only differ in normalisation still collide.
      if (targetPaths.has(nfc(target))) throw new AppError(409, "Multiple sources resolve to the same target", "TARGET_COLLISION");
      targetPaths.add(nfc(target));
      const landing = await this.landing(safeSource, (await fsp.lstat(safeSource.absolutePath)).isDirectory(), dest, there, conflicts, move);
      operations.push({ safeSource, landing, bytes: stats.bytes, files });
    }
    nameKept(operations.map((operation) => operation.landing), there);
    await this.updateTotals(task.id, totalFiles, totalBytes);

    const stored = new StoredNames(LOADED_AT);
    // The first thing a move cannot rename tells that the rest of it is to be copied too, and all of that is added
    // up then, in one go: each thing still to be moved stops standing for one and counts for the files it holds.
    let addedUp = !move;
    const addUpFrom = async (first: number) => {
      if (addedUp) return;
      addedUp = true;
      const found = this.counter(task.id);
      for (const operation of operations.slice(first)) {
        const stats = await collectPathStats(operation.safeSource.absolutePath, found);
        const files = Math.max(stats.files, 1);
        totalFiles += files - operation.files;
        totalBytes += stats.bytes - operation.bytes;
        operation.files = files;
        operation.bytes = stats.bytes;
      }
      await this.updateTotals(task.id, totalFiles, totalBytes);
    };
    for (const [index, operation] of operations.entries()) {
      const { safeSource, landing } = operation;
      await this.progress(task.id, safeSource.logicalPath);
      let countedFiles = 0;
      let countedBytes = 0;
      const beforeCopy = () => addUpFrom(index);
      const onFile = () => {
        countedFiles += 1;
        this.countFiles(task.id, 1);
      };
      const onBytes = (processedBytes: number) => {
        countedBytes += processedBytes;
        this.bumpProcessedBytes(task.id, processedBytes);
      };
      if (landing.mode !== "skip") {
        const target = path.join(dest.absolutePath, landing.name);
        const occupant = landing.occupant ? path.join(dest.absolutePath, landing.occupant.name) : target;
        if (landing.mode === "merge") await mergeTree(safeSource.absolutePath, occupant, landing.clash ?? "keep", move, stored, onBytes, onFile, beforeCopy);
        else if (landing.mode === "replace") await replacePath(safeSource.absolutePath, occupant, target, move, onBytes, onFile, beforeCopy);
        else if (move) await movePath(safeSource.absolutePath, target, onBytes, onFile, beforeCopy);
        else await copyTree(safeSource.absolutePath, target, onBytes, onFile);
        const movedTo = path.posix.join(dest.logicalPath, landing.name);
        if (move) this.preferences.moved(safeSource.root.id, safeSource.logicalPath, dest.root.id, movedTo);
        this.audit.write({
          actorType: "user",
          actorId: actor.id,
          action: move ? "move" : "copy",
          rootId: safeSource.root.id,
          path: safeSource.logicalPath,
          target: { rootSlug: destination.rootSlug, path: path.posix.join(destination.path, landing.name) },
          result: "success"
        });
      }
      // Whatever was not counted on the way: a folder renamed into place, the one an empty folder stands for, what was skipped.
      this.bumpProcessedBytes(task.id, operation.bytes - countedBytes);
      await this.bumpProcessed(task.id, operation.files - countedFiles);
    }
  }

  /** Copies or moves between locations of which at least one is remote. */
  private async runTransfer(task: FileTask, actor: Actor, sources: SafePath[], dest: SafePath, move: boolean, conflicts: Conflicts): Promise<void> {
    /** `name` is the source's own; where it lands, and under what name, is in `landing`. */
    type Operation = { source: SafePath; directory: boolean; name: string; files: number; landing: Landing };
    const operations: Operation[] = [];
    const names = new Set<string>();
    // Listed once for all of them: what is there already.
    const there = await this.entries(dest);
    let totalBytes = 0;
    let totalFiles = 0;
    const found = this.counter(task.id);
    for (const source of sources) {
      this.permissions.require(actor, move ? "edit" : "view", source.root, source.logicalPath);
      if (source.logicalPath === "/") throw new AppError(400, "Invalid path", "INVALID_PATH");
      if (move) this.assertNotFixed(source);
      this.assertNotFixed(dest, this.storage.name(source));
      this.assertNotIntoItself(source, dest);
      const stat = await this.storage.stat(source);
      const directory = stat.isDirectory();
      const name = this.storage.name(source);
      if (names.has(nfc(name))) throw new AppError(409, "Multiple sources resolve to the same target", "TARGET_COLLISION");
      names.add(nfc(name));
      const landing = await this.landing(source, directory, dest, there, conflicts, move);
      let size: PathStats;
      if (!isRemote(source.root)) size = await collectPathStats(source.absolutePath, found);
      else if (directory) {
        // The remote adds a folder up in one go, and says nothing until it has.
        found(0, 0);
        const measured = await this.storage.remote.size(source.root, source.logicalPath, true);
        size = { bytes: measured.bytes, files: measured.count };
        found(size.files, size.bytes);
      } else size = { bytes: stat.size, files: 1 };
      const files = Math.max(size.files, 1);
      totalBytes += size.bytes;
      totalFiles += files;
      operations.push({ source, directory, name, files, landing });
    }
    nameKept(operations.map((operation) => operation.landing), there);
    await this.updateTotals(task.id, totalFiles, totalBytes);

    // Files out of one folder go in one run of rclone, which carries several at a time; a folder is a run of its own.
    const batches: Operation[][] = [];
    const byFolder = new Map<string, Operation[]>();
    for (const operation of operations) {
      // The list rclone is handed has one name to a line, and lands each file under the name it has.
      if (operation.directory || operation.landing.mode !== "new" || operation.landing.name !== operation.name || /[\r\n]/.test(operation.name)) {
        batches.push([operation]);
        continue;
      }
      const folder = `${operation.source.root.id}\n${path.posix.dirname(operation.source.logicalPath)}`;
      const batch = byFolder.get(folder) ?? [];
      if (batch.length === 0) {
        byFolder.set(folder, batch);
        batches.push(batch);
      }
      batch.push(operation);
    }

    const to = this.rcloneAddress(dest);
    const settle = (operation: Operation) => {
      const movedTo = path.posix.join(dest.logicalPath, operation.landing.name);
      if (move) this.preferences.moved(operation.source.root.id, operation.source.logicalPath, dest.root.id, movedTo);
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: move ? "move" : "copy",
        rootId: operation.source.root.id,
        path: operation.source.logicalPath,
        target: { rootSlug: dest.root.slug, path: movedTo },
        result: "success"
      });
    };
    for (const batch of batches) {
      const { source, directory, landing } = batch[0]!;
      await this.progress(task.id, source.logicalPath);
      // Read before anything is carried, since a move takes the source away. What is merged into keeps its own.
      const tags = landing.mode === "skip" || landing.mode === "merge" ? [] : await this.storage.tags(batch.map((operation) => operation.source));
      const from = this.rcloneAddress(source);
      const files = batch.reduce((sum, operation) => sum + operation.files, 0);
      if (landing.mode === "skip") {
        await this.bumpProcessed(task.id, files);
        continue;
      }
      // Where it lands: in the folder that is there when it is merged into one, under its own name otherwise.
      const name = landing.mode === "merge" ? landing.occupant!.name : landing.name;
      const landsAt = { fs: to.fs, remote: to.remote ? `${to.remote}/${name}` : name };
      const folder = path.posix.dirname(source.logicalPath);
      const onBytes = transferProgress(
        (bytes) => this.countBytes(task.id, bytes),
        // rclone names what it is carrying from where its run starts: the folder the batch is out of.
        batch.length > 1 ? (carried) => this.show(task.id, path.posix.join(folder, carried)) : undefined
      );
      let countedFiles = 0;
      const onStats = (stats: RcloneStats) => {
        onBytes(stats);
        // Never past what was found beforehand, so the count cannot overtake its total.
        const done = Math.min(stats.transfers, files);
        this.countFiles(task.id, done - countedFiles);
        countedFiles = Math.max(countedFiles, done);
      };
      const stopped = () => this.isCancelled(task.id);
      const carrying = { _config: { Transfers: transferConcurrency } };
      // rclone leaves alone a file that looks like the one arriving, which where no times are kept is any of the same size.
      const replacing = { IgnoreTimes: true };
      const list = path.join(this.appDataDir, "temp", `transfer-${id("list")}`);
      /** The folder beside what it replaces that a replacement waits in until it is in its place, as on disk; see `replacePath`. */
      let staged: string | null = null;
      try {
        if (batch.length > 1) {
          await fsp.mkdir(path.dirname(list), { recursive: true });
          await fsp.writeFile(list, batch.map((operation) => `${operation.name}\n`).join(""), { mode: 0o600 });
          await this.storage.remote.client.runJob(
            move ? "sync/move" : "sync/copy",
            { srcFs: isRemote(source.root) ? joinFs(from.fs, path.posix.dirname(from.remote).replace(/^\.$/, "")) : from.fs, dstFs: joinFs(to.fs, to.remote), _filter: { FilesFromRaw: [list] }, ...carrying },
            onStats,
            stopped
          );
        } else {
          const occupant = landing.mode === "replace" ? landing.occupant! : null;
          const carry = async (at: { fs: string; remote: string }, moving: boolean, ontoCopy = false) => {
            if (directory) {
              const srcFs = joinFs(from.fs, from.remote);
              const dstFs = joinFs(at.fs, at.remote);
              const clash = landing.mode === "merge" ? landing.clash : "replace";
              // Listed before anything is carried, while it can still be told which files the two folders both have.
              const twice = clash === "keep" ? await this.sharedFiles(srcFs, dstFs) : null;
              await this.storage.remote.client.runJob(
                moving ? "sync/move" : "sync/copy",
                { srcFs, dstFs, createEmptySrcDirs: true, ...(moving ? { deleteEmptySrcDirs: true } : {}), _config: { ...carrying._config, ...(clash !== "replace" ? { IgnoreExisting: true } : landing.mode === "merge" ? replacing : {}) } },
                onStats,
                stopped
              );
              // What was left behind for having a namesake follows, each to a name of its own beside it.
              for (const file of twice?.files ?? []) {
                if (stopped()) throw new RcloneJobStopped();
                const beside = (candidate: string) => path.posix.join(path.posix.dirname(file), candidate);
                const kept = beside(freeName((candidate) => twice!.held.has(beside(candidate)), path.posix.basename(file), false));
                twice!.held.add(kept);
                await this.storage.remote.client.runJob(moving ? "operations/movefile" : "operations/copyfile", { srcFs, srcRemote: file, dstFs, dstRemote: kept }, () => undefined, stopped);
              }
              if (moving) {
                // The folders those files were holding open are empty now.
                if (twice?.files.length) await this.storage.remote.client.call("operations/rmdirs", { fs: srcFs, remote: "", leaveRoot: true }).catch(() => undefined);
                await this.storage.remote.clearMoved(from.fs, from.remote);
              }
            } else {
              await this.storage.remote.client.runJob(moving ? "operations/movefile" : "operations/copyfile", { srcFs: from.fs, srcRemote: from.remote, dstFs: at.fs, dstRemote: at.remote, ...(occupant && !ontoCopy ? { _config: replacing } : {}) }, onStats, stopped);
            }
          };
          // A file takes a file's place as it arrives, rclone letting go of the old one only once the new one is whole.
          // Anything else that is in the way has to go before its replacement can have its name, so that replacement
          // is copied whole into a folder of its own beside it first, and swapped in after. A moved source goes last:
          // what is left of it is moved onto the copy, which carries only what changed meanwhile.
          if (occupant && (directory || occupant.directory || occupant.name !== name)) {
            staged = `${REPLACE_PARTIAL}${Date.now()}-${id("temp")}`;
            await carry({ fs: to.fs, remote: path.posix.join(to.remote, staged, "new") }, false);
            await this.swapStaged(dest, staged, occupant, name, directory);
            staged = null;
            if (move) await carry(landsAt, true, true);
          } else await carry(landsAt, move);
        }
      } catch (error) {
        // A replacement that did not get into place takes its copy with it; the source is still whole. What was set
        // aside and could not go back stays in the folder it waits in, for the next run to put back.
        if (staged) {
          await this.removeTarget(dest, path.posix.join(staged, "new"), directory).catch(() => undefined);
          for (const left of [path.posix.join(to.remote, staged, "old"), path.posix.join(to.remote, staged)]) await this.storage.remote.clearMoved(to.fs, left);
        }
        // A run that stops half way has moved some of its files for good, and those are told like any other.
        if (move && batch.length > 1) {
          const left = await (isRemote(source.root) ? this.storage.remote.list(source.root, folder).then((entries) => entries.map((entry) => entry.name)) : fsp.readdir(from.fs)).catch(() => null);
          if (left) for (const operation of batch) if (!left.includes(operation.name)) settle(operation);
        }
        if (error instanceof RcloneJobStopped) {
          // Like a cancelled copy on disk, a cancelled copy to a remote takes its unfinished target with it, unless that was there before.
          if (!move) for (const operation of batch) if (!operation.landing.occupant) await this.removeTarget(dest, operation.landing.name, operation.directory).catch(() => undefined);
          throw new TaskCancelledError();
        }
        throw transferFailure(error);
      } finally {
        if (batch.length > 1) await fsp.rm(list, { force: true });
      }
      for (const [index, operation] of batch.entries()) {
        settle(operation);
        await this.storage.giveTags(dest, operation.landing.name, tags[index] ?? []);
      }
      // rclone counts no transfer for what the remote moved by itself, so the rest is counted once it is done.
      await this.bumpProcessed(task.id, files - countedFiles);
    }
  }

  /** The files two folders both have, as rclone names them, with everything the second one holds. */
  private async sharedFiles(srcFs: string, dstFs: string): Promise<{ files: string[]; held: Set<string> }> {
    const tree = async (fs: string) => (await this.storage.remote.client.call<{ list: RcloneItem[] }>("operations/list", { fs, remote: "", opt: { recurse: true } })).list;
    const [coming, there] = await Promise.all([tree(srcFs), tree(dstFs)]);
    const files = new Set(there.filter((item) => !item.IsDir).map((item) => item.Path));
    return { files: coming.filter((item) => !item.IsDir && files.has(item.Path)).map((item) => item.Path), held: new Set(there.map((item) => item.Path)) };
  }

  /** Refuses to make, replace, move or remove a location's top, its trash, or one of a server's shares; with `child`, to put that name beside `safe`. */
  /** `assertTargetOutsideSource` for locations that have no path on disk to compare. */
  private assertNotIntoItself(source: SafePath, dest: SafePath): void {
    if (this.paths.holds(source, dest)) throw new AppError(409, "Cannot copy or move a folder into itself", "TARGET_INSIDE_SOURCE");
  }

  private assertNotFixed(safe: SafePath, child?: string): void {
    const target = child === undefined ? safe.logicalPath : path.posix.join(safe.logicalPath, child);
    if (target === "/") throw new AppError(400, "Invalid path", "INVALID_PATH");
    if (isRemote(safe.root) && this.storage.remote.isFixed(safe.root, target)) throw sharesAreFixed();
    if (this.paths.isTrash(safe.root, target)) throw new AppError(400, "Invalid path", "INVALID_PATH");
  }

  /** A path as rclone is told it: the remote's name and a path in it, or the server's own disk. */
  private rcloneAddress(safe: SafePath): { fs: string; remote: string } {
    if (isRemote(safe.root)) return { fs: this.storage.remote.fs(safe.root), remote: this.storage.remote.rel(safe.logicalPath) };
    return { fs: path.dirname(safe.absolutePath), remote: path.basename(safe.absolutePath) };
  }

  /** Puts the replacement copied into the folder `staging` as `new` in the place of `occupant`, as `replacePath` does on disk. */
  private async swapStaged(folder: SafePath, staging: string, occupant: FolderEntry, name: string, directory: boolean): Promise<void> {
    if (isRemote(folder.root)) return swapInRemote(this.storage.remote, folder, staging, occupant, name, directory);
    const at = (...names: string[]) => path.join(folder.absolutePath, ...names);
    await fsp.mkdir(at(staging, "old"), { recursive: true });
    await swapIn(at(staging, "new"), at(occupant.name), at(staging, "old", occupant.name), at(name));
    await fsp.rm(at(staging), { recursive: true, force: true });
  }

  private async removeTarget(folder: SafePath, name: string, directory: boolean): Promise<void> {
    if (isRemote(folder.root)) await this.storage.remote.remove(folder.root, path.posix.join(folder.logicalPath, name), directory);
    else await fsp.rm(path.join(folder.absolutePath, name), { recursive: true, force: true });
  }

  async runTrash(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const operations = [];
    let totalBytes = 0;
    const found = this.counter(task.id);
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
      this.assertNotFixed(safe);
      // A folder renamed on its own disk is not read through here; the Trash adds it up afterwards, and one that is copied is counted as it goes.
      const measured = await this.trash.measure(safe, found);
      const bytes = await this.trash.carryBytes(safe, found, measured);
      totalBytes += bytes;
      operations.push({ safe, bytes, measured });
    }
    await this.updateTotals(task.id, operations.length, totalBytes);

    for (const { safe, bytes, measured } of operations) {
      await this.progress(task.id, safe.logicalPath);
      const streamed = await this.trash.place(actor, safe, task.id, measured, (processedBytes) => this.bumpProcessedBytes(task.id, processedBytes));
      await this.bumpProcessed(task.id);
      if (!streamed) this.bumpProcessedBytes(task.id, bytes);
    }
  }

  /** Throws one file away in the middle of other work, the way `runTrash` does a list of them. */
  private async trashNow(actor: Actor, safe: SafePath, taskId: string): Promise<void> {
    this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
    this.assertNotFixed(safe);
    await this.trash.place(actor, safe, taskId);
  }

  /** The folder something is restored into, made again, with any folder above it, when it has gone since. */
  private async restoreFolder(root: Root, logicalPath: string): Promise<SafePath> {
    try {
      return await this.paths.resolveRootById(root.id, logicalPath);
    } catch (error) {
      if (logicalPath === "/" || !(error instanceof AppError && error.code === "PATH_NOT_FOUND")) throw error;
    }
    const parent = await this.restoreFolder(root, path.posix.dirname(logicalPath));
    const name = nfc(path.posix.basename(logicalPath));
    this.assertNotFixed(parent, name);
    if (isRemote(root)) await this.storage.remote.mkdir(root, path.posix.join(parent.logicalPath, name));
    else
      await fsp.mkdir(path.join(parent.absolutePath, name)).catch((error: unknown) => {
        if (!errnoIs(error, "EEXIST")) throw error;
      });
    return this.paths.resolveRootById(root.id, path.posix.join(parent.logicalPath, name));
  }

  /**
   * The name something is restored under: its own, or, when something has taken that meanwhile, one beside it the
   * way a copy kept beside its namesake is named. Names that differ only in case count as taken, as a volume that
   * does not mind the case cannot hold both.
   */
  private async restoredName(folder: SafePath, name: string, directory: boolean): Promise<string> {
    const key = (value: string) => nfc(value).toLowerCase();
    const taken = new Set((await this.storage.names(folder)).map(key));
    return taken.has(key(name)) ? freeName((candidate) => taken.has(key(candidate)), nfc(name), directory) : name;
  }

  async runRestore(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    let totalBytes = 0;
    const found = this.counter(task.id);
    for (const source of sources) {
      const item = this.trash.getRestorable(actor, source.path);
      const { root } = await this.paths.resolveRootById(item.original_root_id, "/");
      if (isRemote(root)) continue;
      await assertRealPathInside(this.trash.requireDirOf(root, item.trash_path), item.trash_path);
      totalBytes += await bytesToCarry(item.trash_path, await nearestFolder(path.join(root.base_path, path.posix.dirname(item.original_path))), found);
    }
    await this.updateTotals(task.id, sources.length, totalBytes);

    for (const source of sources) {
      const item = this.trash.getRestorable(actor, source.path);
      await this.progress(task.id, item.original_path);
      const { root } = await this.paths.resolveRootById(item.original_root_id, "/");
      const folder = path.posix.dirname(item.original_path);
      const name = path.posix.basename(item.original_path);
      // Asked before any folder that has gone is made again, and once more of the folder as it is spelled now.
      this.permissions.require(actor, "edit", root, folder);
      if (isRemote(root)) {
        const trashed = this.storage.remote.isTrashItem(root, item.trash_path) ? await this.storage.remote.stat(root, item.trash_path) : null;
        if (!trashed) throw new AppError(404, "Trash item not found", "TRASH_ITEM_NOT_FOUND");
        const safe = await this.restoreFolder(root, folder);
        this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
        const restoredAs = await this.restoredName(safe, name, trashed.directory);
        await this.storage.remote.move(safe.root, item.trash_path, path.posix.join(safe.logicalPath, restoredAs), trashed.directory);
        this.trash.markRestored(item.id);
        this.audit.write({ actorType: "user", actorId: actor.id, action: "restore_trash", rootId: item.original_root_id, path: item.original_path, result: "success" });
        await this.bumpProcessed(task.id);
        continue;
      }
      await assertRealPathInside(this.trash.requireDirOf(root, item.trash_path), item.trash_path);
      const safe = await this.restoreFolder(root, folder);
      this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
      const target = path.join(safe.absolutePath, await this.restoredName(safe, name, (await fsp.lstat(item.trash_path)).isDirectory()));
      const bytes = await bytesToCarry(item.trash_path, safe.absolutePath);
      const streamed = await movePath(item.trash_path, target, (processedBytes) => this.bumpProcessedBytes(task.id, processedBytes));
      this.trash.markRestored(item.id);
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "restore_trash",
        rootId: item.original_root_id,
        path: item.original_path,
        result: "success"
      });
      if (!streamed) this.bumpProcessedBytes(task.id, bytes);
      await this.bumpProcessed(task.id);
    }
  }

  /** Deletes for good, without the detour through the trash: for what would take long to carry there. */
  async runDelete(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const operations = [];
    let total = 0;
    const found = this.counter(task.id);
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
      this.assertNotFixed(safe);
      // A remote removes a folder in one go, and counts as one. A local one is counted by what it holds, to be told of as it goes.
      const entries = isRemote(safe.root) ? 1 : await countEntries(safe.absolutePath, found);
      total += entries;
      operations.push({ safe, entries });
    }
    await this.updateTotals(task.id, total, 0);
    for (const { safe, entries } of operations) {
      await this.progress(task.id, safe.logicalPath);
      let counted = 0;
      if (isRemote(safe.root)) await this.storage.remote.remove(safe.root, safe.logicalPath, (await this.storage.stat(safe)).isDirectory());
      else
        await removeTree(safe.absolutePath, () => {
          this.assertNotCancelled(task.id);
          counted += 1;
          this.countFiles(task.id, 1);
        });
      // What was counted and had gone by the time it was its turn.
      await this.bumpProcessed(task.id, entries - counted);
      this.audit.write({ actorType: "user", actorId: actor.id, action: "delete", rootId: safe.root.id, path: safe.logicalPath, result: "success" });
    }
  }

  async runCompress(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string; options?: CompressOptions };
    const { level, encryption, password } = destination.options ?? {};
    const dest = await this.paths.resolveForCreate(destination.rootSlug, destination.path);
    this.permissions.require(actor, "edit", dest.root, path.posix.dirname(dest.logicalPath));
    const folder = await this.paths.resolveExisting(destination.rootSlug, path.posix.dirname(dest.logicalPath));
    await this.storage.assertNameAvailable(folder, this.storage.name(dest));
    const zipped = await this.zipSources(task, actor, "view", dest, {
      level: level ? zipLevels[level] : undefined,
      encryption,
      password: password ? this.secrets().open(password) : undefined
    });
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "compress",
      rootId: dest.root.id,
      path: dest.logicalPath,
      target: { taskId: task.id, sources: zipped.sources, level, encryption: password ? encryption : undefined },
      result: "success"
    });
    if (password) this.forgetPassword(task.id, { ...destination, options: { level, encryption } });
  }

  /** A task that failed keeps its sealed password, so that trying it again does the same thing; one that is done has no more use for it. */
  private forgetPassword(taskId: string, destination: object): void {
    this.db.prepare("UPDATE tasks SET destination = ? WHERE id = ?").run(JSON.stringify(destination), taskId);
  }

  /** Zips a selection into Kago's own temp dir so a multi-file download leaves nothing behind in the user's folders. */
  async runDownloadZip(task: FileTask, actor: Actor): Promise<void> {
    const target = this.downloadPath(task.id);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const zipped = await this.zipSources(task, actor, "view", target);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "download_zip",
      target: { taskId: task.id, sources: zipped.sources },
      result: "success"
    });
  }

  /** `target` is a file on the server's disk, or the path of the archive in a location. */
  private async zipSources(task: FileTask, actor: Actor, sourceLevel: Level, target: string | SafePath, options: ZipOptions = {}): Promise<ZipSourcesResult> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const resolved: SafePath[] = [];
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, sourceLevel, safe.root, safe.logicalPath);
      resolved.push(safe);
    }
    return this.zipSourcesStreamed(task, resolved, target, actor, sourceLevel, options);
  }

  /** The archive is planned whole before it is written; file data stays streamed from its source. */
  private async zipSourcesStreamed(task: FileTask, sources: SafePath[], target: string | SafePath, actor: Actor, sourceLevel: Level, options: ZipOptions): Promise<ZipSourcesResult> {
    const operations: PlannedZipSource[] = [];
    const taken = new Set<string>();
    let totalBytes = 0;
    const found = this.counter(task.id);
    const addEntry = (safe: SafePath, logicalPath: string, name: string, directory: boolean, size: number, mtime: Date, absolutePath?: string) => {
      const entry: ZipEntry = { name, open: async () => Readable.from([]), directory, size, mtime };
      if (!directory) totalBytes += size;
      found(directory ? 0 : 1, size);
      return { entry, safe, logicalPath, absolutePath } satisfies PlannedZipEntry;
    };

    for (const safe of sources) {
      this.permissions.require(actor, sourceLevel, safe.root, safe.logicalPath);
      const base = nfc(this.storage.name(safe));
      let name = base;
      for (let copy = 2; taken.has(name); copy += 1) name = `${path.parse(base).name} ${copy}${path.parse(base).ext}`;
      taken.add(name);

      const entries: PlannedZipEntry[] = [];
      if (isRemote(safe.root)) {
        const rootEntry = await this.storage.stat(safe);
        if (!rootEntry) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
        entries.push(addEntry(safe, safe.logicalPath, name, rootEntry.isDirectory(), rootEntry.isDirectory() ? 0 : rootEntry.size, rootEntry.mtime));
        if (rootEntry.isDirectory()) {
          // The remote lists a folder in one go, and says nothing until it has.
          found(0, 0);
          for (const child of await this.storage.remote.walk(safe.root, safe.logicalPath)) {
            const segments = safeRelativeZipPath(child.path);
            if (!segments || segments.length === 0) continue;
            entries.push(addEntry(
              safe,
              path.posix.join(safe.logicalPath, ...segments),
              `${name}/${segments.map(nfc).join("/")}`,
              child.directory,
              child.directory ? 0 : child.size,
              new Date(child.mtimeMs)
            ));
          }
        }
      } else {
        const collectLocal = async (absolutePath: string, logicalPath: string, entryName: string): Promise<void> => {
          const stat = await fsp.lstat(absolutePath);
          if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return;
          const directory = stat.isDirectory();
          entries.push(addEntry(safe, logicalPath, entryName, directory, directory ? 0 : stat.size, stat.mtime, absolutePath));
          if (!directory) return;
          for (const child of (await fsp.readdir(absolutePath)).sort()) {
            if (!isSafeLogicalSegment(child) || this.paths.isTrash(safe.root, path.posix.join(logicalPath, child))) continue;
            const normalized = nfc(child);
            await collectLocal(path.join(absolutePath, child), path.posix.join(logicalPath, normalized), `${entryName}/${normalized}`);
          }
        };
        await collectLocal(safe.absolutePath, safe.logicalPath, name);
      }
      operations.push({ safe, entries });
    }

    await this.updateTotals(task.id, operations.length, totalBytes);
    const service = this;
    async function* entries(): AsyncGenerator<ZipEntry> {
      for (const operation of operations) {
        await service.progress(task.id, operation.safe.logicalPath);
        for (const planned of operation.entries) {
          yield {
            ...planned.entry,
            open: async () => {
              // The archive can take a long while to write, and the rule that allowed it may be gone by now.
              service.permissions.require(actor, sourceLevel, planned.safe.root, planned.logicalPath);
              service.show(task.id, planned.logicalPath);
              let source: Readable;
              if (planned.absolutePath) {
                const stat = await fsp.lstat(planned.absolutePath);
                if (stat.isSymbolicLink() || !stat.isFile()) throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
                const handle = await fsp.open(planned.absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
                if (!(await handle.stat()).isFile()) {
                  await handle.close();
                  throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
                }
                source = handle.createReadStream();
              } else {
                const stat = await service.storage.remote.stat(planned.safe.root, planned.logicalPath);
                if (!stat || stat.directory) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
                source = await service.storage.remote.open(planned.safe.root, planned.logicalPath);
              }
              return Readable.from((async function* () {
                for await (const chunk of source) {
                  await service.bumpProcessedBytes(task.id, Buffer.byteLength(chunk));
                  yield chunk;
                }
              })());
            }
          };
        }
        await service.bumpProcessed(task.id);
      }
    }

    const archive = Readable.from(zipStream(entries(), options));
    if (typeof target !== "string" && isRemote(target.root)) await this.storage.remote.write(target.root, target.logicalPath, archive);
    else {
      const targetPath = typeof target === "string" ? target : target.absolutePath;
      try {
        await pipeline(archive, createWriteStream(targetPath, { flags: "wx" }));
      } catch (error) {
        // A file that was in the way is someone's, not a half-written archive.
        if (errnoIs(error, "EEXIST")) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
        await fsp.rm(targetPath, { force: true });
        throw error;
      }
    }
    return { sources: sources.map((safe) => ({ rootSlug: safe.root.slug, path: safe.logicalPath })) };
  }

  /** The finished archive of a `download_zip` task, for someone who may still see where it came from. */
  async openDownload(actor: Actor, taskId: string): Promise<{ path: string; size: number; fileName: string }> {
    const task = this.getForActor(actor, taskId);
    if (task.type !== "download_zip" || task.status !== "done") {
      throw new AppError(409, "Task has no download", "TASK_DOWNLOAD_NOT_READY");
    }
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    for (const rootSlug of new Set(sources.map((source) => source.rootSlug))) {
      const safe = await this.paths.resolveExisting(rootSlug, "/");
      this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    }
    const filePath = this.downloadPath(task.id);
    let size: number;
    try {
      size = (await fsp.stat(filePath)).size;
    } catch (error) {
      if (errnoIs(error, "ENOENT")) throw new AppError(410, "Download has expired", "TASK_DOWNLOAD_EXPIRED");
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

  async runExtract(task: FileTask, actor: Actor): Promise<void> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = JSON.parse(task.destination ?? "{}") as { rootSlug: string; path: string; options?: ExtractOptions };
    const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
    this.permissions.require(actor, "edit", dest.root, dest.logicalPath);
    // What was typed for this archive goes first, then whatever the person keeps for archives in general.
    const given = destination.options?.password ? this.secrets().open(destination.options.password) : undefined;
    const passwords = [...new Set([...(given === undefined ? [] : [given]), ...this.archivePasswords.reveal(actor.id)])];
    let totalFiles = 0;
    let totalBytes = 0;
    let totalEntries = 0;
    const archives: Array<{ path: string; password?: string }> = [];
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "view", safe.root, safe.logicalPath);
      // Remote archives are staged to disk by storage.localFile; yauzl reads the local archive by ranges.
      // A remote archive is fetched whole before it can be read, and nothing counts on the way.
      if (isRemote(safe.root)) this.setTotals(task.id, 1, 0, "preparing");
      const archivePath = await this.storage.localFile(safe, await this.storage.stat(safe));
      const zip = await openZipArchive(archivePath);
      let stats: { totalFiles: number; totalBytes: number; totalEntries: number; password?: string };
      try {
        stats = await this.validateExtractEntries(zip, passwords, given !== undefined);
      } catch (error) {
        throw mapZipArchiveError(error);
      } finally {
        if (zip.isOpen) zip.close();
      }
      totalEntries += stats.totalEntries;
      if (totalEntries > maxExtractEntries) throw new AppError(413, "Zip contains too many entries", "ZIP_ENTRY_LIMIT");
      totalFiles += stats.totalFiles;
      totalBytes += stats.totalBytes;
      archives.push({ path: archivePath, password: stats.password });
    }
    await this.updateTotals(task.id, Math.max(totalFiles, 1), totalBytes);

    const storedNames = new StoredNames(LOADED_AT);
    let remainingBytes = maxExtractBytes;
    for (const archive of archives) {
      const zip = await openZipArchive(archive.path);
      try {
        let entryCount = 0;
        for await (const entry of zip.eachEntry()) {
          entryCount += 1;
          if (entryCount > maxExtractEntries) throw new AppError(413, "Zip contains too many entries", "ZIP_ENTRY_LIMIT");
          // Where it will land in the location, never the name as the archive spells it, which an unsafe entry can bend.
          const landing = safeRelativeZipPath(entry.fileName);
          await this.progress(task.id, landing ? path.posix.join(dest.logicalPath, ...landing.map(nfc)) : dest.logicalPath);
          if (isZipSymlink(entry)) throw new AppError(400, "Symlink zip entries are not allowed", "ZIP_SYMLINK_FORBIDDEN");
          const processedBytes = isRemote(dest.root)
            ? await this.extractEntryRemote(entry, zip, dest, remainingBytes, archive.password)
            : await this.extractEntry(entry, zip, dest, storedNames, remainingBytes, archive.password);
          remainingBytes -= processedBytes;
          await this.bumpProcessedBytes(task.id, processedBytes);
          await this.bumpProcessed(task.id);
        }
      } catch (error) {
        throw mapZipArchiveError(error);
      } finally {
        if (zip.isOpen) zip.close();
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
    if (given !== undefined) {
      if (destination.options?.remember && archives.some((archive) => archive.password === given)) this.archivePasswords.add(actor.id, { password: given, note: "" });
      this.forgetPassword(task.id, { ...destination, options: {} });
    }
  }

  /** Also settles which of `passwords` opens the archive, by the few bytes each locked entry is checked with, before anything is written. */
  private async validateExtractEntries(zip: yauzl.ZipFile, passwords: string[], given: boolean): Promise<{ totalFiles: number; totalBytes: number; totalEntries: number; password?: string }> {
    let totalBytes = 0;
    let totalFiles = 0;
    let totalEntries = 0;
    let locked = false;
    const probes: Array<{ entry: yauzl.Entry; cipher: ZipCipher; head: Buffer }> = [];
    for await (const entry of zip.eachEntry()) {
      totalEntries += 1;
      if (totalEntries > maxExtractEntries) throw new AppError(413, "Zip contains too many entries", "ZIP_ENTRY_LIMIT");
      this.safeZipEntrySegments(entry);
      if (isZipSymlink(entry)) throw new AppError(400, "Symlink zip entries are not allowed", "ZIP_SYMLINK_FORBIDDEN");
      if (entry.isEncrypted() && !isZipDirectory(entry)) {
        const cipher = zipCipherOf(entry);
        if (!cipher) throw new AppError(400, "Unsupported zip entry", "INVALID_ZIP_ENTRY");
        locked = true;
        if (probes.length < maxPasswordProbes) probes.push({ entry, cipher, head: await readZipCipherHead(zip, entry, cipher) });
      } else if (!entry.isEncrypted() && !entry.canDecodeFileData()) {
        throw new AppError(400, "Unsupported zip entry", "INVALID_ZIP_ENTRY");
      }
      if (!isZipDirectory(entry)) {
        if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
          throw new AppError(400, "Invalid zip entry size", "INVALID_ZIP_ENTRY");
        }
        totalFiles += 1;
        totalBytes += entry.uncompressedSize;
        if (totalBytes > maxExtractBytes) throw new AppError(413, "Zip is too large to extract", "ZIP_SIZE_LIMIT");
      }
    }
    const password = locked ? passwords.find((candidate) => probes.every((probe) => zipPasswordFits(probe.entry, probe.cipher, probe.head, candidate))) : undefined;
    if (locked && password === undefined) {
      throw given ? new AppError(400, "Wrong archive password", "ZIP_PASSWORD_WRONG") : new AppError(400, "Archive password required", "ZIP_PASSWORD_REQUIRED");
    }
    return { totalFiles: Math.max(totalFiles, 1), totalBytes, totalEntries, password };
  }

  private async openZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, password: string | undefined): Promise<Readable> {
    if (!entry.isEncrypted()) return zip.openReadStreamPromise(entry);
    const cipher = zipCipherOf(entry);
    if (!cipher || password === undefined) throw new AppError(400, "Unsupported zip entry", "INVALID_ZIP_ENTRY");
    return openEncryptedZipEntry(zip, entry, cipher, password);
  }

  private async extractEntry(entry: yauzl.Entry, zip: yauzl.ZipFile, dest: SafePath, storedNames: StoredNames, remainingBytes: number, password?: string): Promise<number> {
    const segments = this.safeZipEntrySegments(entry);
    if (this.paths.isTrash(dest.root, path.posix.join(dest.logicalPath, ...segments))) throw new AppError(400, "Unsafe zip entry", "UNSAFE_ZIP_ENTRY");
    const destinationPath = dest.absolutePath;
    const fileName = isZipDirectory(entry) ? undefined : segments.pop()!;
    // Folders merge into the one already there, spelled as it is stored; a file never lands beside its NFC/NFD twin.
    const resolved: string[] = [];
    let folder = destinationPath;
    for (const segment of segments) {
      const stored = (await storedNames.find(folder, segment)) ?? segment;
      await storedNames.add(folder, stored);
      resolved.push(stored);
      folder = path.join(folder, stored);
    }
    if (fileName !== undefined) {
      if (await storedNames.find(folder, fileName)) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
      await storedNames.add(folder, fileName);
      resolved.push(fileName);
    }
    const target = safeJoin(destinationPath, resolved);
    if (isZipDirectory(entry)) {
      await assertNoExistingSymlinkSegments(destinationPath, target);
      await fsp.mkdir(target, { recursive: true });
      await assertRealPathInside(destinationPath, target);
      return 0;
    }
    const parent = path.dirname(target);
    await assertNoExistingSymlinkSegments(destinationPath, parent);
    await fsp.mkdir(parent, { recursive: true });
    await assertRealPathInside(destinationPath, parent);
    const limit = Math.min(remainingBytes, entry.uncompressedSize);
    if (entry.uncompressedSize > remainingBytes) throw new AppError(413, "Zip is too large to extract", "ZIP_SIZE_LIMIT");
    let written = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        if (written > limit) done(new AppError(413, "Zip is too large to extract", "ZIP_SIZE_LIMIT"));
        else done(null, chunk);
      }
    });
    try {
      await pipeline(await this.openZipEntry(zip, entry, password), bounded, createWriteStream(target, { flags: "wx", mode: 0o666 }));
    } catch (error) {
      // A volume that does not mind the case can hold the name under another spelling, which is not ours to take away.
      if (errnoIs(error, "EEXIST")) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
      await fsp.rm(target, { force: true });
      throw error;
    }
    return written;
  }

  private async extractEntryRemote(entry: yauzl.Entry, zip: yauzl.ZipFile, dest: SafePath, remainingBytes: number, password?: string): Promise<number> {
    const segments = this.safeZipEntrySegments(entry);
    const target = path.posix.join(dest.logicalPath, ...segments);
    if (this.storage.remote.isTrash(dest.root, target)) throw new AppError(400, "Unsafe zip entry", "UNSAFE_ZIP_ENTRY");
    if (this.storage.remote.isFixed(dest.root, target)) throw sharesAreFixed();
    if (isZipDirectory(entry)) {
      await this.storage.remote.mkdir(dest.root, target);
      return 0;
    }
    if (await this.storage.remote.stat(dest.root, target)) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
    const limit = Math.min(remainingBytes, entry.uncompressedSize);
    if (entry.uncompressedSize > remainingBytes) throw new AppError(413, "Zip is too large to extract", "ZIP_SIZE_LIMIT");
    let written = 0;
    const bounded = new Transform({
      transform(chunk: Buffer, _encoding, done) {
        written += chunk.length;
        if (written > limit) done(new AppError(413, "Zip is too large to extract", "ZIP_SIZE_LIMIT"));
        else done(null, chunk);
      }
    });
    const input = await this.openZipEntry(zip, entry, password);
    const output = new PassThrough();
    const extraction = pipeline(input, bounded, output);
    try {
      await this.storage.remote.write(dest.root, target, output);
      await extraction;
    } catch (error) {
      input.destroy();
      output.destroy();
      const failure = await extraction.then(() => error, (reason: unknown) => reason);
      // Only at its end is an entry known to have been unlocked with the wrong password; by then it is all there.
      if (failure instanceof ZipPasswordError) {
        await this.storage.remote.remove(dest.root, target, false).catch(() => undefined);
        throw failure;
      }
      throw error;
    }
    return written;
  }

  private safeZipEntrySegments(entry: yauzl.Entry): string[] {
    // Archives made on macOS carry NFD names; extracted files are new, so they are written in NFC.
    const name = nfc(zipEntryName(entry).replaceAll("\\", "/"));
    if (!name || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:\//.test(name)) {
      throw new AppError(400, "Unsafe zip entry", "UNSAFE_ZIP_ENTRY");
    }
    const segments = name.split("/").filter(Boolean);
    // Kago clears away or moves back what it finds under its own names, so no archive may plant one.
    if (segments.length === 0 || segments.some((segment) => segment === "." || segment === ".." || isReservedName(segment))) {
      throw new AppError(400, "Unsafe zip entry", "UNSAFE_ZIP_ENTRY");
    }
    return segments;
  }

  /** Whether the actor may run this sync as things stand. */
  async assertSync(actor: Actor, spec: SyncSpec): Promise<void> {
    await this.assertSyncPermissions(actor, spec);
  }

  /** Checks again what a run of a sync was allowed when it was queued. */
  async assertSyncTask(actor: Actor, task: FileTask): Promise<void> {
    await this.assertSyncPermissions(actor, syncSpecOf(task));
  }

  /** Checks both ends of a sync and returns the folders they are. */
  private async assertSyncPermissions(actor: Actor, spec: SyncSpec): Promise<{ source: SafePath; destination: SafePath }> {
    const folder = async (endpoint: SyncEndpoint): Promise<SafePath> => {
      const safe = await this.paths.resolveExisting(endpoint.rootSlug, endpoint.path);
      if (!(await this.storage.stat(safe)).isDirectory()) throw new AppError(400, "Path is not a folder", "NOT_FOLDER");
      return safe;
    };
    const source = await folder(spec.source);
    const destination = await folder(spec.destination);
    this.permissions.require(actor, "view", source.root, source.logicalPath);
    this.permissions.require(actor, "edit", destination.root, destination.logicalPath);
    // What lands in the destination would be new shares if it were the top of a whole server.
    this.assertNotFixed(destination, "new");
    if (await this.paths.overlap(source, destination)) throw new AppError(400, "The source and the destination overlap", "SYNC_OVERLAP");
    return { source, destination };
  }

  async runSync(task: FileTask, actor: Actor): Promise<void> {
    const spec = syncSpecOf(task);
    const { source, destination } = await this.assertSyncPermissions(actor, spec);
    await this.progress(task.id, source.logicalPath);
    const mirror = spec.options.mode === "mirror";
    const stopped = () => this.isCancelled(task.id);
    // rclone names what it carries from the folder the run starts in: the source.
    const onBytes = transferProgress((bytes) => this.countBytes(task.id, bytes), (carried) => this.show(task.id, path.posix.join(source.logicalPath, carried)));
    // A trial run changes nothing; what it would have changed is what it leaves behind. Of a real run only the counts are kept.
    const trial = spec.options.dryRun;
    const report = trial ? new SyncReport() : new SyncReport(0);

    const from = this.rcloneAddress(source);
    const to = this.rcloneAddress(destination);
    let total = 0;
    // Where times cannot be kept, a file of the same size is taken to have changed when the source's is the newer.
    const byAge = isRemote(destination.root) && (await this.storage.remote.keepsNoTimes(destination.root));
    // A remote location's trash is Kago's own business at either end.
    const excluded = [`/${TRASH_FOLDER}/**`, `/*/${TRASH_FOLDER}/**`];
    try {
      if (trial) {
        await runRclone(
          this.appDataDir,
          [
            mirror ? "sync" : "copy",
            "--dry-run",
            "--create-empty-src-dirs",
            ...(byAge ? ["--update", "--use-server-modtime"] : []),
            ...excluded.flatMap((rule) => ["--exclude", rule]),
            "--",
            joinFs(from.fs, from.remote),
            joinFs(to.fs, to.remote)
          ],
          (entry) => report.addRcloneLog(entry),
          stopped
        );
      } else {
        await this.storage.remote.client.runJob(
          mirror ? "sync/sync" : "sync/copy",
          {
            srcFs: joinFs(from.fs, from.remote),
            dstFs: joinFs(to.fs, to.remote),
            createEmptySrcDirs: true,
            _config: byAge ? { UpdateOlder: true, UseServerModTime: true } : {},
            _filter: { ExcludeRule: excluded }
          },
          (stats) => {
            if (stats.totalBytes > total) {
              total = stats.totalBytes;
              this.setTotalBytes(task.id, total);
            }
            onBytes(stats);
            // The last of these is the whole of the job.
            report.countRcloneStats(stats);
          },
          stopped
        );
      }
    } catch (error) {
      if (error instanceof RcloneJobStopped) throw new TaskCancelledError();
      throw transferFailure(error);
    }
    this.db
      .prepare("INSERT OR REPLACE INTO task_reports (task_id, summary_json, stats_json, changes_json) VALUES (?, ?, ?, ?)")
      .run(task.id, JSON.stringify({ ...report.summary, truncated: report.truncated }), JSON.stringify(report.stats()), JSON.stringify(report.changes));
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "sync",
      rootId: destination.root.id,
      path: destination.logicalPath,
      target: { taskId: task.id, jobId: spec.jobId, mode: spec.options.mode, dryRun: spec.options.dryRun },
      result: "success"
    });
    await this.bumpProcessed(task.id);
  }

  private setTotalBytes(taskId: string, totalBytes: number): void {
    this.db.prepare("UPDATE tasks SET total_bytes = ?, updated_at = ? WHERE id = ?").run(totalBytes, now(), taskId);
    this.events.publish({ type: "task.progress", userId: this.get(taskId).created_by, taskId, patch: { total_bytes: totalBytes } });
  }

  async runThumbnail(task: FileTask, actor: Actor): Promise<void> {
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
      this.permissions.require(actor, "edit", dest.root, dest.logicalPath);
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, input.type === "move" ? "edit" : "view", safe.root, safe.logicalPath);
        if (input.type === "move") this.assertNotFixed(safe);
        else if (safe.logicalPath === "/") throw new AppError(400, "Invalid path", "INVALID_PATH");
        this.assertNotFixed(dest, this.storage.name(safe));
        if (isRemote(safe.root) || isRemote(dest.root)) this.assertNotIntoItself(safe, dest);
        else await assertTargetOutsideSource(safe.absolutePath, path.join(dest.absolutePath, path.basename(safe.absolutePath)));
      }
      return;
    }

    if (input.type === "delete_to_trash" || input.type === "delete") {
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
        this.assertNotFixed(safe);
      }
      return;
    }

    if (input.type === "empty_trash") {
      // Which of them are the actor's to remove is asked of each as its turn comes.
      if (input.sources.some((source) => source.rootSlug !== "trash")) throw new AppError(404, "Trash item not found", "TRASH_ITEM_NOT_FOUND");
      return;
    }

    if (input.type === "restore_trash") {
      for (const source of input.sources) {
        if (source.rootSlug !== "trash") throw new AppError(400, "Invalid restore source", "INVALID_RESTORE_SOURCE");
        const item = this.trash.getRestorable(actor, source.path);
        await this.requireRestorePermission(actor, item);
      }
      return;
    }

    if (input.type === "compress") {
      const destination = this.requiredDestination(input);
      const dest = await this.paths.resolveForCreate(destination.rootSlug, destination.path);
      const parentLogicalPath = path.posix.dirname(dest.logicalPath);
      const permissionPath = parentLogicalPath === "." ? "/" : parentLogicalPath;
      this.permissions.require(actor, "edit", dest.root, permissionPath);
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "view", safe.root, safe.logicalPath);
      }
      return;
    }

    if (input.type === "download_zip") {
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "view", safe.root, safe.logicalPath);
      }
      return;
    }

    if (input.type === "extract") {
      const destination = this.requiredDestination(input);
      const dest = await this.paths.resolveExisting(destination.rootSlug, destination.path);
      this.permissions.require(actor, "edit", dest.root, dest.logicalPath);
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "view", safe.root, safe.logicalPath);
      }
      return;
    }

    if (input.type === "thumbnail") {
      for (const source of input.sources) {
        const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
        this.permissions.require(actor, "view", safe.root, safe.logicalPath);
      }
    }
  }

  private requiredDestination(input: z.infer<typeof taskInputSchema>): { rootSlug: string; path: string } {
    if (!input.destination) throw new AppError(400, "Destination required", "DESTINATION_REQUIRED");
    return input.destination;
  }

  private async requireRestorePermission(actor: Actor, item: RestorableTrashItem): Promise<void> {
    const parentPath = path.posix.dirname(item.original_path);
    // The folder may have gone since, and is then made again where it was.
    const { root } = await this.paths.resolveRootById(item.original_root_id, "/");
    this.permissions.require(actor, "edit", root, parentPath === "." ? "/" : parentPath);
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

  /** Names what the task is busy with, without asking whether it goes on. */
  private show(taskId: string, currentPath: string): void {
    this.progressBuffer(taskId).currentPath = currentPath;
    this.flushProgress(taskId);
  }

  private async bumpProcessed(taskId: string, files = 1): Promise<void> {
    this.assertNotCancelled(taskId);
    const buffer = this.progressBuffer(taskId);
    buffer.processedFiles += Math.max(files, 0);
    this.flushProgress(taskId);
  }

  /** Adds to the files done without asking whether the task goes on, as `countBytes` does for bytes. */
  private countFiles(taskId: string, files: number): void {
    if (files <= 0) return;
    const buffer = this.progressBuffer(taskId);
    buffer.processedFiles += files;
    this.flushProgress(taskId);
  }

  private bumpProcessedBytes(taskId: string, bytes: number): void {
    if (bytes <= 0) return;
    this.assertNotCancelled(taskId);
    this.countBytes(taskId, bytes);
  }

  /** Adds to the bytes done without asking whether the task goes on: for work that is stopped some other way. */
  private countBytes(taskId: string, bytes: number): void {
    if (bytes <= 0) return;
    const buffer = this.progressBuffer(taskId);
    buffer.processedBytes += bytes;
    this.flushProgress(taskId);
  }

  private setPace(taskId: string, fps: number, height: number | null): void {
    this.progressBuffer(taskId).pace = { fps, height };
    this.flushProgress(taskId);
  }

  /**
   * Reports on a task that is still adding up what it has to do, which on a hard disk with many files is minutes
   * of its time: what it has found so far stands as its totals, told a few times a second, and it stops here when
   * asked to. `updateTotals` ends the count with what there is in all.
   */
  private counter(taskId: string): Found {
    let files = 0;
    let bytes = 0;
    let toldAt = 0;
    return (moreFiles, moreBytes) => {
      files += moreFiles;
      bytes += moreBytes;
      if (Date.now() - toldAt < progressFlushIntervalMs) return;
      toldAt = Date.now();
      this.assertNotCancelled(taskId);
      this.setTotals(taskId, files, bytes, "counting");
    };
  }

  private async updateTotals(taskId: string, totalFiles: number, totalBytes: number): Promise<void> {
    this.flushProgress(taskId, true);
    this.setTotals(taskId, Math.max(totalFiles, 1), Math.max(totalBytes, 0), null);
  }

  private setTotals(taskId: string, totalFiles: number, totalBytes: number, phase: "counting" | "preparing" | null): void {
    this.db
      .prepare(`UPDATE tasks SET total_files = ?, total_bytes = ?, phase = ?, updated_at = ? WHERE id = ? AND status IN (${heldStatuses})`)
      .run(totalFiles, totalBytes, phase, now(), taskId);
    this.events.publish({ type: "task.progress", userId: this.get(taskId).created_by, taskId, patch: { total_files: totalFiles, total_bytes: totalBytes, phase } });
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
    if (!buffer.currentPath && buffer.processedFiles === 0 && buffer.processedBytes === 0 && !buffer.pace) return;

    this.db
      .prepare(
        `UPDATE tasks
        SET current_path = COALESCE(?, current_path),
            processed_files = processed_files + ?,
            processed_bytes = processed_bytes + ?,
            pace_fps = COALESCE(?, pace_fps),
            pace_height = CASE WHEN ? IS NULL THEN pace_height ELSE ? END,
            updated_at = ?
        WHERE id = ? AND status IN (${heldStatuses})`
      )
      .run(buffer.currentPath ?? null, buffer.processedFiles, buffer.processedBytes, buffer.pace?.fps ?? null, buffer.pace?.fps ?? null, buffer.pace?.height ?? null, now(), taskId);

    const task = this.get(taskId);
    const patch: Partial<FileTask> = {
      processed_files: task.processed_files,
      processed_bytes: task.processed_bytes
    };
    if (buffer.currentPath) patch.current_path = task.current_path;
    this.events.publish({ type: "task.progress", userId: task.created_by, taskId, patch });

    buffer.currentPath = undefined;
    buffer.processedFiles = 0;
    buffer.processedBytes = 0;
    buffer.pace = undefined;
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
    throw new AppError(403, "Task access denied", "TASK_ACCESS_DENIED", true);
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

    this.insertTask(retryTask);
    this.events.publish({ type: "task.created", userId: retryTask.created_by, task: retryTask });
    return retryTask;
  }

  private taskInputFromTask(task: FileTask): z.infer<typeof taskInputSchema> {
    const sources = JSON.parse(task.sources_json) as Array<{ rootSlug: string; path: string }>;
    const destination = task.destination
      ? JSON.parse(task.destination) as { rootSlug?: string; path?: string; options?: CompressOptions | ExtractOptions }
      : undefined;
    return taskInputSchema.parse({
      type: task.type,
      sources,
      destination: destination?.rootSlug && destination.path ? { rootSlug: destination.rootSlug, path: destination.path } : undefined,
      options: destination?.options
    });
  }
}

/** Where a source of a copy or move ends up: `occupant` is what has its name there, when that makes way or takes it in. */
type Landing = { mode: "new" | "skip" | "keep" | "replace" | "merge"; name: string; directory: boolean; clash?: Clash; occupant?: FolderEntry };

type ProgressBuffer = {
  processedFiles: number;
  processedBytes: number;
  currentPath?: string;
  pace?: Pace;
  lastFlushAt: number;
};

function syncSpecOf(task: FileTask): SyncSpec {
  const spec = (JSON.parse(task.destination ?? "{}") as { sync?: SyncSpec }).sync;
  if (!spec) throw new AppError(400, "Invalid sync task", "INVALID_SYNC_TASK");
  return { ...spec, source: syncEndpointSchema.parse(spec.source), destination: syncEndpointSchema.parse(spec.destination), options: syncOptionsSchema.parse(spec.options ?? {}) };
}

/** rclone's reasons are for the log; the task says only that the transfer failed or was refused, unless Kago itself refused it. */
function transferFailure(error: unknown): unknown {
  if (error instanceof AppError || error instanceof TaskCancelledError) return error;
  const reason = error instanceof Error ? error.message : String(error);
  logger.warn("transfer failed", reason);
  // Either end may have refused, and rclone does not say which: the disk here, or the account of a remote location.
  if (refusedForPermission(reason)) return new AppError(502, "The transfer was refused for lack of permission at one end. An administrator needs to check the account Kago runs as, or the one a remote location signs in with.", "TRANSFER_PERMISSION_DENIED");
  return new AppError(502, "The transfer failed", "TRANSFER_FAILED");
}

/** Gives each source that is to be kept beside its namesake a name neither the folder nor another source has. */
function nameKept(landings: Landing[], there: Map<string, FolderEntry>): void {
  const names = new Set([...there.keys(), ...landings.map((landing) => nfc(landing.name))]);
  for (const landing of landings) {
    if (landing.mode !== "keep") continue;
    landing.name = freeName((candidate) => names.has(nfc(candidate)), nfc(landing.name), landing.directory);
    landing.mode = "new";
    names.add(landing.name);
  }
}

function downloadFileName(sources: Array<{ path: string }>): string {
  const single = sources.length === 1 ? nfc(path.posix.basename(sources[0]!.path)) : "";
  if (single) return `${single}.zip`;
  const stamp = new Date().toISOString().slice(0, 19).replaceAll(":", "").replace("T", "-");
  return `Kago-${stamp}.zip`;
}

function taskFailureMessage(error: unknown): string {
  const refusal = fileSystemRefusal(error);
  if (refusal) return refusal.message;
  return error instanceof AppError ? error.message : "Task failed";
}

/** A task's input as the audit log may keep it. */
function withoutPassword(input: z.infer<typeof taskInputSchema>): z.infer<typeof taskInputSchema> {
  return input.options?.password ? { ...input, options: { ...input.options, password: "[redacted]" } } : input;
}

function mapZipArchiveError(error: unknown): unknown {
  if (error instanceof ZipPasswordError) return new AppError(400, "Wrong archive password", "ZIP_PASSWORD_WRONG");
  if (error instanceof Error && /^(?:absolute path:|invalid relative path:|invalid characters in fileName:)/.test(error.message)) {
    return new AppError(400, "Unsafe zip entry", "UNSAFE_ZIP_ENTRY");
  }
  return error;
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
      if (errnoIs(error, "ENOENT")) return;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
    }
  }
}


