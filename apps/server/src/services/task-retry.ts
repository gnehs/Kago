import type { ConvertJobService } from "./convert-job.service.js";
import type { SyncService } from "./sync.service.js";
import type { TaskService } from "./task.service.js";
import type { Actor, FileTask } from "./types.js";

/** Runs a failed task again: through the sync or the convert job it belongs to, and failing those, as the plain task it is. */
export async function retryTask(
  actor: Actor,
  taskId: string,
  { tasks, sync, convertJobs }: { tasks: TaskService; sync: SyncService; convertJobs: ConvertJobService }
): Promise<FileTask> {
  const task = tasks.retryable(actor, taskId);
  return (await sync.retryRun(actor, task)) ?? (await convertJobs.retryRun(actor, task)) ?? tasks.retry(actor, task.id);
}
