import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import type { AuditService } from "./audit.service.js";
import type { AuthService } from "./auth.service.js";
import type { SyncChange, SyncStats, SyncSummary } from "./sync-report.js";
import { syncEndpointSchema, syncOptionsSchema, type SyncEndpoint, type TaskService } from "./task.service.js";
import type { Actor } from "./types.js";

const timeOfDay = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** When a job runs by itself. The times of day are the server's own, as its `TZ` has them. */
export const syncScheduleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("interval"), minutes: z.number().int().min(5).max(60 * 24 * 30) }),
  z.object({ kind: z.literal("daily"), time: timeOfDay }),
  z.object({ kind: z.literal("weekly"), weekday: z.number().int().min(0).max(6), time: timeOfDay })
]);

export const syncJobSchema = z.object({
  name: z.string().trim().min(1).max(120),
  source: syncEndpointSchema,
  destination: syncEndpointSchema,
  options: syncOptionsSchema.default({}),
  schedule: syncScheduleSchema.nullable().default(null),
  enabled: z.boolean().default(true)
});

type Schedule = z.infer<typeof syncScheduleSchema>;
type SyncJobInput = z.infer<typeof syncJobSchema>;

type SyncJobRow = {
  id: string;
  name: string;
  source_json: string;
  destination_json: string;
  options_json: string;
  schedule_json: string | null;
  enabled: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_task_id: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
};

type SyncRun = {
  task_id: string;
  started_at: number;
  finished_at: number | null;
  status: string;
  error_message: string | null;
  dry_run: boolean;
  scheduled: boolean;
  /** What a run that was not a trial brought across. */
  bytes: number;
  /** What a trial run would have changed. */
  summary: (SyncSummary & { truncated: boolean }) | null;
};

const SCHEDULER_INTERVAL_MS = 30_000;
/** How many of a job's runs are remembered, the last one among them. */
const KEPT_RUNS = 20;

