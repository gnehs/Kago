import type { Db } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { activeTaskStatuses, sqlStatuses, type FileTask } from "./types.js";

/** The saved sync or auto-convert job a task is a run of, as its destination names it. */
export function jobIdOf(task: Pick<FileTask, "type" | "destination">): string | null {
  if (!task.destination || (task.type !== "sync" && task.type !== "convert")) return null;
  let destination: { sync?: { jobId?: string }; job?: { id?: string } } | null;
  try {
    destination = JSON.parse(task.destination);
  } catch {
    // Rows written by older versions pass through here when the database is opened, and one bad row must not stop that.
    return null;
  }
  return (task.type === "sync" ? destination?.sync?.jobId : destination?.job?.id) ?? null;
}

/** Thrown by the insert of a job's run while another run of that job is active. */
export const jobBusy = () => new AppError(409, "This job is already running", "JOB_ALREADY_RUNNING");

export function jobRunning(db: Db, jobId: string): boolean {
  return Boolean(db.prepare(`SELECT 1 FROM tasks WHERE job_id = ? AND status IN (${sqlStatuses(activeTaskStatuses)}) LIMIT 1`).get(jobId));
}

/** Queues a run of the job with `create`, or gives null while another run of it is active, one queued meanwhile included. */
export async function startJobRun(db: Db, jobId: string, create: () => Promise<FileTask>): Promise<FileTask | null> {
  if (jobRunning(db, jobId)) return null;
  try {
    return await create();
  } catch (error) {
    if (error instanceof AppError && error.code === "JOB_ALREADY_RUNNING") return null;
    throw error;
  }
}
