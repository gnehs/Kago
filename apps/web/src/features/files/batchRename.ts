import { isMusicFile, isPicture, isVideoType } from "@/lib/format";
import { t } from "@/lib/i18n";
import { nfc, parentPath } from "@/lib/paths";
import type { FileItem, ImageMetadata, MediaInfo } from "@/types/kago";

/** What a part of a pattern is set to. */
export type PartOptions = Record<string, string | number | boolean>;

/** One part of a naming pattern. Most write something onto the end of the name; a few change what is there so far. */
export type RenamePart = { key: string; type: string; options: PartOptions };

type PartField =
  | { key: string; kind: "text"; label: string; placeholder?: string }
  | { key: string; kind: "number"; label: string; min?: number; max?: number }
  | { key: string; kind: "check"; label: string; /** Shown only while the part is set this way. */ when?: (options: PartOptions) => boolean }
  | { key: string; kind: "select"; label: string; choices: Array<{ value: string; label: string }> };

/** What a part reads from the files themselves, which the server has to be asked for. */
export type PartSource = "photo" | "media";

export type PartKind = { type: string; group: string; label: string; fields: PartField[]; defaults: PartOptions; source?: PartSource };

const DATE_FORMATS = ["YYYYMMDD_HHmmss", "YYYY-MM-DD_HH-mm-ss", "YYYYMMDD", "YYYY-MM-DD", "HHmmss", "HH-mm-ss"].map((value) => ({ value, label: value }));
const CASES = [{ value: "lower", label: "lowercase" }, { value: "upper", label: "UPPERCASE" }];

const NAME = t("Name");
const PHOTO = t("Photo");
const MUSIC = t("Music");
const VIDEO = t("Video");

export const partKinds: PartKind[] = [
  { type: "text", group: NAME, label: t("Text"), fields: [{ key: "text", kind: "text", label: t("Text"), placeholder: t("Text to add") }], defaults: { text: "" } },
  { type: "original", group: NAME, label: t("Original name"), fields: [], defaults: {} },
  {
    type: "number",
    group: NAME,
    label: t("Number"),
    fields: [
      { key: "digits", kind: "select", label: t("Format"), choices: ["1, 2, 3", "01, 02, 03", "001, 002, 003", "0001, 0002, 0003", "00001, 00002, 00003"].map((label, index) => ({ value: String(index + 1), label })) },
      { key: "start", kind: "number", label: t("Start at"), min: 0 },
      { key: "step", kind: "number", label: t("Step"), min: 1 },
      { key: "perExtension", kind: "check", label: t("Count each file type separately") }
    ],
    defaults: { digits: "1", start: 1, step: 1, perExtension: false }
  },
  {
    type: "replace",
    group: NAME,
    label: t("Find and replace"),
    fields: [
      { key: "find", kind: "text", label: t("Find") },
      { key: "replace", kind: "text", label: t("Replace with") },
      { key: "regex", kind: "check", label: t("Regular expression") },
      { key: "all", kind: "check", label: t("Replace every match") }
    ],
    defaults: { find: "", replace: "", regex: false, all: true }
  },
  { type: "case", group: NAME, label: t("Change case"), fields: [{ key: "to", kind: "select", label: t("Change to"), choices: [...CASES, { value: "title", label: "Title Case" }] }], defaults: { to: "lower" } },
  {
    type: "substring",
    group: NAME,
    label: t("Keep part of the name"),
    fields: [
      { key: "start", kind: "number", label: t("From character"), min: 1 },
      { key: "length", kind: "number", label: t("Length"), min: 0 }
    ],
    defaults: { start: 1, length: 10 }
  },
  { type: "extension", group: NAME, label: t("Extension case"), fields: [{ key: "to", kind: "select", label: t("Change to"), choices: CASES }], defaults: { to: "lower" } },
  { type: "uuid", group: NAME, label: "UUID", fields: [], defaults: {} },
  {
    type: "random",
    group: NAME,
    label: t("Random characters"),
    fields: [
      { key: "length", kind: "number", label: t("Length"), min: 1, max: 64 },
      { key: "upper", kind: "check", label: "A–Z" },
      { key: "lower", kind: "check", label: "a–z" },
      { key: "digits", kind: "check", label: "0–9" }
    ],
    defaults: { length: 8, upper: true, lower: true, digits: true }
  },
  { type: "photo-date", group: PHOTO, label: t("Date taken"), source: "photo", fields: [{ key: "format", kind: "select", label: t("Format"), choices: DATE_FORMATS }], defaults: { format: "YYYYMMDD_HHmmss" } },
  {
    type: "photo",
    group: PHOTO,
    label: t("Photo info"),
    source: "photo",
    fields: [
      {
        key: "field",
        kind: "select",
        label: t("Info"),
        choices: [
          { value: "camera", label: t("Camera") },
          { value: "lens", label: t("Lens") },
          { value: "width", label: t("Width") },
          { value: "height", label: t("Height") },
          { value: "focalLength", label: t("Focal length") },
          { value: "aperture", label: t("Aperture") },
          { value: "exposureTime", label: t("Shutter speed") },
          { value: "iso", label: "ISO" }
        ]
      }
    ],
    defaults: { field: "camera" }
  },
  {
    type: "music",
    group: MUSIC,
    label: t("Song info"),
    source: "media",
    fields: [
      {
        key: "field",
        kind: "select",
        label: t("Info"),
        choices: [
          { value: "title", label: t("Title") },
          { value: "artist", label: t("Artist") },
          { value: "album", label: t("Album") },
          { value: "albumArtist", label: t("Album artist") },
          { value: "track", label: t("Track number") },
          { value: "year", label: t("Year") },
          { value: "genre", label: t("Genre") }
        ]
      },
      { key: "pad", kind: "check", label: t("Two digits (01)"), when: (options) => options.field === "track" }
    ],
    defaults: { field: "title", pad: true }
  },
  {
    type: "video",
    group: VIDEO,
    label: t("Video info"),
    source: "media",
    fields: [
      {
        key: "field",
        kind: "select",
        label: t("Info"),
        choices: [
          { value: "width", label: t("Width") },
          { value: "height", label: t("Height") },
          { value: "fps", label: t("Frame rate") },
          { value: "bitrate", label: t("Bitrate (kbps)") },
          { value: "seconds", label: t("Length in seconds") },
          { value: "mm-ss", label: t("Length as mm-ss") },
          { value: "hh-mm-ss", label: t("Length as hh-mm-ss") }
        ]
      }
    ],
    defaults: { field: "width" }
  }
];

