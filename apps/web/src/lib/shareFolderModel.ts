import type { PublicShareInfo, ShareItem, ShareSortBy } from "@kago/contract";
import { nfc, normalizeLogicalPath, parentPath } from "./paths.ts";

/*
 * What the page a visitor lands on knows about a shared folder without asking anyone: where in it they are (kept in
 * the address, so back, reload and a link to one picture all work), how it is laid out, what the viewer steps
 * through, and what an error code means for them. The words are chosen by the components, which hold the
 * translations; this file says only which of them apply, so that node can test it.
 */

/** Whether a link is to a folder to look through, as against a file or a drop box. */
export const isFolderShare = (share: Pick<PublicShareInfo, "kind" | "mode">) => share.kind === "folder" && share.mode !== "upload_only";

/** Where in the shared folder the visitor is: the folder, and the file in it that is open, by name. */
export type FolderLocation = { path: string; open: string | null };

/** The location an address holds. Anything that is not a path below the shared folder is the folder itself. */
export function parseLocation(search: string): FolderLocation {
  const params = new URLSearchParams(search);
  const open = params.get("open");
  return { path: normalizeLogicalPath(params.get("path") ?? "/") ?? "/", open: open && !open.includes("/") && !open.includes("\0") ? nfc(open) : null };
}

/** The address' query for a location; empty for the shared folder itself. */
export function locationSearch({ path, open }: FolderLocation): string {
  const params = new URLSearchParams();
  if (path !== "/") params.set("path", path);
  if (open) params.set("open", open);
  const text = params.toString().replaceAll("%2F", "/");
  return text ? `?${text}` : "";
}

export type Crumb = { label: string; path: string };

/** The way from the shared folder to where the visitor is. It starts at the share, never above it. */
export function crumbs(shareName: string, path: string): Crumb[] {
  const parts = path.split("/").filter(Boolean);
  return [{ label: shareName, path: "/" }, ...parts.map((part, index) => ({ label: nfc(part), path: `/${parts.slice(0, index + 1).join("/")}` }))];
}

export const parentFolder = parentPath;

export type Layout = "grid" | "list";

const MOSTLY = 0.6;
const isPicture = (item: Pick<ShareItem, "type">) => item.type.startsWith("image/") || item.type.startsWith("video/");

/** Pictures and films are looked at, so a folder that is mostly them is a grid; anything else, and a folder of folders, is a list. */
export function layoutFor(items: readonly ShareItem[]): Layout {
  const files = items.filter((item) => item.kind === "file");
  return files.length > 0 && files.filter(isPicture).length / files.length >= MOSTLY ? "grid" : "list";
}

export type ShareSort = { by: ShareSortBy; direction: "asc" | "desc" };

export const DEFAULT_SORT: ShareSort = { by: "name", direction: "asc" };

/** The direction a column is sorted in when it is first picked: sizes and dates start largest or newest first, as in the file browser. */
export const firstDirection = (by: ShareSortBy): ShareSort["direction"] => (by === "size" || by === "mtime" ? "desc" : "asc");

/** Picking the column in use turns it round; picking another starts it in its first direction. */
export const toggleSort = (sort: ShareSort, by: ShareSortBy): ShareSort => (sort.by === by ? { by, direction: sort.direction === "asc" ? "desc" : "asc" } : { by, direction: firstDirection(by) });

/** What a folder holds, as the listing knows it. Its size is told only when every entry has been read and none is a folder, whose own contents the listing does not add up. */
export function folderTotals(items: readonly ShareItem[], total: number): { count: number; bytes: number | null } {
  const exact = items.length === total && items.every((item) => item.kind === "file");
  return { count: total, bytes: exact ? items.reduce((sum, item) => sum + item.size, 0) : null };
}

/** What the viewer draws a file as. */
export type ViewerKind = "image" | "video" | "audio" | "pdf" | "text" | null;

