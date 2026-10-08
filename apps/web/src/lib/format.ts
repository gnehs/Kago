import type { FileItem } from "../types/kago";
import { locale, t } from "./i18n";

export function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(2)} GB`;
}

/** Rounded so a countdown reads calmly: seconds under a minute, then minutes, then hours and minutes. */
export function formatDuration(seconds: number) {
  const total = Math.max(1, Math.round(seconds));
  if (total < 60) return t("{seconds}s", { seconds: total });
  if (total < 3600) return t("{minutes}m {seconds}s", { minutes: Math.floor(total / 60), seconds: total % 60 });
  return t("{hours}h {minutes}m", { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60) });
}

/** A playhead position: 1:05, or 1:02:05 once `long` (the whole length reaches an hour). */
export function formatClock(seconds: number, long = seconds >= 3600) {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor((total % 3600) / 60);
  const tail = String(total % 60).padStart(2, "0");
  return long ? `${Math.floor(total / 3600)}:${String(minutes).padStart(2, "0")}:${tail}` : `${Math.floor(total / 60)}:${tail}`;
}

const dateFormat = new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

/** File mtimes are milliseconds; database timestamps are unix seconds. */
export const formatDate = (ms: number) => dateFormat.format(new Date(ms));
export const formatUnixDate = (seconds: number) => dateFormat.format(new Date(seconds * 1000));

/** Files the video player takes; RealMedia has no `video/` type of its own. */
export const isVideoType = (type: string) => type.startsWith("video/") || type.startsWith("application/vnd.rn-realmedia");

// What a browser can show by itself. Anything else handed to it is not displayed but saved to disk.
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/apng", "image/x-icon", "image/vnd.microsoft.icon"]);
const AUDIO_TYPES = new Set(["audio/mpeg", "audio/mp4", "audio/x-m4a", "audio/aac", "audio/x-aac", "audio/ogg", "audio/wav", "audio/wave", "audio/x-wav", "audio/flac", "audio/x-flac", "audio/webm"]);

export const isImageType = (type: string) => IMAGE_TYPES.has(type);

const HEIF_EXTENSIONS = new Set(["heic", "heif", "hif", "heics", "heifs"]);
const RAW_EXTENSIONS = new Set("3fr arw cr2 cr3 crw dcr dng erf fff iiq k25 kdc mef mos mrw nef nrw orf pef raf raw rw2 rwl sr2 srf srw x3f".split(" "));

export const isRawName = (name: string) => RAW_EXTENSIONS.has(extensionOf(name.toLowerCase()));
/** Pictures no browser decodes, which the server turns into JPEGs: HEIF from phones and cameras, and camera RAW. */
export const isConvertedImage = (item: Pick<FileItem, "kind" | "name">) => item.kind === "file" && (HEIF_EXTENSIONS.has(extensionOf(item.name.toLowerCase())) || isRawName(item.name));
/** Anything that may carry shooting data. */
export const isPicture = (item: Pick<FileItem, "kind" | "type" | "name">) => item.kind === "file" && (item.type.startsWith("image/") || isConvertedImage(item));
export const isAudioType = (type: string) => AUDIO_TYPES.has(type);

/** The editor holds a file whole; the server refuses to save anything larger. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

const TEXT_TYPES = new Set(["application/json", "application/ld+json", "application/manifest+json", "application/xml", "application/javascript", "application/x-sh", "application/toml", "application/sql", "application/yaml", "application/x-httpd-php", "application/x-subrip"]);
const TEXT_EXTENSIONS = new Set(
  "txt md markdown log csv tsv json jsonc json5 ndjson yml yaml toml ini conf cfg env properties xml html htm css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte astro py rb php java kt kts swift go rs c h cc cpp cxx hpp cs m mm sh bash zsh fish ps1 bat cmd sql lua pl r dart scala clj ex exs erl hs elm tf hcl nix gradle cmake diff patch srt ass ssa vtt lrc tex bib rst adoc proto graphql gql lock gitignore gitattributes editorconfig dockerignore npmrc".split(" ")
);
const TEXT_NAMES = new Set(["dockerfile", "makefile", "license", "readme", "changelog", "caddyfile", "gemfile", "rakefile", "procfile"]);

const extensionOf = (name: string) => (name.includes(".") ? name.split(".").at(-1)!.toLowerCase() : "");

/**
 * Files the text editor opens. The name decides before the type does: `.ts` is registered as a video
 * container, and a TypeScript file is the one that fits in an editor.
 */
export function isTextFile(item: Pick<FileItem, "kind" | "type" | "name" | "size">) {
  if (item.kind !== "file" || item.size > MAX_TEXT_BYTES) return false;
  return hasTextName(item.name) || (!isVideoType(item.type) && (item.type.startsWith("text/") || TEXT_TYPES.has(item.type)));
}

/** True for a name that says text whatever the type registry makes of it. */
export function hasTextName(value: string) {
  const name = value.toLowerCase();
  return TEXT_EXTENSIONS.has(extensionOf(name)) || TEXT_NAMES.has(name) || name.startsWith(".env");
}

/** `.db` is a guess; the server checks the file's header before reading it as a database. */
export const isSqliteFile = (item: Pick<FileItem, "kind" | "type" | "name">) =>
  item.kind === "file" && (item.type === "application/vnd.sqlite3" || item.type === "application/x-sqlite3" || ["sqlite", "sqlite3", "db", "db3", "s3db", "sl3"].includes(extensionOf(item.name)));

/** Gaussian splat scenes. `.ply` is a guess, since a mesh is saved under the same name; the viewer reads the header before drawing it. */
export const isSplatFile = (item: Pick<FileItem, "kind" | "name">) => item.kind === "file" && ["ply", "sog", "splat"].includes(extensionOf(item.name));

export type OfficeKind = "document" | "sheet" | "slides";

const OFFICE_KINDS: Record<string, OfficeKind> = { docx: "document", xlsx: "sheet", xlsm: "sheet", xls: "sheet", ods: "sheet", pptx: "slides" };

/** Office files the browser can lay out itself. The old binary `.doc` and `.ppt` are not among them. */
export const officeKind = (item: Pick<FileItem, "kind" | "name">): OfficeKind | null => (item.kind === "file" ? OFFICE_KINDS[extensionOf(item.name)] ?? null : null);

export function kindLabel(item: Pick<FileItem, "kind" | "type" | "name">) {
  if (item.kind === "folder") return t("Folder");
  const type = item.type;
  if (isRawName(item.name)) return t("RAW image");
  if (type.startsWith("image/") || isConvertedImage(item)) return t("Image");
  if (type.startsWith("video/") && !hasTextName(item.name)) return t("Video");
  if (type.startsWith("audio/")) return t("Audio");
  if (type === "application/pdf") return t("PDF document");
  if (type.includes("zip") || type.includes("compressed") || type.includes("tar")) return t("Archive");
  if (type.startsWith("text/")) return t("Text document");
  if (type === "application/vnd.sqlite3" || type === "application/x-sqlite3") return t("SQLite database");
  const extension = item.name.includes(".") ? item.name.split(".").at(-1) : "";
  return extension ? t("{extension} file", { extension: extension.toUpperCase() }) : t("File");
}

export const errorMessage = (error: unknown, fallback = t("Something went wrong")) => (error instanceof Error && error.message ? error.message : fallback);
