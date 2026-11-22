import assert from "node:assert/strict";
import test from "node:test";
import { parseMovie, readMoov } from "../src/mp4.ts";
import { ascii, asc, box, FAR, file, hvcC, zeros } from "./recording.mjs";

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
