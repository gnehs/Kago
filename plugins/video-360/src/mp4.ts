/**
 * Just enough of the MP4 (ISO BMFF and QuickTime) container to play a camera's recording: the tracks in its `moov`
 * and where each sample lies. A recording runs to many gigabytes and keeps its `moov` at either end, so only the box
 * headers on the way to it and the `moov` itself are read.
 */

export type ReadRange = (start: number, end: number) => Promise<Uint8Array>;

export type TrackKind = "video" | "audio" | "other";

/** Every sample of a track, in decode order. Times are in seconds on the movie's timeline. */
export type Samples = {
  count: number;
  /** Offsets can pass 4 GiB, which a Uint32Array cannot hold. */
  offsets: Float64Array;
  sizes: Uint32Array;
  /** When each sample is shown. */
  times: Float64Array;
  durations: Float32Array;
  /** Whether each sample can be decoded on its own. */
  sync: Uint8Array;
};

export type Track = {
  id: number;
  kind: TrackKind;
  /** The sample entry's four-character code: `hvc1`, `avc1`, `mp4a`, `jpeg`… */
  format: string;
  /** The codec string WebCodecs takes, when this is a codec it names. */
  codec: string | null;
  /** The decoder configuration record: `hvcC`, `avcC`, or the AudioSpecificConfig out of `esds`. */
  description: Uint8Array | null;
  width: number;
  height: number;
  sampleRate: number;
  channels: number;
  /** Units of the track's own timeline in a second. */
  timescale: number;
  duration: number;
  samples: Samples;
};

export type Movie = { duration: number; tracks: Track[]; cover: Uint8Array<ArrayBuffer> | null };

type Box = { type: string; start: number; end: number };

const text = new TextDecoder("latin1");
const fourcc = (bytes: Uint8Array, at: number) => text.decode(bytes.subarray(at, at + 4));

/** The `moov` box's bytes, found by walking the file's top-level boxes. */
export async function readMoov(read: ReadRange, size: number): Promise<Uint8Array | null> {
  let offset = 0;
  while (offset + 8 <= size) {
    const head = await read(offset, Math.min(size, offset + 16));
    if (head.byteLength < 8) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let length = view.getUint32(0);
    let header = 8;
    if (length === 1) {
      if (head.byteLength < 16) return null;
      length = Number(view.getBigUint64(8));
      header = 16;
    } else if (length === 0) {
      length = size - offset;
    }
    // Past here is no box: Insta360 appends its own trailer after the last one.
    if (length < header || offset + length > size) return null;
    if (fourcc(head, 4) === "moov") return readAll(read, offset, offset + length);
    offset += length;
  }
  return null;
}

async function readAll(read: ReadRange, start: number, end: number) {
  const bytes = new Uint8Array(end - start);
  let at = start;
  while (at < end) {
    const chunk = await read(at, end);
    if (chunk.byteLength === 0) throw new Error("the file ended early");
    bytes.set(chunk, at - start);
    at += chunk.byteLength;
  }
  return bytes;
}

function children(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const boxes: Box[] = [];
  let at = start;
  while (at + 8 <= end) {
    let length = view.getUint32(at);
    let header = 8;
    if (length === 1 && at + 16 <= end) {
      length = Number(view.getBigUint64(at + 8));
      header = 16;
    } else if (length === 0) {
      length = end - at;
    }
    if (length < header || at + length > end) break;
    boxes.push({ type: fourcc(bytes, at + 4), start: at + header, end: at + length });
    at += length;
  }
  return boxes;
}

const child = (bytes: Uint8Array, box: Box | undefined, type: string) => (box ? children(bytes, box.start, box.end).find((found) => found.type === type) : undefined);

function path(bytes: Uint8Array, box: Box | undefined, ...types: string[]) {
  let found = box;
  for (const type of types) found = child(bytes, found, type);
  return found;
}