const kindOf = (type: string) => partKinds.find((kind) => kind.type === type);

let nextKey = 0;

export function makePart(type: string, options: PartOptions = {}): RenamePart {
  return { key: `part-${++nextKey}`, type, options: { ...kindOf(type)?.defaults, ...options } };
}

/** A pattern to start from. `example` is a name it makes. */
export type RenameTemplate = { id: string; label: string; example: string; parts: Array<[type: string, options?: PartOptions]> };

export const renameTemplates: RenameTemplate[] = [
  { id: "numbered", label: t("Numbered"), example: "IMG-001", parts: [["text", { text: "IMG-" }], ["number", { digits: "3" }]] },
  { id: "episodes", label: t("Episodes"), example: "Series Name S02E01", parts: [["text", { text: "Series Name" }], ["text", { text: " S02E" }], ["number", { digits: "2", perExtension: true }]] },
  { id: "taken", label: t("Date taken"), example: "20260412_153012", parts: [["photo-date"]] },
  {
    id: "photos",
    label: t("Camera and size"),
    example: "X-T5_0001_7728x5152",
    parts: [["photo", { field: "camera" }], ["text", { text: "_" }], ["number", { digits: "4", perExtension: true }], ["text", { text: "_" }], ["photo", { field: "width" }], ["text", { text: "x" }], ["photo", { field: "height" }]]
  },
  { id: "music", label: t("Track, artist and title"), example: "01. Artist - Title", parts: [["music", { field: "track", pad: true }], ["text", { text: ". " }], ["music", { field: "artist" }], ["text", { text: " - " }], ["music", { field: "title" }]] },
  {
    id: "video",
    label: t("Name and video details"),
    example: "Name_1920x1080_24fps",
    parts: [["original"], ["text", { text: "_" }], ["video", { field: "width" }], ["text", { text: "x" }], ["video", { field: "height" }], ["text", { text: "_" }], ["video", { field: "fps" }], ["text", { text: "fps" }]]
  },
  { id: "uuid", label: "UUID", example: "9f79a736-1c56-4f8a-b1e7-3ecae1d08c8f", parts: [["uuid"], ["extension", { to: "lower" }]] },
  { id: "random", label: t("Random characters"), example: "6pgwUF88", parts: [["random"]] }
];

