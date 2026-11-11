/**
 * The messages Kago and a plugin's frame send each other. Kago's interface and every plugin import these, so the
 * wire format is written down once. Both ends parse what arrives with the functions below and drop anything else:
 * a frame is someone else's code, and a message from it is data, never a command to be trusted as typed.
 */

export const API_VERSION = 1;

/** The most a plugin gets back from one read. A larger range is cut short, and the plugin asks again from there. */
export const MAX_READ_BYTES = 8 * 1024 * 1024;

export type FileInfo = { name: string; size: number; type: string; mtime: number };

export type ThemeMode = "light" | "dark";
export type Theme = { mode: ThemeMode; tokens: Record<string, string> };

/**
 * The custom properties of Kago's theme that a plugin is handed, under the names Kago gives them. `kago.css` is
 * written against these, so a plugin that draws with it follows the theme without knowing its values.
 */
export const THEME_TOKENS = [
  "--kago-surface",
  "--kago-surface-elevated",
  "--kago-border",
  "--kago-border-strong",
  "--kago-text",
  "--kago-text-muted",
  "--kago-text-faint",
  "--kago-accent",
  "--kago-accent-fg",
  "--kago-hover",
  "--kago-sunk",
  "--kago-sunk-shadow",
  "--kago-glass",
  "--kago-glass-edge",
  "--kago-seam",
  "--kago-shadow-popup",
  "--kago-selection",
  "--kago-primary-ring",
  "--kago-radius-md",
  "--kago-radius-lg",
  "--kago-control-h",
  "--kago-font-size",
  "--font-sans"
] as const;

export type FailReason = "unsupported" | "unreadable";

export type HostMessage =
  | { kind: "init"; api: typeof API_VERSION; file: FileInfo; locale: string; theme: Theme; focused: boolean }
  | { kind: "focus"; focused: boolean }
  | { kind: "theme"; theme: Theme }
  | { kind: "read:ok"; id: number; bytes: ArrayBuffer }
  | { kind: "read:error"; id: number }
  | { kind: "storage:value"; id: number; value: string | null };

export type KeyChord = { key: string; code: string; meta: boolean; ctrl: boolean; shift: boolean; alt: boolean };

export type PluginMessage =
  | { kind: "hello"; api: typeof API_VERSION }
  /** Bytes `start` up to, not including, `end`. */
  | { kind: "read"; id: number; start: number; end: number }
  /** Kago shows the file could not be previewed, with its own way to download it. `message` says why, in the plugin's words. */
  | { kind: "fail"; reason: FailReason; message?: string }
  | { kind: "download" }
  | { kind: "storage:get"; id: number; key: string }
  | { kind: "storage:set"; key: string; value: string }
  /** The pointer went down inside the frame, which Kago's window never hears of: its window comes to the front. */
  | { kind: "activate" }
  /** A key pressed inside the frame that Kago may have a shortcut for. Only chords with a modifier, and Escape. */
  | ({ kind: "key" } & KeyChord);

type Shape = Record<string, unknown>;

const isObject = (value: unknown): value is Shape => typeof value === "object" && value !== null;
const isString = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;
const isBool = (value: unknown): value is boolean => typeof value === "boolean";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** Whether a key pressed inside a frame is one Kago is told of. Plain typing stays the plugin's own. */
export const isForwardedKey = (chord: Pick<KeyChord, "key" | "meta" | "ctrl" | "alt">) => chord.meta || chord.ctrl || chord.alt || chord.key === "Escape";

/** A message from a frame, or null for anything that is not one exactly as written above. */
export function parsePluginMessage(data: unknown): PluginMessage | null {
  if (!isObject(data)) return null;
  switch (data.kind) {
    case "hello":
      return data.api === API_VERSION ? { kind: "hello", api: API_VERSION } : null;
    case "read":
      return isCount(data.id) && isCount(data.start) && isCount(data.end) && data.end >= data.start ? { kind: "read", id: data.id, start: data.start, end: data.end } : null;
    case "fail":
      if (data.reason !== "unsupported" && data.reason !== "unreadable") return null;
      if (data.message !== undefined && !isString(data.message, 500)) return null;
      return { kind: "fail", reason: data.reason, ...(data.message === undefined ? {} : { message: data.message }) };
    case "download":
      return { kind: "download" };
    case "storage:get":
      return isCount(data.id) && isString(data.key, 100) ? { kind: "storage:get", id: data.id, key: data.key } : null;
    case "storage:set":
      return isString(data.key, 100) && isString(data.value, 64 * 1024) ? { kind: "storage:set", key: data.key, value: data.value } : null;
    case "activate":
      return { kind: "activate" };
    case "key": {
      const { key, code, meta, ctrl, shift, alt } = data;
      if (!isString(key, 32) || !isString(code, 32) || !isBool(meta) || !isBool(ctrl) || !isBool(shift) || !isBool(alt)) return null;
      const chord = { key, code, meta, ctrl, shift, alt };
      return isForwardedKey(chord) ? { kind: "key", ...chord } : null;
    }
    default:
      return null;
  }
}

function parseTheme(value: unknown): Theme | null {
  if (!isObject(value) || (value.mode !== "light" && value.mode !== "dark") || !isObject(value.tokens)) return null;
  const tokens: Record<string, string> = {};
  for (const name of THEME_TOKENS) {
    const token = value.tokens[name];
    if (isString(token)) tokens[name] = token;
  }
  return { mode: value.mode, tokens };
}

function parseFile(value: unknown): FileInfo | null {
  if (!isObject(value) || !isString(value.name) || !isCount(value.size) || !isString(value.type) || typeof value.mtime !== "number") return null;
  return { name: value.name, size: value.size, type: value.type, mtime: value.mtime };
}

/** A message from Kago, or null for anything that is not one. */
export function parseHostMessage(data: unknown): HostMessage | null {
  if (!isObject(data)) return null;
  switch (data.kind) {
    case "init": {
      const file = parseFile(data.file);
      const theme = parseTheme(data.theme);
      if (data.api !== API_VERSION || !file || !theme || !isString(data.locale, 35) || !isBool(data.focused)) return null;
      return { kind: "init", api: API_VERSION, file, locale: data.locale, theme, focused: data.focused };
    }
    case "focus":
      return isBool(data.focused) ? { kind: "focus", focused: data.focused } : null;
    case "theme": {
      const theme = parseTheme(data.theme);
      return theme ? { kind: "theme", theme } : null;
    }
    case "read:ok":
      return isCount(data.id) && data.bytes instanceof ArrayBuffer ? { kind: "read:ok", id: data.id, bytes: data.bytes } : null;
    case "read:error":
      return isCount(data.id) ? { kind: "read:error", id: data.id } : null;
    case "storage:value":
      return isCount(data.id) && (data.value === null || isString(data.value, 64 * 1024)) ? { kind: "storage:value", id: data.id, value: data.value } : null;
    default:
      return null;
  }
}
