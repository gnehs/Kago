import assert from "node:assert/strict";
import test from "node:test";
import { initSegment, mediaSegment, timing } from "../src/fmp4.ts";
import { fragmentTime, parseMovie, readMoov } from "../src/mp4.ts";
import { file, hvcC } from "./recording.mjs";

const recording = async () => {
  const bytes = file();
  return parseMovie(await readMoov(async (start, end) => bytes.slice(start, end), bytes.byteLength)).tracks;
};

const readBack = async (init) => {
  const moov = await readMoov(async (start, end) => init.slice(start, end), init.byteLength);
  assert.ok(moov, "the init segment has a moov");
  return parseMovie(moov).tracks;
};

/** The samples a media segment's one track fragment lists, and the bytes its data offset points at. */
function fragmentSamples(segment, timescale) {
  const view = new DataView(segment.buffer, segment.byteOffset, segment.byteLength);
  const find = (type, from, to) => {
    for (let at = from; at + 8 <= to; at += view.getUint32(at)) if (String.fromCharCode(...segment.subarray(at + 4, at + 8)) === type) return at;
    return -1;
  };
  const moof = find("moof", 0, segment.byteLength);
  const traf = find("traf", moof + 8, moof + view.getUint32(moof));
  const tfdt = find("tfdt", traf + 8, traf + view.getUint32(traf));
  const trun = find("trun", traf + 8, traf + view.getUint32(traf));
  const mdat = find("mdat", 0, segment.byteLength);
  let decode = Number(view.getBigUint64(tfdt + 12));
  const count = view.getUint32(trun + 12);
  const dataOffset = view.getInt32(trun + 16);
  const samples = [];
  for (let index = 0, at = trun + 20; index < count; index++, at += 16) {
    const duration = view.getUint32(at);
    samples.push({ decode: decode / timescale, present: (decode + view.getInt32(at + 12)) / timescale, duration: duration / timescale, size: view.getUint32(at + 4), sync: (view.getUint32(at + 8) & 0x10000) === 0 });
    decode += duration;
  }
  return { samples, payload: segment.subarray(moof + dataOffset), mdatPayload: segment.subarray(mdat + 8) };
}

test("a lens track's init segment reads back as the same track, sample entry and all", async () => {
  const [video] = await recording();
  const [written] = await readBack(initSegment(video));
  assert.equal(written.kind, "video");
  assert.equal(written.codec, video.codec);
  assert.deepEqual([written.width, written.height, written.timescale], [3840, 3840, 30000]);
  assert.deepEqual(written.description, new Uint8Array(hvcC));
  assert.deepEqual(written.entry, video.entry);
  assert.equal(written.samples.count, 0, "the samples come in media segments");
});

test("the sound's init segment reads back as AAC of the same rate, channels and config", async () => {
  const [, sound] = await recording();
  const [written] = await readBack(initSegment(sound));
  assert.equal(written.kind, "audio");
  assert.equal(written.codec, "mp4a.40.2");
  assert.deepEqual([written.sampleRate, written.channels, written.timescale], [48000, 2, 48000]);
  assert.deepEqual(written.description, sound.description);
});

test("a media segment lists its samples with their sizes, sync flags and times on the movie's timeline", async () => {
  const [video] = await recording();
  const data = [0, 1, 2, 3].map((index) => new Uint8Array(video.samples.sizes[index]).fill(index + 1));
  const segment = mediaSegment(video, timing(video), 0, 4, data, 1);
  const { samples, payload, mdatPayload } = fragmentSamples(segment, video.timescale);

  assert.deepEqual(samples.map((sample) => sample.size), [500, 100, 200, 300]);
  assert.deepEqual(samples.map((sample) => sample.sync), [true, false, true, false]);
  assert.deepEqual(samples.map((sample) => Math.round(sample.duration * 30000)), [1001, 1001, 1001, 1001]);
  // The edit list's second of delay, less the 1001 ticks it skips, shows in the presentation times.
  assert.deepEqual(samples.map((sample) => Math.round(sample.present * 30000)), [...video.samples.times].map((time) => Math.round(time * 30000)));
  assert.deepEqual(payload, mdatPayload, "the data offset points at the samples");
  assert.deepEqual(payload, new Uint8Array(data.flatMap((bytes) => [...bytes])));
});

test("a segment cut from the middle starts at its first sample's decode time", async () => {
  const [video] = await recording();
  const data = [2, 3].map((index) => new Uint8Array(video.samples.sizes[index]));
  const segment = mediaSegment(video, timing(video), 2, 4, data, 7);
  assert.equal(Math.round(fragmentTime(segment, { id: 1, timescale: 30000 }) * 30000), 2002);
  const { samples } = fragmentSamples(segment, video.timescale);
  assert.equal(samples.length, 2);
  assert.equal(samples[0].sync, true);
  assert.equal(Math.round(samples[0].present * 30000), 30000 + 1001);
});