/** From the type the server sent, which is the one it checks before it will send the file inline. */
export function viewerKind(type: string): ViewerKind {
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type === "application/pdf") return "pdf";
  return type === "text/plain" ? "text" : null;
}

const GUESSED: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", bmp: "image/bmp", apng: "image/apng", ico: "image/x-icon",
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", wav: "audio/wav", flac: "audio/flac",
  mp4: "video/mp4", webm: "video/webm", pdf: "application/pdf", txt: "text/plain"
};

/** The type of a file known by its name alone, as when a link opens one before its folder has been read. Anything the server would not send inline is not guessed. */
export function guessType(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (GUESSED[name.slice(dot + 1).toLowerCase()] ?? "") : "";
}

/** The files of a folder that can be looked at, in the order the folder is shown. */
export const viewable = (items: readonly ShareItem[]) => items.filter((item) => item.kind === "file" && item.previewable);

/** Where an open file stands among the ones that can be looked at, and the two either side of it. `position` is null while the file is not among the entries read so far. */
export function neighbours(items: readonly ShareItem[], name: string): { position: number | null; count: number; previous: ShareItem | null; next: ShareItem | null } {
  const list = viewable(items);
  const index = list.findIndex((item) => nfc(item.name) === name);
  return { position: index < 0 ? null : index + 1, count: list.length, previous: list[index - 1] ?? null, next: index < 0 ? null : (list[index + 1] ?? null) };
}

/** What a request that was turned down means to a visitor. */
export type ShareFailure = "gone" | "expired" | "limit" | "password" | "revoked" | "changed" | "missing" | "too-large" | "busy" | "unsupported" | "forbidden" | "other";

const FAILURES: Record<string, ShareFailure> = {
  SHARE_NOT_FOUND: "gone",
  SHARE_EXPIRED: "expired",
  SHARE_LIMIT_REACHED: "limit",
  SHARE_PASSWORD_REQUIRED: "password",
  SHARE_OWNER_ACCESS_REVOKED: "revoked",
  FORBIDDEN: "revoked",
  SHARE_TARGET_NOT_FILE: "changed",
  SHARE_TARGET_NOT_FOLDER: "changed",
  PATH_NOT_FOUND: "missing",
  INVALID_PATH: "missing",
  NOT_FOLDER: "missing",
  NOT_FILE: "missing",
  SHARE_ZIP_TOO_LARGE: "too-large",
  SHARE_ZIP_BUSY: "busy",
  PREVIEW_UNSUPPORTED: "unsupported",
  SHARE_LIST_FORBIDDEN: "forbidden",
  SHARE_DOWNLOAD_FORBIDDEN: "forbidden",
  SHARE_PREVIEW_FORBIDDEN: "forbidden",
  SHARE_UPLOAD_FORBIDDEN: "forbidden"
};

export const failureOf = (code: string | undefined): ShareFailure => (code ? (FAILURES[code] ?? "other") : "other");

/** Failures after which the link as a whole is of no more use, so the page says so instead of showing a folder with a message over it. */
export const endsLink = (failure: ShareFailure) => failure === "gone" || failure === "expired" || failure === "limit" || failure === "revoked" || failure === "changed" || failure === "forbidden";

export type ShareEndpoint = "list" | "thumbnail" | "preview" | "download" | "zip";

/** The address of what a visitor asks a link for; `path` is below the shared folder. */
export function shareEndpoint(token: string, endpoint: ShareEndpoint, params: { path?: string; offset?: number; limit?: number; sortBy?: ShareSortBy; direction?: "asc" | "desc"; size?: "small" | "medium"; v?: number } = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) if (value !== undefined) query.set(key, String(value));
  const text = query.toString().replaceAll("%2F", "/");
  return `/s/${encodeURIComponent(token)}/${endpoint}${text ? `?${text}` : ""}`;
}

/** The entries to ask for next: a page at a time, and in bigger bites while looking for a file a link opened that has not been read yet. */
export const PAGE = 200;
export const SEARCH_PAGE = 1000;
