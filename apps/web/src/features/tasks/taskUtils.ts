import { useEffect, useReducer } from "react";
import { formatSize, formatWholeSize } from "@/lib/format";
import type { FileTask } from "@/types/kago";
import { t } from "@/lib/i18n";

const typeLabels: Record<FileTask["type"], string> = {
  copy: t("Copy"),
  move: t("Move"),
  compress: t("Compress"),
  download_zip: t("Zip download"),
  extract: t("Extract"),
  delete_to_trash: t("Move to Trash"),
  delete: t("Delete"),
  restore_trash: t("Restore from Trash"),
  empty_trash: t("Empty Trash"),
  thumbnail: t("Thumbnails"),
  sync: t("Sync"),
  convert: t("Convert"),
  remux: t("Repack")
};

const statusMeta: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  queued: { label: t("Queued"), tone: "neutral" },
  running: { label: t("Running"), tone: "accent" },
  cancelling: { label: t("Cancelling"), tone: "neutral" },
  paused: { label: t("Paused"), tone: "warning" },
  done: { label: t("Done"), tone: "success" },
  failed: { label: t("Failed"), tone: "danger" },
  cancelled: { label: t("Cancelled"), tone: "neutral" },
  interrupted: { label: t("Interrupted"), tone: "danger" }
};

export const taskTypeLabel = (task: FileTask) => typeLabels[task.type] ?? task.type;
export const taskStatus = (task: { status: string }) => statusMeta[task.status] ?? { label: task.status, tone: "neutral" as const };
export const isActiveTask = (task: { status: string }) => ["queued", "running", "cancelling", "paused"].includes(task.status);
/** How long moving to the Trash, or deleting, may run before it is shown as the work it has turned out to be. */
const QUIET_MS = 2000;
/** When this tab first saw each such task under way. The server's clock is not this one's, so its times are not compared. */
const firstSeen = new Map<string, number>();

/**
 * The tasks to show among the live ones. Moving to the Trash, or deleting, looks instant to the user and is over
 * in a moment on one disk, so it is left out unless it goes wrong, or goes on: across disks, or through a great
 * many files, it takes minutes, and then it is counted like any other.
 */
export function useShownTasks(tasks: FileTask[]): FileTask[] {
  const [, wake] = useReducer((count: number) => count + 1, 0);
  const at = Date.now();
  const quick = tasks.filter((task) => (task.type === "delete_to_trash" || task.type === "delete") && isActiveTask(task));
  for (const task of quick) if (!firstSeen.has(task.id)) firstSeen.set(task.id, at);
  const due = Math.min(...quick.map((task) => firstSeen.get(task.id)! + QUIET_MS).filter((time) => time > at));
  useEffect(() => {
    for (const id of firstSeen.keys()) if (!quick.some((task) => task.id === id)) firstSeen.delete(id);
    if (!Number.isFinite(due)) return;
    const timer = setTimeout(wake, due - Date.now());
    return () => clearTimeout(timer);
  });
  return tasks.filter((task) => {
    if (task.type !== "delete_to_trash" && task.type !== "delete") return true;
    return isActiveTask(task) ? at >= firstSeen.get(task.id)! + QUIET_MS : task.status !== "done";
  });
}
export const canCancelTask = (task: FileTask) => ["queued", "paused", "running"].includes(task.status);
export const isFinishedTask = (task: FileTask) => !isActiveTask(task);
export const canRetryTask = (task: FileTask) => ["failed", "cancelled", "interrupted"].includes(task.status);

/** Whether a task under way has yet to start on its work: it is adding up what there is to do, or fetching it. How far along it is cannot be told. */
export const isCountingTask = (task: FileTask) => Boolean(task.phase) && (task.status === "running" || task.status === "cancelling");

export const taskProgressValue = (task: FileTask) => (isCountingTask(task) ? 0 : task.total_bytes > 0 ? task.processed_bytes : task.processed_files);
export const taskProgressMax = (task: FileTask) => Math.max(task.total_bytes > 0 ? task.total_bytes : task.total_files, 1);

/** How far along several tasks are taken together, from 0 to 1: each counts the same, whatever it is counted in. */
export const tasksProgress = (tasks: FileTask[]) => (tasks.length > 0 ? tasks.reduce((sum, task) => sum + taskProgressValue(task) / taskProgressMax(task), 0) / tasks.length : 0);

export function taskProgressLabel(task: FileTask) {
  if (isCountingTask(task)) {
    if (task.phase !== "counting") return t("Getting ready…");
    const found = t("Counting… {count} item found | Counting… {count} items found", { count: task.total_files });
    return task.total_bytes > 0 ? `${found} · ${formatWholeSize(task.total_bytes)}` : found;
  }
  const files = t("{done}/{total} items", { done: task.processed_files, total: Math.max(task.total_files, 1) });
  return task.total_bytes > 0 ? `${formatWholeSize(task.processed_bytes)} / ${formatWholeSize(task.total_bytes)} · ${files}` : files;
}

/** How fast a running task is going, once that can be told and while it is going at all. */
/** A video being converted is told by its frames a second and how tall it comes out; anything else by its bytes. */
export function taskSpeedLabel(task: FileTask): string | undefined {
  if (task.status !== "running") return undefined;
  if (task.pace?.fps && task.pace.height) return `${Math.round(task.pace.fps)}fps@${task.pace.height}p`;
  return task.speed ? `${formatSize(task.speed)}/s` : undefined;
}

/** The server reports task failures in English; the ones a user can act on are worded for a task rather than a request. */
const errorLabels: Record<string, string> = {
  "Target already exists": t("The destination already has an item with that name"),
  "Multiple sources resolve to the same target": t("Some of the selected items share a name"),
  "Cannot copy or move a folder into itself": t("A folder can’t be put inside itself"),
  "Path not found": t("The source or destination no longer exists"),
  "Symlink paths are not allowed": t("Symbolic links aren’t supported"),
  "Task failed": t("An unexpected error occurred")
};

export const taskErrorLabel = (message: string) => errorLabels[message] ?? t(message);

const downloadMaxAgeSeconds = 24 * 60 * 60;

/** Download archives live in the server's temp dir for a day. */
export const hasTaskDownload = (task: FileTask) => task.type === "download_zip" && task.status === "done" && Date.now() / 1000 - task.updated_at < downloadMaxAgeSeconds;

/** A finished compress task leaves a zip the user usually wants to download. */
export const compressDownloadTarget = (task: FileTask) => (task.type === "compress" && task.status === "done" ? task.destination : null);
