import fsp from "node:fs/promises";
import yauzl from "yauzl";

/**
 * Gaussian splats as they are drawn, in the coordinates of the file: `positions` and `scales` three numbers a splat,
 * scales linear; `rotations` four, w first, of length one; `colors` four, red, green and blue from 0 to 1 as seen
 * from any side, then how opaque it is. A cloud read from a large file holds only some of its splats.
 */
export type SplatCloud = { count: number; positions: Float32Array; scales: Float32Array; rotations: Float32Array; colors: Float32Array };

export type SplatFormat = "ply" | "splat" | "sog";

/** Reads a splat file into at most `budget` of its splats. Null for one that holds no splats this can read. */
type SplatDecoder = (file: string, budget: number) => Promise<SplatCloud | null>;

const SH_C0 = 0.28209479177387814;
/**
 * Splats are read in runs of this many, spread evenly over a file that holds more than are wanted. Files keep splats
 * near each other in space near each other in the file, so a long run would leave whole patches of the scene out.
 */
const BLOCK = 16;
/** Splats read in one go from a file read whole. */
const RUN = 4096;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_META_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

/** The runs of splats read out of `count`: all of them, or evenly spaced ones that add up to about `budget`. */
function blocks(count: number, budget: number): Array<{ start: number; length: number }> {
  const runs = [];
  if (count <= budget) {
    for (let start = 0; start < count; start += RUN) runs.push({ start, length: Math.min(RUN, count - start) });
    return runs;
  }
  const taken = Math.max(1, Math.floor(budget / BLOCK));
  for (let index = 0; index < taken; index++) {
    const start = Math.floor((index * count) / taken);
    runs.push({ start, length: Math.min(BLOCK, count - start) });
  }
  return runs;
}

function emptyCloud(count: number): SplatCloud {
  return { count, positions: new Float32Array(count * 3), scales: new Float32Array(count * 3), rotations: new Float32Array(count * 4), colors: new Float32Array(count * 4) };
}

/**
 * Where only one splat in so many is drawn, each is drawn larger so the ones left close most of the gaps between
 * them. Growing them by the square root of what they stand for would cover what all of them did, but blurs the
 * scene more than the gaps spoil it; the fourth root was the better of the two to look at.
 */
function compensate(cloud: SplatCloud, total: number): SplatCloud {
  const grow = Math.sqrt(Math.sqrt(total / cloud.count));
  if (grow > 1) for (let index = 0; index < cloud.scales.length; index++) cloud.scales[index]! *= grow;
  return cloud;
}

function setRotation(cloud: SplatCloud, at: number, w: number, x: number, y: number, z: number) {
  const length = Math.hypot(w, x, y, z) || 1;
  cloud.rotations[at * 4] = w / length;
  cloud.rotations[at * 4 + 1] = x / length;
  cloud.rotations[at * 4 + 2] = y / length;
  cloud.rotations[at * 4 + 3] = z / length;
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

type PlyLayout = { count: number; offset: number; stride: number; fields: Record<string, number> };
type PlyElement = { name: string; count: number; stride: number; fields: Record<string, number>; listed: boolean };

const PLY_SIZES: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 };
const PLY_FIELDS = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"] as const;

/**
 * Where the splats of a PLY file are and how each is laid out. A PLY may as well be a mesh or a point cloud, and the
 * splat trainers' compressed PLY keeps its splats packed into chunks; neither has the properties asked for here.
 */
function plyLayout(head: Buffer): PlyLayout | null {
  const end = head.indexOf("end_header\n");
  if (end < 0 || head.toString("latin1", 0, 4) !== "ply\n") return null;
  const lines = head.toString("latin1", 0, end).split("\n").map((line) => line.trim().split(/\s+/));
  if (!lines.some((words) => words[0] === "format" && words[1] === "binary_little_endian")) return null;
  let offset = end + "end_header\n".length;
  let element: PlyElement | null = null;
  const elements: PlyElement[] = [];
  for (const [keyword, ...words] of lines) {
    if (keyword === "element") {
      element = { name: words[0] ?? "", count: Number(words[1]), stride: 0, fields: {}, listed: false };
      elements.push(element);
    } else if (keyword === "property" && element) {
      if (words[0] === "list") element.listed = true;
      const size = PLY_SIZES[words[0] ?? ""];
      if (size === undefined || words[0] === "list") continue;
      if (size === 4 && (words[0] === "float" || words[0] === "float32")) element.fields[words[1] ?? ""] = element.stride;
      element.stride += size;
    }
  }
  for (const each of elements) {
    if (each.name === "vertex") {
      if (each.listed || !Number.isSafeInteger(each.count) || each.count <= 0 || !PLY_FIELDS.every((field) => field in each.fields)) return null;
      return { count: each.count, offset, stride: each.stride, fields: each.fields };
    }
    // An element of lists before the splats leaves no way to tell where they begin without reading it all.
    if (each.listed || !Number.isSafeInteger(each.count)) return null;
    offset += each.count * each.stride;
  }
  return null;
}

