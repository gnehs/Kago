import type { FileRef } from "@kago/contract";
import type { FileTask } from "../types/kago";

/** What a task works on: the name of its first source, and how many more there are. */
export type TaskSubject = { name: string; more: number };

/** The Trash holds item ids under this slug, which no one would recognise as a name. */
const trashSlug = "trash";

/** The last segment of a path; empty for the root of a location. Archive entries come without a leading slash. */
function baseName(path: string): string {
  const segments = path.split(/[\\/]/).filter(Boolean);
  return segments[segments.length - 1] ?? "";
}

function refName(ref: FileRef): string | null {
  if (ref.rootSlug === trashSlug) return null;
  return baseName(ref.path) || null;
}

export function taskSubject(task: FileTask): TaskSubject | null {
  const first = task.sources[0];
  const name = first && refName(first);
  return name ? { name, more: task.sources.length - 1 } : null;
}

export function taskDestinationName(task: FileTask): string | null {
  return task.destination ? refName(task.destination) : null;
}

/** The path is kept after a task ends, so only a running task's is current. */
export function taskCurrentName(task: FileTask): string | null {
  if (task.status !== "running") return null;
  if (task.phase === "counting" || task.phase === "preparing") return null;
  return task.current_path ? baseName(task.current_path) || null : null;
}

export function taskSecondsLeft(task: FileTask): number | null {
  if (task.status !== "running" || task.phase === "counting" || task.phase === "preparing") return null;
  if (!task.speed || task.speed <= 0 || task.total_bytes <= 0) return null;
  return Math.max(0, Math.ceil((task.total_bytes - task.processed_bytes) / task.speed));
}

/**
 * The list comes newest first, but the server starts the queued task with the oldest `created_at`, so the queue
 * is read back oldest first. Tasks made in the same second keep the reverse of the list order, the best that
 * can be told of them. The media lane runs beside the others, so two queued tasks may start together.
 */
export function groupTasks(tasks: FileTask[]): { pinned: FileTask[]; queue: FileTask[]; finished: FileTask[] } {
  const only = (...statuses: FileTask["status"][]) => tasks.filter((task) => statuses.includes(task.status));
  const oldestFirst = (list: FileTask[]) => [...list].reverse().sort((a, b) => a.created_at - b.created_at);
  return {
    pinned: [...only("running", "cancelling"), ...only("failed", "interrupted")],
    queue: [...oldestFirst(only("queued")), ...oldestFirst(only("paused"))],
    finished: only("done", "cancelled")
  };
}
