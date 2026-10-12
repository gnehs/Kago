import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { convertSpecSchema } from "../lib/convert.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import type { AuditService } from "./audit.service.js";
import type { AuthService } from "./auth.service.js";
import { convertJobOptionsSchema } from "./convert.service.js";
import type { TaskService } from "./task.service.js";
import type { Actor, FileRef } from "./types.js";

const folderSchema = z.object({ rootSlug: z.string().min(1), path: z.string().min(1) });

export const convertJobSchema = z.object({
  name: z.string().trim().min(1).max(120),
  input: folderSchema,
  destination: folderSchema,
  spec: convertSpecSchema,
  options: convertJobOptionsSchema.default({}),
  watch: z.boolean().default(true)
});

type ConvertJobInput = z.infer<typeof convertJobSchema>;

type ConvertJobRow = {
  id: string;
  name: string;
  input_json: string;
  destination_json: string;
  spec_json: string;
  options_json: string;
  watch: number;
  last_run_at: number | null;
  last_task_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
};

/** How often the watched input folders are looked at. A file counts once it measures the same two looks in a row. */
const WATCH_INTERVAL_MS = 30_000;

/** Folders that convert themselves: what to make of whatever turns up in one, and where to put it. Each run is a task like any other. */
export class ConvertJobService {
  private timer: NodeJS.Timeout | null = null;
  private looking = false;
  /** What each waiting file of a job measured at the last look, by job. */
  private readonly seen = new Map<string, Map<string, number>>();
  /** Why each job was last passed over, so that it is said once. */
  private readonly skipped = new Map<string, string>();

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly auth: AuthService,
    private readonly audit: AuditService
  ) {}

  list(actor: Actor) {
    const jobs =
      actor.role === "ADMIN"
        ? rows<ConvertJobRow>(this.db.prepare("SELECT * FROM convert_jobs ORDER BY name COLLATE NOCASE ASC").all())
        : rows<ConvertJobRow>(this.db.prepare("SELECT * FROM convert_jobs WHERE created_by = ? ORDER BY name COLLATE NOCASE ASC").all(actor.id));
    return jobs.map((job) => this.publicJob(job));
  }

  async create(actor: Actor, input: ConvertJobInput) {
    // A job nobody could run is refused when it is saved, not when the first file turns up.
    await this.tasks.convert.assertJob(actor, input);
    const ts = now();
    const jobId = id("convert");
    this.db
      .prepare("INSERT INTO convert_jobs (id, name, input_json, destination_json, spec_json, options_json, watch, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(jobId, input.name, JSON.stringify(input.input), JSON.stringify(input.destination), JSON.stringify(input.spec), JSON.stringify(input.options), input.watch ? 1 : 0, actor.id, ts, ts);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "convert_job_create", target: { jobId, name: input.name }, result: "success" });
    return this.publicJob(this.get(jobId));
  }

  async update(actor: Actor, jobId: string, input: ConvertJobInput) {
    const existing = this.getForActor(actor, jobId);
    // The job goes on running as whoever made it, so that is who has to be allowed what it now says.
    await this.tasks.convert.assertJob(this.owner(existing) ?? actor, input);
    this.db
      .prepare("UPDATE convert_jobs SET name = ?, input_json = ?, destination_json = ?, spec_json = ?, options_json = ?, watch = ?, updated_at = ? WHERE id = ?")
      .run(input.name, JSON.stringify(input.input), JSON.stringify(input.destination), JSON.stringify(input.spec), JSON.stringify(input.options), input.watch ? 1 : 0, now(), jobId);
    // Another folder, or another format, is another job as far as what has been done goes.
    if (existing.input_json !== JSON.stringify(input.input) || existing.spec_json !== JSON.stringify(input.spec)) this.db.prepare("DELETE FROM convert_job_files WHERE job_id = ?").run(jobId);
    this.seen.delete(jobId);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "convert_job_update", target: { jobId }, result: "success" });
    return this.publicJob(this.get(jobId));
  }

  delete(actor: Actor, jobId: string): void {
    this.getForActor(actor, jobId);
    this.db.prepare("DELETE FROM convert_jobs WHERE id = ?").run(jobId);
    this.seen.delete(jobId);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "convert_job_delete", target: { jobId }, result: "success" });
  }

  /** Runs the job now, as whoever asked. Files it gave up on earlier are tried again. */
  async run(actor: Actor, jobId: string) {
    const job = this.getForActor(actor, jobId);
    if (this.running(job)) throw new AppError(409, "This conversion is already running", "CONVERT_ALREADY_RUNNING");
    return this.begin(actor, job, true, false);
  }

  /** Makes in the job's input folder every folder its destination has, so that what is dropped in one comes out in the other. */
  async copyStructure(actor: Actor, jobId: string) {
    const job = this.inputOf(this.getForActor(actor, jobId));
    return this.tasks.convert.copyStructure(actor, job.destination, job.input);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((error: unknown) => logger.error("auto-convert watcher failed", error)), WATCH_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Looks into every watched input folder and queues a run of each job that has files waiting, as the user who made it. */
  async tick(): Promise<void> {
    // A look at a large or a far-away folder can outlast the wait for the next one.
    if (this.looking) return;
    this.looking = true;
    try {
      for (const job of rows<ConvertJobRow>(this.db.prepare("SELECT * FROM convert_jobs WHERE watch = 1").all())) {
        if (this.running(job)) continue;
        const owner = this.owner(job);
        try {
          if (!owner || owner.disabled) throw new AppError(403, "The owner of the job can no longer sign in", "CONVERT_OWNER_DISABLED");
          const input = this.inputOf(job);
          let seen = this.seen.get(job.id);
          if (!seen) this.seen.set(job.id, (seen = new Map()));
          if ((await this.tasks.convert.ready({ id: job.id, ...input }, seen)) > 0) await this.begin(owner, job, false, true);
        } catch (error) {
          // A folder that is gone, or may no longer be read, is passed over until someone changes the job. Said once, not at every look.
          const reason = error instanceof Error ? error.message : String(error);
          if (this.skipped.get(job.id) !== reason) this.audit.write({ actorType: "system", action: "convert_job_skipped", target: { jobId: job.id, reason }, result: "failure" });
          this.skipped.set(job.id, reason);
          continue;
        }
        this.skipped.delete(job.id);
      }
    } finally {
      this.looking = false;
    }
  }

  private async begin(actor: Actor, job: ConvertJobRow, retryFailed: boolean, scheduled: boolean) {
    const input = this.inputOf(job);
    const task = await this.tasks.createConvert(actor, { sources: [input.input], destination: input.destination, spec: input.spec }, { id: job.id, input: input.input, options: input.options, retryFailed }, scheduled);
    this.db.prepare("UPDATE convert_jobs SET last_run_at = ?, last_task_id = ? WHERE id = ?").run(now(), task.id, job.id);
    return task;
  }

  private inputOf(job: ConvertJobRow): ConvertJobInput {
    return convertJobSchema.parse({
      name: job.name,
      input: JSON.parse(job.input_json),
      destination: JSON.parse(job.destination_json),
      spec: JSON.parse(job.spec_json),
      options: JSON.parse(job.options_json),
      watch: Boolean(job.watch)
    });
  }

  private owner(job: ConvertJobRow): Actor | null {
    try {
      const user = this.auth.getUser(job.created_by);
      return { id: user.id, email: user.email, displayName: user.display_name, role: user.role, disabled: Boolean(user.disabled) };
    } catch {
      return null;
    }
  }

  private lastTask(job: ConvertJobRow) {
    if (!job.last_task_id) return null;
    return row<{ status: string; error_message: string | null }>(this.db.prepare("SELECT status, error_message FROM tasks WHERE id = ?").get(job.last_task_id));
  }

  private running(job: ConvertJobRow): boolean {
    const task = this.lastTask(job);
    return Boolean(task && ["queued", "running", "paused", "pausing"].includes(task.status));
  }

  private get(jobId: string): ConvertJobRow {
    const job = row<ConvertJobRow>(this.db.prepare("SELECT * FROM convert_jobs WHERE id = ?").get(jobId));
    if (!job) throw new AppError(404, "Conversion not found", "CONVERT_JOB_NOT_FOUND");
    return job;
  }

  private getForActor(actor: Actor, jobId: string): ConvertJobRow {
    const job = this.get(jobId);
    if (actor.role !== "ADMIN" && job.created_by !== actor.id) throw new AppError(404, "Conversion not found", "CONVERT_JOB_NOT_FOUND");
    return job;
  }

  private publicJob(job: ConvertJobRow) {
    const last = this.lastTask(job);
    const counts = rows<{ status: string; count: number }>(this.db.prepare("SELECT status, COUNT(*) AS count FROM convert_job_files WHERE job_id = ? GROUP BY status").all(job.id));
    const count = (status: string) => counts.find((item) => item.status === status)?.count ?? 0;
    return {
      id: job.id,
      name: job.name,
      input: JSON.parse(job.input_json) as FileRef,
      destination: JSON.parse(job.destination_json) as FileRef,
      spec: convertSpecSchema.parse(JSON.parse(job.spec_json)),
      options: convertJobOptionsSchema.parse(JSON.parse(job.options_json)),
      watch: Boolean(job.watch),
      last_run_at: job.last_run_at,
      last_status: last?.status ?? null,
      last_error: last?.error_message ?? null,
      /** Files that failed and are left in the input folder until they change or the job is started by hand. */
      failed: count("failed"),
      created_by: job.created_by
    };
  }
}
