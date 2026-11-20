import assert from "node:assert/strict";
import test from "node:test";
import { parseMovie, readMoov } from "../src/mp4.ts";

const ascii = (text) => [...text].map((char) => char.charCodeAt(0));
const u16 = (value) => [value >> 8, value & 0xff];
const u32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const u64 = (value) => [...u32(Math.floor(value / 2 ** 32)), ...u32(value % 2 ** 32)];
const box = (type, ...body) => {
  const bytes = body.flat(Infinity);
  return [...u32(bytes.length + 8), ...ascii(type), ...bytes];
};
const full = (type, version, ...body) => box(type, version, 0, 0, 0, ...body);
const zeros = (count) => Array(count).fill(0);

// A 2.4 GiB file can't be built here; its offsets are 64-bit all the same.
const FAR = 5 * 2 ** 32;

function trak({ id, handler, scale, entry, samples, edit }) {
  return box(
    "trak",
    full("tkhd", 0, zeros(8), u32(id), zeros(68)),
    edit ? box("edts", full("elst", 0, u32(edit.length), edit.map(([duration, time]) => [u32(duration), u32(time >>> 0), u16(1), u16(0)]))) : [],
    box(
      "mdia",
      full("mdhd", 0, zeros(8), u32(scale), u32(0), zeros(4)),
      full("hdlr", 0, zeros(4), ascii(handler), zeros(12), 0),
      box(
        "minf",
        box(
          "stbl",
          full("stsd", 0, u32(1), entry),
          full("stts", 0, u32(1), u32(samples.length), u32(samples.delta)),
          samples.sync ? full("stss", 0, u32(samples.sync.length), samples.sync.map(u32)) : [],
          full("stsz", 0, u32(0), u32(samples.length), samples.sizes.map(u32)),
          full("stsc", 0, u32(1), u32(1), u32(2), u32(1)),
          full("co64", 0, u32(samples.chunks.length), samples.chunks.map(u64))
        )
      )
    )
  );
}

const hvcC = [1, 0x22, 0x20, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 156, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0];
const hvc1 = box("hvc1", zeros(6), u16(1), zeros(16), u16(3840), u16(3840), zeros(50), box("hvcC", hvcC));
const asc = [0x11, 0x90];
const esds = full("esds", 0, 3, 25, u16(1), 0, 4, 17, 0x40, 0x15, zeros(11), 5, 2, asc, 6, 1, 2);
const mp4a = box("mp4a", zeros(6), u16(1), zeros(8), u16(2), u16(16), zeros(4), u32(48000 * 65536), esds);

function file() {
  const video = trak({ id: 1, handler: "vide", scale: 30000, entry: hvc1, edit: [[1000, -1], [1000, 1001]], samples: Object.assign([0, 1, 2, 3], { delta: 1001, sizes: [500, 100, 200, 300], sync: [1, 3], chunks: [FAR, FAR + 2000] }) });
  const sound = trak({ id: 2, handler: "soun", scale: 48000, entry: mp4a, samples: Object.assign([0, 1], { delta: 1024, sizes: [10, 20], chunks: [700] }) });
  const moov = box("moov", full("mvhd", 0, zeros(8), u32(1000), u32(0), zeros(80)), video, sound);
  const ftyp = box("ftyp", ascii("isom"), u32(0));
  const mdat = box("mdat", zeros(4000));
  // Insta360 writes a trailer of its own after the last box, which is no box at all.
  return new Uint8Array([...ftyp, ...mdat, ...moov, ...zeros(3), 0xff, 0xff, 0xff]);
}

test("the moov at the end of a file is found by its box headers alone, and its tracks read", async () => {
  const bytes = file();
  const reads = [];
  const read = async (start, end) => {
    reads.push([start, end]);
    return bytes.slice(start, end);
  };
  const moov = await readMoov(read, bytes.byteLength);
  assert.ok(reads.every(([start, end]) => end - start <= 16 || bytes[start + 4] === 0x6d), "only headers and the moov are read");
  const movie = parseMovie(moov);
  const [video, sound] = movie.tracks;

  assert.equal(video.kind, "video");
  assert.equal(video.codec, "hvc1.2.4.H156.B0");
  assert.deepEqual([video.width, video.height], [3840, 3840]);
  assert.deepEqual(video.description, new Uint8Array(hvcC));
  assert.deepEqual([...video.samples.offsets], [FAR, FAR + 500, FAR + 2000, FAR + 2200]);
  assert.deepEqual([...video.samples.sync], [1, 0, 1, 0]);
  // One second of empty edit, then the media from 1001 ticks on.
  assert.deepEqual([...video.samples.times].map((time) => Math.round(time * 30000)), [30000 - 1001, 30000, 30000 + 1001, 30000 + 2002]);

  assert.equal(sound.kind, "audio");
  assert.equal(sound.codec, "mp4a.40.2");
  assert.deepEqual(sound.description, new Uint8Array(asc));
  assert.deepEqual([sound.sampleRate, sound.channels], [48000, 2]);
  assert.deepEqual([...sound.samples.offsets], [700, 710]);
  assert.deepEqual([...sound.samples.sync], [1, 1]);
});

test("a file with no moov has none to give", async () => {
  const bytes = new Uint8Array([...box("ftyp", ascii("isom")), ...box("mdat", zeros(10))]);
  assert.equal(await readMoov(async (start, end) => bytes.slice(start, end), bytes.byteLength), null);
});