export function parseMovie(moov: Uint8Array): Movie {
  const view = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const root: Box = { type: "moov", start: 8, end: moov.byteLength };
  const mvhd = child(moov, root, "mvhd");
  if (!mvhd) throw new Error("no mvhd");
  const movieScale = view.getUint32(mvhd.start + (moov[mvhd.start] === 1 ? 20 : 12));
  const tracks = children(moov, root.start, root.end)
    .filter((box) => box.type === "trak")
    .map((trak) => parseTrack(moov, view, trak, movieScale))
    .filter((track): track is Track => track !== null);
  return { duration: Math.max(0, ...tracks.map((track) => track.duration)), tracks, cover: cover(moov, child(moov, root, "udta")) };
}

/** The picture in `udta/meta/ilst/covr`, which DJI's cameras fill with the whole sphere, already stitched, as a JPEG. */
function cover(bytes: Uint8Array, udta: Box | undefined): Uint8Array<ArrayBuffer> | null {
  const meta = child(bytes, udta, "meta");
  if (!meta) return null;
  // `meta` is a full box in ISO files and a plain one in QuickTime's.
  for (const start of [meta.start + 4, meta.start]) {
    const data = path(bytes, { type: "meta", start, end: meta.end }, "ilst", "covr", "data");
    // After the data box's type and locale.
    if (data && data.end - data.start > 8) return bytes.slice(data.start + 8, data.end);
  }
  return null;
}

function parseTrack(bytes: Uint8Array, view: DataView, trak: Box, movieScale: number): Track | null {
  const tkhd = child(bytes, trak, "tkhd");
  const mdia = child(bytes, trak, "mdia");
  const mdhd = child(bytes, mdia, "mdhd");
  const hdlr = child(bytes, mdia, "hdlr");
  const stbl = path(bytes, mdia, "minf", "stbl");
  const stsd = child(bytes, stbl, "stsd");
  if (!tkhd || !mdhd || !hdlr || !stbl || !stsd) return null;
  const id = view.getUint32(tkhd.start + (bytes[tkhd.start] === 1 ? 20 : 12));
  const timescale = view.getUint32(mdhd.start + (bytes[mdhd.start] === 1 ? 20 : 12));
  const handler = fourcc(bytes, hdlr.start + 8);
  const kind: TrackKind = handler === "vide" ? "video" : handler === "soun" ? "audio" : "other";
  // The first sample entry, after the full box header and the entry count.
  const entry = children(bytes, stsd.start + 8, stsd.end)[0];
  if (!entry || timescale === 0) return null;
  const format = entry.type;
  let width = 0;
  let height = 0;
  let sampleRate = 0;
  let channels = 0;
  let description: Uint8Array | null = null;
  let codec: string | null = null;
  if (kind === "video") {
    width = view.getUint16(entry.start + 24);
    height = view.getUint16(entry.start + 26);
    const config = children(bytes, entry.start + 78, entry.end).find((box) => box.type === "hvcC" || box.type === "avcC");
    if (config) {
      description = bytes.slice(config.start, config.end);
      codec = config.type === "hvcC" ? hevcCodec(format, description) : avcCodec(format, description);
    }
  } else if (kind === "audio") {
    const version = view.getUint16(entry.start + 8);
    channels = view.getUint16(entry.start + 16);
    sampleRate = view.getUint32(entry.start + 24) / 65536;
    // QuickTime's sound entries grow by version.
    const boxes = entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
    const esds = findBox(bytes, boxes, entry.end, "esds");
    if (format === "mp4a" && esds) {
      description = audioSpecificConfig(bytes.subarray(esds.start + 4, esds.end));
      if (description && description.byteLength >= 2) {
        let objectType = description[0]! >> 3;
        if (objectType === 31) objectType = 32 + (((description[0]! & 7) << 3) | (description[1]! >> 5));
        codec = `mp4a.40.${objectType}`;
      }
    }
  }
  const samples = sampleTable(bytes, view, stbl, timescale, editShift(bytes, view, trak, timescale, movieScale));
  const duration = samples.count ? samples.times.reduce((latest, time, index) => Math.max(latest, time + samples.durations[index]!), 0) : 0;
  return { id, kind, format, codec, description, width, height, sampleRate, channels, timescale, duration, samples };
}

