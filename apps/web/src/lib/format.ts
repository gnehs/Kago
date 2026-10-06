import type { FileItem } from "../types/kago";

export function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

/** Rounded so a countdown reads calmly: seconds under a minute, then minutes, then hours and minutes. */
export function formatDuration(seconds: number) {
  const total = Math.max(1, Math.round(seconds));
  if (total < 60) return `${total} 秒`;
  if (total < 3600) return `${Math.floor(total / 60)} 分 ${total % 60} 秒`;
  return `${Math.floor(total / 3600)} 小時 ${Math.floor((total % 3600) / 60)} 分`;
}

/** A playhead position: 1:05, or 1:02:05 once `long` (the whole length reaches an hour). */
export function formatClock(seconds: number, long = seconds >= 3600) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor((total % 3600) / 60);
  const tail = String(total % 60).padStart(2, "0");
  return long ? `${Math.floor(total / 3600)}:${String(minutes).padStart(2, "0")}:${tail}` : `${Math.floor(total / 60)}:${tail}`;
}

const dateFormat = new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** File mtimes are milliseconds; database timestamps are unix seconds. */
export const formatDate = (ms: number) => dateFormat.format(new Date(ms));
export const formatUnixDate = (seconds: number) => dateFormat.format(new Date(seconds * 1000));

/** Files the video player takes; RealMedia has no `video/` type of its own. */
export const isVideoType = (type: string) => type.startsWith("video/") || type.startsWith("application/vnd.rn-realmedia");

export function kindLabel(item: Pick<FileItem, "kind" | "type" | "name">) {
  if (item.kind === "folder") return "資料夾";
  const type = item.type;
  if (type.startsWith("image/")) return "影像";
  if (type.startsWith("video/")) return "影片";
  if (type.startsWith("audio/")) return "音訊";
  if (type === "application/pdf") return "PDF 文件";
  if (type.includes("zip") || type.includes("compressed") || type.includes("tar")) return "壓縮檔";
  if (type.startsWith("text/")) return "文字文件";
  const extension = item.name.includes(".") ? item.name.split(".").at(-1) : "";
  return extension ? `${extension.toUpperCase()} 檔案` : "檔案";
}

export function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export const errorMessage = (error: unknown, fallback = "操作失敗") => (error instanceof Error && error.message ? error.message : fallback);
