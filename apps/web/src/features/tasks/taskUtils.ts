import { formatSize } from "@/lib/format";
import type { FileTask } from "@/types/kago";

const typeLabels: Record<string, string> = {
  copy: "複製",
  move: "搬移",
  compress: "壓縮",
  download_zip: "打包下載",
  extract: "解壓縮",
  delete_to_trash: "移到垃圾桶",
  restore_trash: "從垃圾桶還原",
  rsync_pull: "rsync 拉取",
  rsync_push: "rsync 推送",
  thumbnail: "產生縮圖"
};

const statusMeta: Record<string, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  queued: { label: "等待中", tone: "neutral" },
  running: { label: "執行中", tone: "accent" },
  pausing: { label: "暫停中", tone: "warning" },
  paused: { label: "已暫停", tone: "warning" },
  done: { label: "完成", tone: "success" },
  failed: { label: "失敗", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
  interrupted: { label: "已中斷", tone: "danger" }
};

export const taskTypeLabel = (task: FileTask) => typeLabels[task.type] ?? task.type;
export const taskStatus = (task: FileTask) => statusMeta[task.status] ?? { label: task.status, tone: "neutral" as const };
export const isActiveTask = (task: FileTask) => ["queued", "running", "pausing", "paused"].includes(task.status);
export const canCancelTask = (task: FileTask) => ["queued", "paused", "running"].includes(task.status);
export const canRetryTask = (task: FileTask) => ["failed", "cancelled", "interrupted"].includes(task.status);

export const taskProgressValue = (task: FileTask) => (task.total_bytes > 0 ? task.processed_bytes : task.processed_files);
export const taskProgressMax = (task: FileTask) => Math.max(task.total_bytes > 0 ? task.total_bytes : task.total_files, 1);

export function taskProgressLabel(task: FileTask) {
  const files = `${task.processed_files}/${Math.max(task.total_files, 1)} 項`;
  return task.total_bytes > 0 ? `${formatSize(task.processed_bytes)} / ${formatSize(task.total_bytes)} · ${files}` : files;
}

/** The server reports task failures in English; the ones a user can act on get a proper message. */
const errorLabels: Record<string, string> = {
  "Target already exists": "目的地已有同名項目",
  "Multiple sources resolve to the same target": "選取的項目裡有同名項目",
  "Cannot copy or move a folder into itself": "不能把資料夾放進它自己裡面",
  "Path not found": "來源或目的地已經不存在",
  "Symlink paths are not allowed": "不支援符號連結",
  "Task failed": "發生未預期的錯誤"
};

export const taskErrorLabel = (message: string) => errorLabels[message] ?? message;

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