async function decodePly(file: string, budget: number): Promise<SplatCloud | null> {
  const handle = await fsp.open(file, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(MAX_HEADER_BYTES), 0, MAX_HEADER_BYTES, 0);
    const layout = plyLayout(buffer.subarray(0, bytesRead));
    if (!layout) return null;
    const { stride, fields } = layout;
    const at = PLY_FIELDS.map((field) => fields[field]!);
    const runs = blocks(layout.count, budget);
    const cloud = emptyCloud(runs.reduce((sum, run) => sum + run.length, 0));
    const chunk = Buffer.alloc(RUN * stride);
    let index = 0;
    for (const run of runs) {
      const { bytesRead: read } = await handle.read(chunk, 0, run.length * stride, layout.offset + run.start * stride);
      if (read < run.length * stride) return null;
      for (let splat = 0; splat < run.length; splat++, index++) {
        const base = splat * stride;
        const value = (field: number) => chunk.readFloatLE(base + at[field]!);
        for (let axis = 0; axis < 3; axis++) {
          cloud.positions[index * 3 + axis] = value(axis);
          cloud.colors[index * 4 + axis] = 0.5 + SH_C0 * value(3 + axis);
          cloud.scales[index * 3 + axis] = Math.exp(value(7 + axis));
        }
        cloud.colors[index * 4 + 3] = sigmoid(value(6));
        setRotation(cloud, index, value(10), value(11), value(12), value(13));
      }
    }
    return compensate(cloud, layout.count);
  } finally {
    await handle.close();
  }
}

/** The older layout of 32 bytes a splat: position and scale as floats, then colour and rotation a byte each part. */
async function decodeSplat(file: string, budget: number): Promise<SplatCloud | null> {
  const handle = await fsp.open(file, "r");
  try {
    const total = Math.floor((await handle.stat()).size / 32);
    if (total === 0) return null;
    const runs = blocks(total, budget);
    const cloud = emptyCloud(runs.reduce((sum, run) => sum + run.length, 0));
    const chunk = Buffer.alloc(RUN * 32);
    let index = 0;
    for (const run of runs) {
      await handle.read(chunk, 0, run.length * 32, run.start * 32);
      for (let splat = 0; splat < run.length; splat++, index++) {
        const base = splat * 32;
        for (let axis = 0; axis < 3; axis++) {
          cloud.positions[index * 3 + axis] = chunk.readFloatLE(base + axis * 4);
          cloud.scales[index * 3 + axis] = chunk.readFloatLE(base + 12 + axis * 4);
        }
        for (let part = 0; part < 4; part++) cloud.colors[index * 4 + part] = chunk[base + 24 + part]! / 255;
        const byte = (part: number) => (chunk[base + 28 + part]! - 128) / 128;
        setRotation(cloud, index, byte(0), byte(1), byte(2), byte(3));
      }
    }
    return compensate(cloud, total);
  } finally {
    await handle.close();
  }
}

type Bounds = { mins: number[]; maxs: number[] };
type SogMeta = {
  version: number;
  count: number;
  means: Bounds & { files: string[] };
  scales: (Bounds | { codebook: number[] }) & { files: string[] };
  quats: { files: string[] };
  sh0: (Bounds | { codebook: number[] }) & { files: string[] };
};

async function entryBytes(zip: yauzl.ZipFile, entry: yauzl.Entry, limit: number): Promise<Buffer | null> {
  if (entry.uncompressedSize > limit) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of await zip.openReadStreamPromise(entry)) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * A bundled SOG: a zip of `meta.json` and lossless WebP pictures, pixel `i` of each holding part of splat `i`, read
 * the way PlayCanvas reads them. The pictures are unpacked one after another, so only one is held whole at a time.
 */
