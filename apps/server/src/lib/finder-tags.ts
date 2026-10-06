import { execFile } from "node:child_process";
import { logger } from "./logger.js";

/** A tag set in macOS Finder. Kago only reads these; its own tags live in the DB. */
export type FinderTag = { name: string; color: FinderTagColor | null };

export type FinderTagColor = (typeof colors)[number];

// Finder stores each tag as "name\n<index>", the index pointing into this list (0 is no colour).
const colors = ["gray", "green", "purple", "blue", "yellow", "red", "orange"] as const;

const ATTRIBUTE = "com.apple.metadata:_kMDItemUserTags";
const CHUNK_SIZE = 500;
const TIMEOUT_MS = 10_000;

// Node has no xattr API, so the platform's own tool reads them. Set once it turns out to be missing.
let unavailable = false;

/**
 * Finder tags of the named entries of a directory. Entries without tags are left out.
 * Never throws: a volume without xattr support, or a missing tool, only means no tags.
 */
export async function readFinderTags(directory: string, names: string[]): Promise<Map<string, FinderTag[]>> {
  const result = new Map<string, FinderTag[]>();
  // A newline in a name cannot be told apart from the tool's own line breaks.
  const readable = names.filter((name) => !name.includes("\n"));
  if (unavailable || readable.length === 0) return result;

  const chunks: string[][] = [];
  for (let index = 0; index < readable.length; index += CHUNK_SIZE) chunks.push(readable.slice(index, index + CHUNK_SIZE));
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const values = process.platform === "darwin" ? await readDarwin(directory, chunk) : await readLinux(directory, chunk);
        for (const [name, value] of values) {
          const tags = parseTags(value);
          if (tags.length > 0) result.set(name, tags);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          if (!unavailable) logger.warn("Finder tags are unavailable: the xattr tool is not installed");
          unavailable = true;
        }
      }
    })
  );
  return result;
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      // Both tools exit non-zero when some of the files have no such attribute, with the rest still on stdout.
      if (error && (typeof error.code === "string" || error.killed)) reject(error);
      else resolve(stdout);
    });
  });
}

// `xattr -px` prints "./name: " and then the value as rows of hex bytes.
async function readDarwin(directory: string, names: string[]): Promise<Map<string, Buffer>> {
  const stdout = await run("/usr/bin/xattr", ["-px", ATTRIBUTE, ...names.map((name) => `./${name}`)], directory);
  const values = new Map<string, Buffer>();
  let current: string | null = names.length === 1 ? names[0]! : null;
  let hex = "";
  const flush = () => {
    if (current !== null && hex) values.set(current, Buffer.from(hex, "hex"));
    hex = "";
  };
  for (const line of stdout.split("\n")) {
    if (line.startsWith("./") && line.endsWith(": ")) {
      flush();
      current = line.slice(2, -2);
    } else {
      hex += line.replaceAll(" ", "");
    }
  }
  flush();
  return values;
}

// `getfattr -e hex` prints "# file: name" and then "attribute=0x…" lines.
// Matching on the name's tail also finds the copies Linux keeps for macOS clients, such as
// "user.com.apple.metadata:_kMDItemUserTags" and Samba's "user.DosStream.…:$DATA".
async function readLinux(directory: string, names: string[]): Promise<Map<string, Buffer>> {
  const stdout = await run("getfattr", ["-h", "-d", "-e", "hex", "-m", "_kMDItemUserTags", "--", ...names.map((name) => `./${name}`)], directory);
  const values = new Map<string, Buffer>();
  let current: string | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("# file: ")) {
      // The leading "./" the names were given with is dropped again in the output.
      current = unescapeOctal(line.slice("# file: ".length).replace(/^\.\//, ""));
    } else if (current !== null) {
      const separator = line.lastIndexOf("=0x");
      if (separator !== -1 && line.slice(0, separator).includes("_kMDItemUserTags") && !values.has(current)) values.set(current, Buffer.from(line.slice(separator + 3), "hex"));
    }
  }
  return values;
}

// getfattr writes bytes outside printable ASCII, and the backslash itself, as \ooo.
function unescapeOctal(value: string): string {
  if (!value.includes("\\")) return value;
  const bytes: number[] = [];
  const raw = Buffer.from(value, "utf8");
  for (let index = 0; index < raw.length; index++) {
    const octal = raw[index] === 0x5c ? raw.subarray(index + 1, index + 4).toString("latin1") : "";
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      index += 3;
    } else if (raw[index] === 0x5c && raw[index + 1] === 0x5c) {
      bytes.push(0x5c);
      index += 1;
    } else {
      bytes.push(raw[index]!);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function parseTags(value: Buffer): FinderTag[] {
  // Samba stores stream data with a trailing NUL, which would shift the plist trailer.
  const entries = parseStringArray(value) ?? (value.at(-1) === 0 ? parseStringArray(value.subarray(0, -1)) : null) ?? [];
  const tags: FinderTag[] = [];
  for (const entry of entries) {
    const [name, index] = entry.split("\n");
    if (!name || tags.some((tag) => tag.name === name)) continue;
    tags.push({ name, color: colors[Number(index) - 1] ?? null });
  }
  return tags;
}

/** Reads a binary property list holding an array of strings, which is all Finder writes here. */
function parseStringArray(data: Buffer): string[] | null {
  try {
    if (data.length < 40 || data.toString("latin1", 0, 6) !== "bplist") return null;
    const trailer = data.length - 32;
    const offsetSize = data[trailer + 6]!;
    const refSize = data[trailer + 7]!;
    const objectCount = Number(data.readBigUInt64BE(trailer + 8));
    const topObject = Number(data.readBigUInt64BE(trailer + 16));
    const offsetTable = Number(data.readBigUInt64BE(trailer + 24));
    const offsetOf = (object: number) => {
      if (object >= objectCount) throw new RangeError("Object out of range");
      return data.readUIntBE(offsetTable + object * offsetSize, offsetSize);
    };
    // Marker byte: type in the high nibble, length in the low one, 0xF meaning an integer object follows with the real length.
    const header = (offset: number) => {
      const marker = data[offset]!;
      if ((marker & 0x0f) !== 0x0f) return { type: marker >> 4, length: marker & 0x0f, start: offset + 1 };
      const bytes = 1 << (data[offset + 1]! & 0x0f);
      return { type: marker >> 4, length: data.readUIntBE(offset + 2, bytes), start: offset + 2 + bytes };
    };

    const array = header(offsetOf(topObject));
    if (array.type !== 0xa) return null;
    const strings: string[] = [];
    for (let index = 0; index < array.length; index++) {
      const item = header(offsetOf(data.readUIntBE(array.start + index * refSize, refSize)));
      if (item.type === 0x5) strings.push(data.toString("latin1", item.start, item.start + item.length));
      else if (item.type === 0x6) strings.push(Buffer.from(data.subarray(item.start, item.start + item.length * 2)).swap16().toString("utf16le"));
    }
    return strings;
  } catch {
    return null;
  }
}
