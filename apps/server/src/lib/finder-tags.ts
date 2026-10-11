import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
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
          const tags = decodeFinderTags(value);
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

/** Reads tolerate a non-zero exit, which both tools use for files without the attribute; writes pass `strict`. */
function run(command: string, args: string[], cwd: string, strict = false): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" }, (error, stdout) => {
      if (error && (strict || typeof error.code === "string" || error.killed)) reject(error);
      else resolve(stdout);
    });
  });
}

// `xattr -px` prints "./name: " and then the value as rows of hex bytes.
async function readDarwin(directory: string, names: string[], attribute = ATTRIBUTE): Promise<Map<string, Buffer>> {
  const stdout = await run("/usr/bin/xattr", ["-px", attribute, ...names.map((name) => `./${name}`)], directory);
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

// Linux keeps the attribute under whichever name the software serving macOS clients gave it.
const LINUX_ATTRIBUTE = `user.${ATTRIBUTE}`;
const SAMBA_ATTRIBUTE = `user.DosStream.${ATTRIBUTE}:$DATA`;
const isTagAttribute = (attribute: string) => attribute.includes("_kMDItemUserTags");

// `getfattr -e hex` prints "# file: name" and then "attribute=0x…" lines.
async function getfattr(directory: string, pattern: string, names: string[]): Promise<Map<string, Map<string, Buffer>>> {
  const stdout = await run("getfattr", ["-h", "-d", "-e", "hex", "-m", pattern, "--", ...names.map((name) => `./${name}`)], directory);
  const files = new Map<string, Map<string, Buffer>>();
  let current: Map<string, Buffer> | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("# file: ")) {
      // The leading "./" the names were given with is dropped again in the output.
      current = new Map();
      files.set(unescapeOctal(line.slice("# file: ".length).replace(/^\.\//, "")), current);
    } else if (current) {
      const separator = line.lastIndexOf("=0x");
      if (separator !== -1) current.set(line.slice(0, separator), Buffer.from(line.slice(separator + 3), "hex"));
    }
  }
  return files;
}

// Matching on the name's tail finds both LINUX_ATTRIBUTE and SAMBA_ATTRIBUTE.
async function readLinux(directory: string, names: string[]): Promise<Map<string, Buffer>> {
  const values = new Map<string, Buffer>();
  for (const [name, attributes] of await getfattr(directory, "_kMDItemUserTags", names)) {
    const value = [...attributes].find(([attribute]) => isTagAttribute(attribute))?.[1];
    if (value) values.set(name, value);
  }
  return values;
}

// Finder also keeps the colour of the last coloured tag as a label in the entry's Finder info, and shows that
// label as a tag when the tags themselves are gone.
const FINDER_INFO = "com.apple.FinderInfo";
const LINUX_FINDER_INFO = `user.${FINDER_INFO}`;
const SAMBA_FINDER_INFO = "user.DosStream.AFP_AfpInfo:$DATA";
/** Where Finder info starts in the AFP_AfpInfo stream a Mac keeps it in over SMB. */
export const AFP_INFO_OFFSET = 16;
const FINDER_INFO_SIZE = 32;
const LABEL_BYTE = 9;
const LABEL_MASK = 0x0e;

const SAMBA_EVIDENCE = "^user\\.DosStream\\.|^user\\.DOSATTRIB$";
const EVIDENCE_NAMES = 200;

/** Finder info with the label set to that of `tags`, or null when it already is. */
export function relabel(info: Buffer, offset: number, tags: FinderTag[]): Buffer | null {
  if (info.length < offset + FINDER_INFO_SIZE) return null;
  const color = tags.filter((tag) => tag.color).at(-1)?.color;
  const next = Buffer.from(info);
  next[offset + LABEL_BYTE] = (next[offset + LABEL_BYTE]! & ~LABEL_MASK) | ((color ? colors.indexOf(color) + 1 : 0) << 1);
  return next.equals(info) ? null : next;
}

/**
 * Whether Samba serves this volume, told by the attributes it leaves on what its clients create or tag.
 * A folder made on the server itself has none, so its neighbours and the folders above it are looked at too.
 */
async function servedBySamba(directory: string, boundary: string): Promise<boolean> {
  for (let current = directory; ; current = path.dirname(current)) {
    const names = (await fsp.readdir(current).catch(() => [])).filter((name) => !name.includes("\n")).slice(0, EVIDENCE_NAMES);
    const found = await getfattr(current, SAMBA_EVIDENCE, [".", ...names]);
    if ([...found.values()].some((attributes) => attributes.size > 0)) return true;
    if (current === boundary || current === path.dirname(current)) return false;
  }
}

/**
 * Replaces the Finder tags of one entry of a directory; an empty list removes the attribute, as Finder does.
 * `boundary` is the folder not to look above when working out how the volume stores them.
 * Throws when the volume refuses the change.
 */
export async function writeFinderTags(directory: string, name: string, tags: FinderTag[], boundary = directory): Promise<void> {
  if (name.includes("\n")) throw new Error("Name cannot be tagged");
  const file = `./${name}`;
  const value = encodeFinderTags(tags);

  if (process.platform === "darwin") {
    if (tags.length > 0) await run("/usr/bin/xattr", ["-wx", ATTRIBUTE, value.toString("hex"), file], directory, true);
    else if ((await readDarwin(directory, [name])).has(name)) await run("/usr/bin/xattr", ["-d", ATTRIBUTE, file], directory, true);
    const info = (await readDarwin(directory, [name], FINDER_INFO)).get(name);
    const relabelled = info && relabel(info, 0, tags);
    // Finder info of nothing but zeros reads as absent, and macOS refuses to store it.
    if (relabelled?.some((byte) => byte !== 0)) await run("/usr/bin/xattr", ["-wx", FINDER_INFO, relabelled.toString("hex"), file], directory, true);
    else if (relabelled) await run("/usr/bin/xattr", ["-d", FINDER_INFO, file], directory, true);
    return;
  }

  // The entry's own attributes say how this volume stores them.
  const found = (await getfattr(directory, `_kMDItemUserTags|${SAMBA_EVIDENCE}|^user\\.com\\.apple\\.FinderInfo$`, [name])).get(name) ?? new Map<string, Buffer>();
  const set = (attribute: string, data: Buffer) => run("setfattr", ["-h", "-n", attribute, "-v", `0x${data.toString("hex")}`, "--", file], directory, true);
  for (const [attribute, offset] of [[LINUX_FINDER_INFO, 0], [SAMBA_FINDER_INFO, AFP_INFO_OFFSET]] as const) {
    const info = found.get(attribute);
    const relabelled = info && relabel(info, offset, tags);
    if (relabelled) await set(attribute, relabelled);
  }
  const existing = [...found.keys()].filter(isTagAttribute);
  if (tags.length === 0) {
    for (const attribute of existing) await run("setfattr", ["-h", "-x", attribute, "--", file], directory, true);
    return;
  }
  const samba = [...found.keys()].some((attribute) => !isTagAttribute(attribute) && attribute !== LINUX_FINDER_INFO) || (await servedBySamba(directory, boundary));
  for (const attribute of existing.length > 0 ? existing : [samba ? SAMBA_ATTRIBUTE : LINUX_ATTRIBUTE]) {
    // Samba expects stream data to end with a NUL.
    await set(attribute, attribute.startsWith("user.DosStream.") ? Buffer.concat([value, Buffer.alloc(1)]) : value);
  }
}

/** Tags as the value Finder keeps them in. */
export function encodeFinderTags(tags: FinderTag[]): Buffer {
  return encodeStringArray(tags.map((tag) => (tag.color ? `${tag.name}\n${colors.indexOf(tag.color) + 1}` : tag.name)));
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

/** The tags in the value Finder keeps them as; none when it is not one. */
export function decodeFinderTags(value: Buffer): FinderTag[] {
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

/** Writes an array of strings as a binary property list. */
function encodeStringArray(strings: string[]): Buffer {
  // Type in the high nibble, length in the low one; lengths of 15 and up follow as an integer object.
  const marker = (type: number, length: number) => {
    if (length < 15) return Buffer.from([(type << 4) | length]);
    const long = Buffer.alloc(4);
    long[0] = (type << 4) | 0x0f;
    long[1] = 0x11;
    long.writeUInt16BE(length, 2);
    return long;
  };
  const objects = [
    Buffer.concat([marker(0xa, strings.length), Buffer.from(strings.map((_, index) => index + 1))]),
    ...strings.map((value) =>
      /^[\x00-\x7f]*$/.test(value)
        ? Buffer.concat([marker(0x5, value.length), Buffer.from(value, "latin1")])
        : Buffer.concat([marker(0x6, value.length), Buffer.from(value, "utf16le").swap16()])
    )
  ];
  const offsets = Buffer.alloc(objects.length * 2);
  let offset = 8;
  objects.forEach((object, index) => {
    offsets.writeUInt16BE(offset, index * 2);
    offset += object.length;
  });
  const trailer = Buffer.alloc(32);
  trailer[6] = 2; // bytes per offset
  trailer[7] = 1; // bytes per object reference
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(offset), 24);
  return Buffer.concat([Buffer.from("bplist00", "latin1"), ...objects, offsets, trailer]);
}
