import type { FileItem } from "../types/kago";

export function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

const dateFormat = new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** File mtimes are milliseconds; database timestamps are unix seconds. */
export const formatDate = (ms: number) => dateFormat.format(new Date(ms));
export const formatUnixDate = (seconds: number) => dateFormat.format(new Date(seconds * 1000));

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