/** When a fragmented MP4 segment's first sample of a track is decoded, in seconds of the track's own timeline. */
export function fragmentTime(segment: Uint8Array, track: Pick<Track, "id" | "timescale">): number | null {
  const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
  for (const moof of children(segment, 0, segment.byteLength).filter((box) => box.type === "moof")) {
    for (const traf of children(segment, moof.start, moof.end).filter((box) => box.type === "traf")) {
      const tfhd = child(segment, traf, "tfhd");
      const tfdt = child(segment, traf, "tfdt");
      if (!tfhd || !tfdt || view.getUint32(tfhd.start + 4) !== track.id) continue;
      const time = segment[tfdt.start] === 1 ? Number(view.getBigUint64(tfdt.start + 4)) : view.getUint32(tfdt.start + 4);
      return time / track.timescale;
    }
  }
  return null;
}

/** Searches the boxes in a range, and the boxes inside those, for the first of a type. */
function findBox(bytes: Uint8Array, start: number, end: number, type: string): Box | undefined {
  for (const box of children(bytes, start, end)) {
    if (box.type === type) return box;
    if (box.type === "wave") {
      const inner = findBox(bytes, box.start, box.end, type);
      if (inner) return inner;
    }
  }
  return undefined;
}

/**
 * Seconds to add to a sample's media time to place it on the movie's timeline, from the track's edit list: an
 * empty edit first delays the track, and the first real edit says which media time it starts from.
 */
function editShift(bytes: Uint8Array, view: DataView, trak: Box, timescale: number, movieScale: number) {
  const elst = path(bytes, trak, "edts", "elst");
  if (!elst || movieScale === 0) return 0;
  const version = bytes[elst.start];
  const count = view.getUint32(elst.start + 4);
  const size = version === 1 ? 20 : 12;
  let delay = 0;
  for (let index = 0, at = elst.start + 8; index < count && at + size <= elst.end; index++, at += size) {
    const duration = version === 1 ? Number(view.getBigUint64(at)) : view.getUint32(at);
    const mediaTime = version === 1 ? Number(view.getBigInt64(at + 8)) : view.getInt32(at + 4);
    if (mediaTime === -1) delay += duration / movieScale;
    else return delay - mediaTime / timescale;
  }
  return delay;
}

function sampleTable(bytes: Uint8Array, view: DataView, stbl: Box, timescale: number, shift: number): Samples {
  const box = (type: string) => child(bytes, stbl, type);
  const stsz = box("stsz");
  const count = stsz ? view.getUint32(stsz.start + 8) : 0;
  const sizes = new Uint32Array(count);
  if (stsz) {
    const fixed = view.getUint32(stsz.start + 4);
    for (let index = 0; index < count; index++) sizes[index] = fixed || view.getUint32(stsz.start + 12 + index * 4);
  }

  const offsets = new Float64Array(count);
  const stco = box("stco");
  const co64 = box("co64");
  const chunks = stco ?? co64;
  const stsc = box("stsc");
  if (chunks && stsc) {
    const chunkCount = view.getUint32(chunks.start + 4);
    const chunkOffset = (index: number) => (co64 ? Number(view.getBigUint64(chunks.start + 8 + index * 8)) : view.getUint32(chunks.start + 8 + index * 4));
    const runs = view.getUint32(stsc.start + 4);
    let sample = 0;
    for (let run = 0; run < runs; run++) {
      const at = stsc.start + 8 + run * 12;
      const first = view.getUint32(at) - 1;
      const perChunk = view.getUint32(at + 4);
      const last = run + 1 < runs ? view.getUint32(at + 12) - 1 : chunkCount;
      for (let chunk = first; chunk < last && chunk < chunkCount; chunk++) {
        let offset = chunkOffset(chunk);
        for (let index = 0; index < perChunk && sample < count; index++, sample++) {
          offsets[sample] = offset;
          offset += sizes[sample]!;
        }
      }
    }
  }

  const times = new Float64Array(count);
  const durations = new Float32Array(count);
  const stts = box("stts");
  if (stts) {
    const runs = view.getUint32(stts.start + 4);
    let sample = 0;
    let time = 0;
    for (let run = 0; run < runs; run++) {
      const runCount = view.getUint32(stts.start + 8 + run * 8);
      const delta = view.getUint32(stts.start + 12 + run * 8);
      for (let index = 0; index < runCount && sample < count; index++, sample++) {
        times[sample] = time;
        durations[sample] = delta / timescale;
        time += delta;
      }
    }
  }
  const ctts = box("ctts");
  if (ctts) {
    const runs = view.getUint32(ctts.start + 4);
    let sample = 0;
    for (let run = 0; run < runs; run++) {
      const runCount = view.getUint32(ctts.start + 8 + run * 8);
      // Signed in version 1; version 0 writers put negative offsets there too.
      const offset = view.getInt32(ctts.start + 12 + run * 8);
      for (let index = 0; index < runCount && sample < count; index++, sample++) times[sample]! += offset;
    }
  }
  for (let index = 0; index < count; index++) times[index] = times[index]! / timescale + shift;

  const sync = new Uint8Array(count);
  const stss = box("stss");
  if (stss) {
    const entries = view.getUint32(stss.start + 4);
    for (let index = 0; index < entries; index++) {
      const sample = view.getUint32(stss.start + 8 + index * 4) - 1;
      if (sample < count) sync[sample] = 1;
    }
  } else {
    sync.fill(1);
  }
  return { count, offsets, sizes, times, durations, sync };
}

