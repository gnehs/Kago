import { formatSize } from "@/lib/format";
import type { FileTask } from "@/types/kago";
import { t } from "@/lib/i18n";

const typeLabels: Record<string, string> = {
  copy: t("Copy"),
  move: t("Move"),
  compress: t("Compress"),
  download_zip: t("Zip download"),
  extract: t("Extract"),
  delete_to_trash: t("Move to Trash"),
  restore_trash: t("Restore from Trash"),
  thumbnail: t("Thumbnails"),
  sync: t("Sync")
};

const statusMeta: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  queued: { label: t("Queued"), tone: "neutral" },
  running: { label: t("Running"), tone: "accent" },
  pausing: { label: t("Pausing"), tone: "warning" },
  paused: { label: t("Paused"), tone: "warning" },
  done: { label: t("Done"), tone: "success" },
  failed: { label: t("Failed"), tone: "danger" },
  cancelled: { label: t("Cancelled"), tone: "neutral" },
  interrupted: { label: t("Interrupted"), tone: "danger" }
};

export const taskTypeLabel = (task: FileTask) => typeLabels[task.type] ?? task.type;
export const taskStatus = (task: FileTask) => statusMeta[task.status] ?? { label: task.status, tone: "neutral" as const };
export const isActiveTask = (task: FileTask) => ["queued", "running", "pausing", "paused"].includes(task.status);
/** Moving to the Trash looks instant to the user, so it only shows up among the live tasks when it goes wrong. */
export const isQuietTask = (task: FileTask) => task.type === "delete_to_trash" && (isActiveTask(task) || task.status === "done");
export const canCancelTask = (task: FileTask) => ["queued", "paused", "running"].includes(task.status);
export const isFinishedTask = (task: FileTask) => !isActiveTask(task);
export const canRetryTask = (task: FileTask) => ["failed", "cancelled", "interrupted"].includes(task.status);

export const taskProgressValue = (task: FileTask) => (task.total_bytes > 0 ? task.processed_bytes : task.processed_files);
export const taskProgressMax = (task: FileTask) => Math.max(task.total_bytes > 0 ? task.total_bytes : task.total_files, 1);

export function taskProgressLabel(task: FileTask) {
  const files = t("{done}/{total} items", { done: task.processed_files, total: Math.max(task.total_files, 1) });
  return task.total_bytes > 0 ? `${formatSize(task.processed_bytes)} / ${formatSize(task.total_bytes)} · ${files}` : files;
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
export function compressDownloadTarget(task: FileTask): { rootSlug: string; path: string } | null {
  if (task.type !== "compress" || task.status !== "done" || !task.destination) return null;
  try {
    const destination = JSON.parse(task.destination) as { rootSlug?: unknown; path?: unknown } | null;
    return destination && typeof destination.rootSlug === "string" && typeof destination.path === "string" && destination.rootSlug && destination.path
      ? { rootSlug: destination.rootSlug, path: destination.path }
      : null;
  } catch {
    return null;
  }
}
