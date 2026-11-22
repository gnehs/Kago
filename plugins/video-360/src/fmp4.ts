/**
 * Writes a track of a recording out again as fragmented MP4, the form Media Source takes: an init segment that
 * describes the track, then media segments of its samples, as they are. Nothing is decoded or encoded again.
 */
import type { Track } from "./mp4";

type Part = Uint8Array | number[];

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u16 = (value: number) => [(value >>> 8) & 0xff, value & 0xff];
const u32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u64 = (value: number) => [...u32(Math.floor(value / 2 ** 32)), ...u32(value % 2 ** 32)];
const zeros = (count: number) => new Array<number>(count).fill(0);
const MATRIX = [...u32(0x10000), ...zeros(12), ...u32(0x10000), ...zeros(12), ...u32(0x40000000)];

function concat(parts: Part[]) {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return bytes;
}

const box = (type: string, ...body: Part[]) => concat([u32(8 + body.reduce((total, part) => total + part.length, 0)), ascii(type), ...body]);
const full = (type: string, version: number, flags: number, ...body: Part[]) => box(type, [version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff], ...body);

/** The track's id in what is written: each SourceBuffer is given a track of its own. */
const TRACK_ID = 1;

/**
 * The MPEG-4 audio sample entry for AAC, made afresh out of its AudioSpecificConfig: a QuickTime recording's own
 * sound entry carries fields an ISO one has not.
 */
function aacEntry(track: Track) {
  const config = track.description ?? new Uint8Array();
  const descriptor = (tag: number, ...body: Part[]) => {
    const bytes = concat(body);
    return concat([[tag, bytes.length], bytes]);
  };
  const decoderConfig = descriptor(4, [0x40, 0x15], zeros(3), u32(0), u32(0), descriptor(5, config));
  const esds = full("esds", 0, 0, descriptor(3, u16(0), [0], decoderConfig, descriptor(6, [2])));
  return box("mp4a", zeros(6), u16(1), zeros(8), u16(track.channels), u16(16), zeros(4), u32(Math.round(track.sampleRate) * 65536), esds);
}

/** The init segment of one track: what a SourceBuffer is told before the track's media segments. */
export function initSegment(track: Track) {
  const video = track.kind === "video";
  const entry = video ? track.entry : aacEntry(track);
  const empty = (type: string) => full(type, 0, 0, u32(0));
  const stbl = box("stbl", full("stsd", 0, 0, u32(1), entry), empty("stts"), empty("stsc"), full("stsz", 0, 0, u32(0), u32(0)), empty("stco"));
  const header = video ? full("vmhd", 0, 1, zeros(8)) : full("smhd", 0, 0, zeros(4));
  const dinf = box("dinf", full("dref", 0, 0, u32(1), full("url ", 0, 1)));
  const minf = box("minf", header, dinf, stbl);
  const mdhd = full("mdhd", 0, 0, zeros(8), u32(track.timescale), u32(0), u16(0x55c4), zeros(2));
  const hdlr = full("hdlr", 0, 0, zeros(4), ascii(video ? "vide" : "soun"), zeros(12), [0]);
  const tkhd = full("tkhd", 0, 3, zeros(8), u32(TRACK_ID), zeros(4), u32(0), zeros(8), zeros(4), u16(video ? 0 : 0x100), zeros(2), MATRIX, u32(track.width * 65536), u32(track.height * 65536));
  const trak = box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
  const mvhd = full("mvhd", 0, 0, zeros(8), u32(1000), u32(0), u32(0x10000), u16(0x100), zeros(10), MATRIX, zeros(24), u32(TRACK_ID + 1));
  const mvex = box("mvex", full("trex", 0, 0, u32(TRACK_ID), u32(1), u32(0), u32(0), u32(0)));
  return concat([box("ftyp", ascii("isom"), u32(0x200), ascii("isomiso6mp41")), box("moov", mvhd, trak, mvex)]);
}

/**
 * Every sample's decode and presentation time, in units of the track's timescale. Presentation is on the movie's
 * timeline, the edit list and composition offsets applied, so tracks written out from one recording line up.
 */
export type Timing = { decode: Float64Array; present: Float64Array };

export function timing(track: Track): Timing {
  const { count, times, durations } = track.samples;
  const decode = new Float64Array(count);
  const present = new Float64Array(count);
  let at = 0;
  for (let index = 0; index < count; index++) {
    decode[index] = at;
    at += Math.round(durations[index]! * track.timescale);
    present[index] = Math.round(times[index]! * track.timescale);
  }
  return { decode, present };
}

/** Sample flags: a sync sample depends on no other; any other sample depends on some, and is no sync sample. */
const SYNC = 0x02000000;
const NOT_SYNC = 0x01010000;

/**
 * A media segment of samples `first` up to, not including, `end`, whose bytes `data` holds in order. A segment is
 * placed by its own times, so it may follow any other or start a new run after a seek.
 */
export function mediaSegment(track: Track, times: Timing, first: number, end: number, data: Uint8Array[], sequence: number) {
  const { sizes, sync } = track.samples;
  const count = end - first;
  const rows: number[] = [];
  for (let index = first; index < end; index++) {
    const duration = index + 1 < track.samples.count ? times.decode[index + 1]! - times.decode[index]! : Math.round(track.samples.durations[index]! * track.timescale);
    rows.push(...u32(duration), ...u32(sizes[index]!), ...u32(sync[index] ? SYNC : NOT_SYNC), ...u32((times.present[index]! - times.decode[index]!) | 0));
  }
  // Version 1 takes composition offsets as signed, which an edit list that starts the track late makes negative.
  const trun = (dataOffset: number) => full("trun", 1, 0x000f01, u32(count), u32(dataOffset), rows);
  const tfhd = full("tfhd", 0, 0x020000, u32(TRACK_ID));
  const tfdt = full("tfdt", 1, 0, u64(times.decode[first] ?? 0));
  const moofSize = (body: Uint8Array) => 8 + 16 + 8 + tfhd.length + tfdt.length + body.length;
  const sized = trun(0);
  const moof = box("moof", full("mfhd", 0, 0, u32(sequence)), box("traf", tfhd, tfdt, trun(moofSize(sized) + 8)));
  const mdatSize = 8 + data.reduce((total, part) => total + part.length, 0);
  return concat([moof, u32(mdatSize), ascii("mdat"), ...data]);
}