/** Syncs that are kept: what to bring where, and when. Each run of one is a task like any other. */
export class SyncService {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly tasks: TaskService,
    private readonly auth: AuthService,
    private readonly audit: AuditService
  ) {}

  list(actor: Actor) {
    const jobs =
      actor.role === "ADMIN"
        ? rows<SyncJobRow>(this.db.prepare("SELECT * FROM sync_jobs ORDER BY name COLLATE NOCASE ASC").all())
        : rows<SyncJobRow>(this.db.prepare("SELECT * FROM sync_jobs WHERE created_by = ? ORDER BY name COLLATE NOCASE ASC").all(actor.id));
    return jobs.map((job) => this.publicJob(job));
  }

  async create(actor: Actor, input: SyncJobInput) {
    // A job nobody could run is refused when it is saved, not at three in the morning.
    await this.tasks.assertSync(actor, this.spec(input));
    const ts = now();
    const job: SyncJobRow = {
      id: id("sync"),
      name: input.name,
      source_json: JSON.stringify(input.source),
      destination_json: JSON.stringify(input.destination),
      options_json: JSON.stringify(input.options),
      schedule_json: input.schedule ? JSON.stringify(input.schedule) : null,
      enabled: input.enabled ? 1 : 0,
      next_run_at: input.schedule && input.enabled ? nextRun(input.schedule, new Date()) : null,
      last_run_at: null,
      last_task_id: null,
      created_by: actor.id,
      created_at: ts,
      updated_at: ts
    };
    this.db
      .prepare(
        `INSERT INTO sync_jobs (id, name, source_json, destination_json, options_json, schedule_json, enabled, next_run_at, last_run_at, last_task_id, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(job.id, job.name, job.source_json, job.destination_json, job.options_json, job.schedule_json, job.enabled, job.next_run_at, job.last_run_at, job.last_task_id, job.created_by, job.created_at, job.updated_at);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "sync_job_create", target: { jobId: job.id, name: job.name }, result: "success" });
    return this.publicJob(job);
  }

  async update(actor: Actor, jobId: string, input: SyncJobInput) {
    const existing = this.getForActor(actor, jobId);
    // The job goes on running as whoever made it, so that is who has to be allowed what it now says.
    await this.tasks.assertSync(this.owner(existing) ?? actor, this.spec(input));
    this.db
      .prepare("UPDATE sync_jobs SET name = ?, source_json = ?, destination_json = ?, options_json = ?, schedule_json = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?")
      .run(
        input.name,
        JSON.stringify(input.source),
        JSON.stringify(input.destination),
        JSON.stringify(input.options),
        input.schedule ? JSON.stringify(input.schedule) : null,
        input.enabled ? 1 : 0,
        input.schedule && input.enabled ? nextRun(input.schedule, new Date()) : null,
        now(),
        jobId
      );
    this.audit.write({ actorType: "user", actorId: actor.id, action: "sync_job_update", target: { jobId }, result: "success" });
    return this.publicJob(this.get(jobId));
  }

  delete(actor: Actor, jobId: string): void {
    this.getForActor(actor, jobId);
    this.db.prepare("DELETE FROM sync_jobs WHERE id = ?").run(jobId);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "sync_job_delete", target: { jobId }, result: "success" });
  }

  /** Runs the job now, as whoever asked. */
  async run(actor: Actor, jobId: string) {
    const job = this.getForActor(actor, jobId);
    this.assertIdle(job);
    const task = await this.tasks.createSync(actor, this.spec(this.inputOf(job), job.id));
    this.began(job, task.id);
    return task;
  }

  /** What the job's last run would have changed, when that was a trial run. */
  trial(actor: Actor, jobId: string) {
    const job = this.getForActor(actor, jobId);
    const report = job.last_task_id
      ? row<{ summary_json: string; stats_json: string; changes_json: string }>(this.db.prepare("SELECT summary_json, stats_json, changes_json FROM task_reports WHERE task_id = ?").get(job.last_task_id))
      : null;
    if (!report) throw new AppError(404, "This sync has no trial run to show", "SYNC_NO_TRIAL");
    return {
      ...(JSON.parse(report.summary_json) as SyncSummary & { truncated: boolean }),
      stats: JSON.parse(report.stats_json) as SyncStats,
      changes: JSON.parse(report.changes_json) as SyncChange[]
    };
  }

  /** The job's last runs, newest first. */
  runs(actor: Actor, jobId: string): SyncRun[] {
    const job = this.getForActor(actor, jobId);
    const last = this.lastRun(job);
    const earlier = rows<Omit<SyncRun, "dry_run" | "scheduled" | "summary"> & { dry_run: number; scheduled: number; summary_json: string | null }>(
      this.db
        .prepare("SELECT task_id, started_at, finished_at, status, error_message, dry_run, scheduled, bytes, summary_json FROM sync_runs WHERE job_id = ? ORDER BY started_at DESC, rowid DESC")
        .all(job.id)
    ).map(({ summary_json, ...run }) => ({ ...run, dry_run: Boolean(run.dry_run), scheduled: Boolean(run.scheduled), summary: summary_json ? (JSON.parse(summary_json) as SyncRun["summary"]) : null }));
    return last ? [last, ...earlier] : earlier;
  }

  /** The run the job's last task was, read from the task itself for as long as the job points at it. */
  private lastRun(job: SyncJobRow): SyncRun | null {
    if (!job.last_task_id) return null;
    const task = row<{ status: string; error_message: string | null; finished_at: number | null; processed_bytes: number; destination: string | null; auth_snapshot_json: string | null; created_at: number }>(
      this.db.prepare("SELECT status, error_message, finished_at, processed_bytes, destination, auth_snapshot_json, created_at FROM tasks WHERE id = ?").get(job.last_task_id)
    );
    if (!task) return null;
    const report = row<{ summary_json: string }>(this.db.prepare("SELECT summary_json FROM task_reports WHERE task_id = ?").get(job.last_task_id));
    const spec = (task.destination ? (JSON.parse(task.destination) as { sync?: { options?: { dryRun?: boolean } } }) : {}).sync;
    const snapshot = task.auth_snapshot_json ? (JSON.parse(task.auth_snapshot_json) as { scheduled?: boolean }) : {};
    return {
      task_id: job.last_task_id,
      started_at: job.last_run_at ?? task.created_at,
      finished_at: task.finished_at,
      status: task.status,
      error_message: task.error_message,
      dry_run: Boolean(spec?.options?.dryRun),
      scheduled: Boolean(snapshot.scheduled),
      bytes: task.processed_bytes ?? 0,
      summary: report && task.status === "done" ? (JSON.parse(report.summary_json) as SyncRun["summary"]) : null
    };
  }

  /** A job's new run is the one that counts: of the run before it only how it ended is kept, not all it reported. */
  private began(job: SyncJobRow, taskId: string): void {
    // The task of the last run stays for as long as the job points at it, so this is the last moment it is sure to be there.
    const last = this.lastRun(job);
    if (last) {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO sync_runs (task_id, job_id, started_at, finished_at, status, error_message, dry_run, scheduled, bytes, summary_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(last.task_id, job.id, last.started_at, last.finished_at, last.status, last.error_message, last.dry_run ? 1 : 0, last.scheduled ? 1 : 0, last.bytes, last.summary ? JSON.stringify(last.summary) : null);
      this.db
        .prepare("DELETE FROM sync_runs WHERE job_id = ? AND task_id NOT IN (SELECT task_id FROM sync_runs WHERE job_id = ? ORDER BY started_at DESC, rowid DESC LIMIT ?)")
        .run(job.id, job.id, KEPT_RUNS - 1);
    }
    if (job.last_task_id) this.db.prepare("DELETE FROM task_reports WHERE task_id = ?").run(job.last_task_id);
    this.db.prepare("UPDATE sync_jobs SET last_run_at = ?, last_task_id = ? WHERE id = ?").run(now(), taskId, job.id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((error: unknown) => logger.error("sync scheduler failed", error)), SCHEDULER_INTERVAL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Queues every job whose time has come, as the user who made it. A run that is still going is not doubled. */
  async tick(at = new Date()): Promise<void> {
    const due = rows<SyncJobRow>(this.db.prepare("SELECT * FROM sync_jobs WHERE enabled = 1 AND schedule_json IS NOT NULL AND next_run_at IS NOT NULL AND next_run_at <= ?").all(Math.floor(at.getTime() / 1000)));
    for (const job of due) {
      const input = this.inputOf(job);
      this.db.prepare("UPDATE sync_jobs SET next_run_at = ? WHERE id = ?").run(input.schedule ? nextRun(input.schedule, at) : null, job.id);
      if (this.running(job)) continue;
      const owner = this.owner(job);
      try {
        if (!owner || owner.disabled) throw new AppError(403, "The owner of the job can no longer sign in", "SYNC_OWNER_DISABLED");
        const task = await this.tasks.createSync(owner, this.spec(input, job.id), true);
        this.began(job, task.id);
      } catch (error) {
        // A job that may no longer run is passed over until someone changes it or its permissions.
        this.audit.write({ actorType: "system", action: "sync_job_skipped", target: { jobId: job.id, reason: error instanceof Error ? error.message : String(error) }, result: "failure" });
      }
    }
  }

  private spec(input: SyncJobInput, jobId?: string) {
    return { jobId, name: input.name, source: input.source, destination: input.destination, options: input.options };
  }

  private inputOf(job: SyncJobRow): SyncJobInput {
    return syncJobSchema.parse({
      name: job.name,
      source: JSON.parse(job.source_json),
      destination: JSON.parse(job.destination_json),
      options: JSON.parse(job.options_json),
      schedule: job.schedule_json ? JSON.parse(job.schedule_json) : null,
      enabled: Boolean(job.enabled)
    });
  }

  private owner(job: SyncJobRow): Actor | null {
    try {
      const user = this.auth.getUser(job.created_by);
      return { id: user.id, email: user.email, displayName: user.display_name, role: user.role, disabled: Boolean(user.disabled) };
    } catch {
      return null;
    }
  }

  private running(job: SyncJobRow): boolean {
    if (!job.last_task_id) return false;
    const task = row<{ status: string }>(this.db.prepare("SELECT status FROM tasks WHERE id = ?").get(job.last_task_id));
    return Boolean(task && ["queued", "running", "paused", "pausing"].includes(task.status));
  }

  private assertIdle(job: SyncJobRow): void {
    if (this.running(job)) throw new AppError(409, "This sync is already running", "SYNC_ALREADY_RUNNING");
  }

  private get(jobId: string): SyncJobRow {
    const job = row<SyncJobRow>(this.db.prepare("SELECT * FROM sync_jobs WHERE id = ?").get(jobId));
    if (!job) throw new AppError(404, "Sync not found", "SYNC_NOT_FOUND");
    return job;
  }

  private getForActor(actor: Actor, jobId: string): SyncJobRow {
    const job = this.get(jobId);
    if (actor.role !== "ADMIN" && job.created_by !== actor.id) throw new AppError(404, "Sync not found", "SYNC_NOT_FOUND");
    return job;
  }

  private publicJob(job: SyncJobRow) {
    const last = job.last_task_id ? row<{ status: string; error_message: string | null; finished_at: number | null }>(this.db.prepare("SELECT status, error_message, finished_at FROM tasks WHERE id = ?").get(job.last_task_id)) : null;
    const trial = last?.status === "done" ? row<{ summary_json: string }>(this.db.prepare("SELECT summary_json FROM task_reports WHERE task_id = ?").get(job.last_task_id)) : null;
    return {
      id: job.id,
      name: job.name,
      source: JSON.parse(job.source_json) as SyncEndpoint,
      destination: JSON.parse(job.destination_json) as SyncEndpoint,
      options: syncOptionsSchema.parse(JSON.parse(job.options_json)),
      schedule: job.schedule_json ? (JSON.parse(job.schedule_json) as Schedule) : null,
      enabled: Boolean(job.enabled),
      next_run_at: job.next_run_at,
      last_run_at: job.last_run_at,
      last_status: last?.status ?? null,
      last_error: last?.error_message ?? null,
      last_trial: trial ? (JSON.parse(trial.summary_json) as SyncSummary & { truncated: boolean }) : null,
      created_by: job.created_by
    };
  }
}

/** The first moment after `from` at which the schedule comes round, in seconds. */
export function nextRun(schedule: Schedule, from: Date): number {
  if (schedule.kind === "interval") return Math.floor(from.getTime() / 1000) + schedule.minutes * 60;
  const [hours, minutes] = schedule.time.split(":").map(Number) as [number, number];
  const next = new Date(from);
  next.setHours(hours, minutes, 0, 0);
  if (schedule.kind === "weekly") next.setDate(next.getDate() + ((schedule.weekday - next.getDay() + 7) % 7));
  // Stepped by the calendar and not by 24 hours, so a clock change does not move the time of day.
  while (next.getTime() <= from.getTime()) next.setDate(next.getDate() + (schedule.kind === "weekly" ? 7 : 1));
  return Math.floor(next.getTime() / 1000);
}