async function decodeSog(file: string, budget: number): Promise<SplatCloud | null> {
  const { default: sharp } = await import("sharp");
  const zip = await yauzl.openPromise(file, { autoClose: false, lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: false });
  try {
    const entries = new Map<string, yauzl.Entry>();
    for await (const entry of zip.eachEntry()) entries.set(entry.fileName, entry);
    const metaEntry = entries.get("meta.json");
    const metaBytes = metaEntry && (await entryBytes(zip, metaEntry, MAX_META_BYTES));
    if (!metaBytes) return null;
    const meta = JSON.parse(metaBytes.toString("utf8")) as SogMeta;
    if ((meta.version !== 1 && meta.version !== 2) || !Number.isSafeInteger(meta.count) || meta.count <= 0) return null;
    const runs = blocks(meta.count, budget);
    const cloud = emptyCloud(runs.reduce((sum, run) => sum + run.length, 0));

    const picture = async (name: string | undefined) => {
      const entry = name === undefined ? undefined : entries.get(name);
      const bytes = entry && (await entryBytes(zip, entry, MAX_IMAGE_BYTES));
      if (!bytes) throw new Error(`no ${name} in the SOG`);
      const { data, info } = await sharp(bytes, { limitInputPixels: false }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      if (info.channels !== 4 || info.width * info.height < meta.count) throw new Error(`${name} is too small`);
      return data;
    };
    const each = (read: (splat: number, index: number) => void) => {
      let index = 0;
      for (const run of runs) for (let splat = run.start; splat < run.start + run.length; splat++, index++) read(splat, index);
    };
    const lerp = (bounds: Bounds, part: number, t: number) => bounds.mins[part]! * (1 - t) + bounds.maxs[part]! * t;
    const decoded = (table: Bounds | { codebook: number[] }, part: number, byte: number) => ("codebook" in table ? table.codebook[byte]! : lerp(table, part, byte / 255));

    const lower = await picture(meta.means.files[0]);
    const upper = await picture(meta.means.files[1]);
    each((splat, index) => {
      for (let axis = 0; axis < 3; axis++) {
        const value = lerp(meta.means, axis, ((upper[splat * 4 + axis]! << 8) + lower[splat * 4 + axis]!) / 65535);
        cloud.positions[index * 3 + axis] = Math.sign(value) * (Math.exp(Math.abs(value)) - 1);
      }
    });

    const quats = await picture(meta.quats.files[0]);
    each((splat, index) => {
      const a = (quats[splat * 4]! / 255 - 0.5) * Math.SQRT2;
      const b = (quats[splat * 4 + 1]! / 255 - 0.5) * Math.SQRT2;
      const c = (quats[splat * 4 + 2]! / 255 - 0.5) * Math.SQRT2;
      const d = Math.sqrt(Math.max(0, 1 - (a * a + b * b + c * c)));
      // Which part was left out for being the largest, and is made up from the other three; written w, x, y, z.
      const mode = quats[splat * 4 + 3]! - 252;
      if (mode === 0) setRotation(cloud, index, d, a, b, c);
      else if (mode === 1) setRotation(cloud, index, a, d, b, c);
      else if (mode === 2) setRotation(cloud, index, a, b, d, c);
      else setRotation(cloud, index, a, b, c, d);
    });

    const scales = await picture(meta.scales.files[0]);
    each((splat, index) => {
      for (let axis = 0; axis < 3; axis++) cloud.scales[index * 3 + axis] = Math.exp(decoded(meta.scales, axis, scales[splat * 4 + axis]!));
    });

    const colors = await picture(meta.sh0.files[0]);
    each((splat, index) => {
      for (let part = 0; part < 3; part++) cloud.colors[index * 4 + part] = 0.5 + SH_C0 * decoded(meta.sh0, part, colors[splat * 4 + part]!);
      const alpha = colors[splat * 4 + 3]!;
      cloud.colors[index * 4 + 3] = "codebook" in meta.sh0 ? alpha / 255 : sigmoid(lerp(meta.sh0, 3, alpha / 255));
    });
    return compensate(cloud, meta.count);
  } finally {
    zip.close();
  }
}

const DECODERS: Record<SplatFormat, SplatDecoder> = { ply: decodePly, splat: decodeSplat, sog: decodeSog };

/** Told by how the file begins: a remote file is read from a copy whose name says nothing. The older layout has no mark of its own. */
async function formatOf(file: string): Promise<SplatFormat> {
  const handle = await fsp.open(file, "r");
  try {
    const { buffer } = await handle.read(Buffer.alloc(4), 0, 4, 0);
    return buffer.toString("latin1") === "ply\n" ? "ply" : buffer.equals(Buffer.from("PK\x03\x04", "latin1")) ? "sog" : "splat";
  } finally {
    await handle.close();
  }
}

/** The splats of a PLY, SOG or `.splat` file, at most about `budget` of them. Null for a file that holds none this can read. */
export async function readSplats(file: string, budget: number): Promise<SplatCloud | null> {
  return DECODERS[await formatOf(file)](file, budget);
}