/** What the server read from one file, as far as the pattern asks for it. */
export type RenameInfo = { photo?: ImageMetadata; media?: MediaInfo };

/** Which of the files a kind of info can be read from. */
export const readsFrom = (source: PartSource, item: FileItem) =>
  item.kind === "file" && (source === "photo" ? isPicture(item) : isVideoType(item.type) || isMusicFile(item));

/** What a pattern needs read from the files before it can name them. */
export const sourcesOf = (parts: RenamePart[]) => [...new Set(parts.flatMap((part) => kindOf(part.type)?.source ?? []))];

/** A folder's name is all stem; so is a dotfile's. */
function splitName(item: Pick<FileItem, "name" | "kind">) {
  const dot = item.kind === "file" ? item.name.lastIndexOf(".") : -1;
  return dot > 0 ? { stem: item.name.slice(0, dot), extension: item.name.slice(dot + 1) } : { stem: item.name, extension: "" };
}

const two = (value: number) => String(value).padStart(2, "0");

/** `taken` as the server words it, "2026-04-12 15:30:12", in one of the forms on offer. */
function formatTaken(taken: string | undefined, format: string) {
  const match = taken?.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  if (!match) return "";
  const [, year, month, day, hour, minute, second] = match;
  return format.replace("YYYY", year!).replace("MM", month!).replace("DD", day!).replace("HH", hour!).replace("mm", minute!).replace("ss", second!);
}

function photoField(photo: ImageMetadata | undefined, field: string) {
  if (!photo) return "";
  if (field === "aperture") return photo.aperture ? `f${photo.aperture}` : "";
  if (field === "iso") return photo.iso ? `ISO${photo.iso}` : "";
  const value = photo[field as "camera" | "lens" | "width" | "height" | "focalLength" | "exposureTime"];
  return value === undefined ? "" : String(value);
}

function musicField(media: MediaInfo | undefined, field: string, pad: boolean) {
  const tags = media?.tags;
  if (!tags) return "";
  if (field === "year") return tags.date.match(/\d{4}/)?.[0] ?? "";
  if (field !== "track") return tags[field as "title" | "artist" | "album" | "albumArtist" | "genre"] ?? "";
  // A track is often written with how many there are: "3/12".
  const track = tags.track.match(/\d+/)?.[0];
  return track ? (pad ? track.padStart(2, "0") : String(Number(track))) : "";
}

function videoField(media: MediaInfo | undefined, field: string) {
  if (!media) return "";
  const seconds = Math.round(media.duration);
  if (field === "seconds") return media.duration ? String(seconds) : "";
  if (field === "mm-ss") return media.duration ? `${two(Math.floor(seconds / 60))}-${two(seconds % 60)}` : "";
  if (field === "hh-mm-ss") return media.duration ? `${two(Math.floor(seconds / 3600))}-${two(Math.floor(seconds / 60) % 60)}-${two(seconds % 60)}` : "";
  if (field === "bitrate") return (media.video?.bitrate || media.bitrate) ? String(Math.round((media.video?.bitrate || media.bitrate) / 1000)) : "";
  if (!media.video) return "";
  if (field === "fps") return media.video.fps ? String(Number(media.video.fps.toFixed(2))) : "";
  return String(media.video[field as "width" | "height"] || "");
}

function randomCharacters(options: PartOptions) {
  const alphabet = `${options.upper ? "ABCDEFGHIJKLMNOPQRSTUVWXYZ" : ""}${options.lower ? "abcdefghijklmnopqrstuvwxyz" : ""}${options.digits ? "0123456789" : ""}`;
  const length = Math.min(Math.max(Math.floor(Number(options.length)) || 0, 0), 64);
  if (!alphabet || length === 0) return "";
  // Bytes past the last whole run of the alphabet are thrown again, so no character comes up more than another.
  const limit = 256 - (256 % alphabet.length);
  let text = "";
  while (text.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && text.length < length) text += alphabet[byte % alphabet.length];
    }
  }
  return text;
}

/** A version 4 UUID. `crypto.randomUUID` is only there in a secure context, which Kago served over plain HTTP is not. */
function uuid() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function changeCase(text: string, to: unknown) {
  if (to === "upper") return text.toUpperCase();
  if (to === "title") return text.toLowerCase().replace(/([^\s-])(\S*)/g, (_, first: string, rest: string) => first.toUpperCase() + rest);
  return text.toLowerCase();
}