/** The descriptor `esds` wraps: ES_Descriptor, then DecoderConfigDescriptor, then DecoderSpecificInfo, which is the config. */
function audioSpecificConfig(esds: Uint8Array): Uint8Array | null {
  let at = 0;
  const descriptor = () => {
    const tag = esds[at++];
    let length = 0;
    for (let index = 0; index < 4; index++) {
      const byte = esds[at++] ?? 0;
      length = (length << 7) | (byte & 0x7f);
      if (!(byte & 0x80)) break;
    }
    return { tag, length };
  };
  while (at < esds.byteLength) {
    const { tag, length } = descriptor();
    if (tag === 3) {
      const flags = esds[at + 2] ?? 0;
      at += 3;
      if (flags & 0x80) at += 2;
      if (flags & 0x40) at += 1 + (esds[at] ?? 0);
      if (flags & 0x20) at += 2;
    } else if (tag === 4) {
      at += 13;
    } else if (tag === 5) {
      return esds.slice(at, at + length);
    } else {
      at += length;
    }
  }
  return null;
}

const hex = (value: number) => value.toString(16).toUpperCase().padStart(2, "0");

function avcCodec(format: string, avcC: Uint8Array) {
  return avcC.byteLength < 4 ? null : `${format === "avc3" ? "avc3" : "avc1"}.${hex(avcC[1]!)}${hex(avcC[2]!)}${hex(avcC[3]!)}`;
}

/** The codec string RFC 6381 gives HEVC, out of the first bytes of its decoder configuration record. */
function hevcCodec(format: string, hvcC: Uint8Array) {
  if (hvcC.byteLength < 13) return null;
  const space = hvcC[1]! >> 6;
  const tier = (hvcC[1]! >> 5) & 1;
  const profile = hvcC[1]! & 0x1f;
  let compatibility = new DataView(hvcC.buffer, hvcC.byteOffset).getUint32(2);
  let reversed = 0;
  for (let bit = 0; bit < 32; bit++, compatibility >>>= 1) reversed = (reversed << 1) | (compatibility & 1);
  const constraints = [...hvcC.subarray(6, 12)];
  while (constraints.length && constraints.at(-1) === 0) constraints.pop();
  const parts = [format === "hev1" ? "hev1" : "hvc1", `${["", "A", "B", "C"][space]}${profile}`, (reversed >>> 0).toString(16).toUpperCase(), `${tier ? "H" : "L"}${hvcC[12]}`, ...constraints.map((byte) => byte.toString(16).toUpperCase())];
  return parts.join(".");
}
