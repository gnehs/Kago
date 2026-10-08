import { hasTextName, isConvertedImage, isMusicFile, isSqliteFile, isVideoType } from "@/lib/format";
import type { FileItem } from "@/types/kago";

/** The families of files Kago draws differently. Each has a mark, and most a colour, of its own. */
export type FileKind = "folder" | "image" | "video" | "audio" | "archive" | "pdf" | "document" | "sheet" | "slides" | "code" | "text" | "database" | "file";

type KindItem = Pick<FileItem, "kind" | "type" | "name">;

const words = (list: string) => new Set(list.split(" "));
const ARCHIVES = words("zip tar gz tgz bz2 tbz2 xz txz zst 7z rar cab iso dmg");
const DOCUMENTS = words("doc docx odt rtf pages");
const SHEETS = words("xls xlsx xlsm ods numbers csv tsv");
const SLIDES = words("ppt pptx odp key");
const PROSE = words("txt md markdown log rst adoc tex bib srt ass ssa vtt lrc");

/** The part of a name after its last dot, in lower case; empty for a name without one, or a dotfile. */
export function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** The name decides before the type does, as it does everywhere else: `.ts` is TypeScript, not a video. */
export function fileKind(item: KindItem): FileKind {
  if (item.kind === "folder") return "folder";
  const extension = extensionOf(item.name);
  const type = item.type;
  if (SHEETS.has(extension)) return "sheet";
  if (hasTextName(item.name)) return PROSE.has(extension) || !extension ? "text" : "code";
  if (type.startsWith("image/") || isConvertedImage(item)) return "image";
  if (isVideoType(type)) return "video";
  if (extension === "cue" || isMusicFile(item)) return "audio";
  if (type === "application/pdf") return "pdf";
  if (ARCHIVES.has(extension)) return "archive";
  if (DOCUMENTS.has(extension)) return "document";
  if (SLIDES.has(extension)) return "slides";
  if (isSqliteFile(item)) return "database";
  if (type.startsWith("text/")) return "text";
  return "file";
}

const PICTURES = words("jpg jpeg jpe png gif webp avif bmp tif tiff svg ico apng psd");
const FILMS = words("mp4 m4v mov mkv webm avi wmv flv mpg mpeg m2ts mts 3gp ogv rm rmvb vob");
const SOUNDS = words("mp3 m4a aac flac wav ogg oga opus wma aif aiff alac ape mid midi");

/** The kind of a file of which only the ending of its name is known. */
export function kindOfExtension(extension: string): FileKind {
  if (!extension) return "file";
  const named = fileKind({ kind: "file", name: `a.${extension}`, type: "" });
  if (named !== "file") return named;
  if (PICTURES.has(extension)) return "image";
  if (FILMS.has(extension)) return "video";
  if (SOUNDS.has(extension)) return "audio";
  return extension === "pdf" ? "pdf" : "file";
}

/** Each broad kind has its own colour, so a mixed folder can be read by scanning the icons. */
export const KIND_TONES: Record<FileKind, string> = {
  folder: "text-folder",
  image: "text-kind-image",
  video: "text-kind-video",
  audio: "text-kind-audio",
  archive: "text-kind-archive",
  pdf: "text-kind-document",
  document: "text-kind-document",
  sheet: "text-kind-sheet",
  slides: "text-kind-slides",
  code: "text-kind-code",
  text: "text-muted",
  database: "text-muted",
  file: "text-muted"
};

/** Documents whose file may hold a preview picture of its first page; the server looks for it. */
const PREVIEWED_DOCUMENTS = words("docx docm xlsx xlsm pptx pptm ppsx odt ods odp pages numbers key");

/**
 * What the contents of a file can be shown as on its icon, if anything:
 * a picture, a frame of a video, the first page of a document, or its opening lines of text.
 */
export function thumbnailKind(item: Pick<FileItem, "kind" | "type" | "name" | "size">): "picture" | "video" | "page" | "text" | null {
  if (item.kind !== "file" || item.size === 0) return null;
  const kind = fileKind(item);
  if (kind === "image") return "picture";
  if (kind === "video") return "video";
  if (kind === "pdf") return "page";
  if (hasTextName(item.name) || item.type.startsWith("text/")) return "text";
  return PREVIEWED_DOCUMENTS.has(extensionOf(item.name)) ? "page" : null;
}