function replaceIn(text: string, options: PartOptions) {
  const find = String(options.find ?? "");
  const replacement = String(options.replace ?? "");
  if (!find) return text;
  if (options.regex) return text.replace(new RegExp(find, options.all ? "gu" : "u"), replacement);
  return options.all ? text.split(find).join(replacement) : text.replace(find, () => replacement);
}

/** Why a name cannot be given, or that it is the one the file has. */
export type RenameProblem = "empty" | "invalid" | "long" | "clash";
export type RenameRow = { item: FileItem; name: string; changed: boolean; problem?: RenameProblem };
export type RenamePlan = { rows: RenameRow[]; /** A pattern that cannot be worked out at all, such as a regular expression that does not parse. */ error?: string };

/**
 * The name each of `items` gets from a pattern, in the order they are given, and what stands in the way of it.
 * `existing` is every path listed beside them. `drawn` keeps what was made up for a file (a UUID, random characters),
 * so it stays the same while the rest of the pattern is being changed.
 */
export function planRename(items: FileItem[], parts: RenamePart[], info: Map<string, RenameInfo>, existing: string[], drawn: Map<string, string>): RenamePlan {
  const split = items.map(splitName);
  let error: string | undefined;
  const names = items.map((item, index) => {
    const { stem, extension } = split[index]!;
    let name = "";
    let finalExtension = extension;
    for (const part of parts) {
      const options = part.options;
      // The parts that change a name work on what the pattern has made so far, or on the original while it has made nothing.
      const subject = name || stem;
      const draw = (make: () => string) => {
        const id = `${part.key}\n${item.path}\n${JSON.stringify(options)}`;
        if (!drawn.has(id)) drawn.set(id, make());
        return drawn.get(id)!;
      };
      switch (part.type) {
        case "text":
          name += String(options.text ?? "");
          break;
        case "original":
          name += stem;
          break;
        case "number": {
          // Counted among the files of its own type, when asked: an episode and its subtitles then share a number.
          const position = options.perExtension ? split.slice(0, index).filter((other) => other.extension.toLowerCase() === extension.toLowerCase()).length : index;
          const value = (Number(options.start) || 0) + position * (Number(options.step) || 1);
          name += String(value).padStart(Number(options.digits) || 1, "0");
          break;
        }
        case "replace":
          try {
            name = replaceIn(subject, options);
          } catch {
            error = t("The regular expression isn’t valid");
            name = subject;
          }
          break;
        case "case":
          name = changeCase(subject, options.to);
          break;
        case "substring": {
          const start = Math.max((Number(options.start) || 1) - 1, 0);
          name = [...subject].slice(start, start + Math.max(Number(options.length) || 0, 0)).join("");
          break;
        }
        case "extension":
          finalExtension = changeCase(extension, options.to);
          break;
        case "uuid":
          name += draw(uuid);
          break;
        case "random":
          name += draw(() => randomCharacters(options));
          break;
        case "photo-date":
          name += formatTaken(info.get(item.path)?.photo?.takenAt, String(options.format));
          break;
        case "photo":
          name += photoField(info.get(item.path)?.photo, String(options.field));
          break;
        case "music":
          name += musicField(info.get(item.path)?.media, String(options.field), Boolean(options.pad));
          break;
        case "video":
          name += videoField(info.get(item.path)?.media, String(options.field));
          break;
      }
    }
    // What a file says of itself may hold a slash ("1/250"), which no name can.
    const cleaned = nfc(name).replaceAll("/", "-").replaceAll("\\", "-").replaceAll("\0", "").trim();
    return { stem: cleaned, name: finalExtension ? `${cleaned}.${finalExtension}` : cleaned };
  });

  // Whatever is not being renamed keeps its name, and two of the batch cannot share one.
  const batch = new Set(items.map((item) => item.path));
  const taken = new Map<string, number>();
  const count = (path: string) => taken.set(path, (taken.get(path) ?? 0) + 1);
  for (const path of existing) if (!batch.has(path)) count(nfc(path));
  const targets = items.map((item, index) => `${parentPath(item.path) === "/" ? "" : nfc(parentPath(item.path))}/${names[index]!.name}`);
  targets.forEach(count);

  const rows = items.map((item, index): RenameRow => {
    const { stem, name } = names[index]!;
    const problem: RenameProblem | undefined = !stem ? "empty" : name === "." || name === ".." ? "invalid" : name.length > 255 ? "long" : taken.get(targets[index]!)! > 1 ? "clash" : undefined;
    return { item, name, changed: name !== item.name, problem };
  });
  return { rows, error };
}
