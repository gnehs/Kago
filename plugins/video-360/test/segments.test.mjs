import assert from "node:assert/strict";
import test from "node:test";
import { fragmentTime } from "../src/mp4.ts";
import { AHEAD, BEHIND, keepFrom, nextSegment, placement, seekInto, segmentAt } from "../src/segments.ts";

const info = { duration: 413.7, segmentSeconds: 6, segmentCount: 69 };

test("a moment belongs to the segment that covers it, the last one running to the end", () => {
  assert.equal(segmentAt(0, info), 0);
  assert.equal(segmentAt(17.99, info), 2);
  assert.equal(segmentAt(18, info), 3);
  assert.equal(segmentAt(413.6, info), 68);
  assert.equal(segmentAt(-3, info), 0);
});

test("segments are fetched in order until the run reaches far enough past the playhead", () => {
  assert.equal(nextSegment({ start: 0, next: 0 }, 0, info), 0);
  const playhead = 30;
  const reach = Math.ceil((playhead + AHEAD) / info.segmentSeconds);
  assert.equal(nextSegment({ start: 4, next: reach - 1 }, playhead, info), reach - 1);
  assert.equal(nextSegment({ start: 4, next: reach }, playhead, info), null);
});

test("nothing is fetched past the last segment", () => {
  assert.equal(nextSegment({ start: 60, next: 69 }, 410, info), null);
  assert.equal(nextSegment({ start: 60, next: 68 }, 410, info), 68);
});

test("what is long past the playhead is let go, never what it is on or what is ahead", () => {
  assert.equal(keepFrom({ start: 0, next: 4 }, 6, info), 0);
  assert.equal(keepFrom({ start: 0, next: 12 }, 60, info), segmentAt(60 - BEHIND, info));
  assert.ok(keepFrom({ start: 0, next: 12 }, 60, info) <= segmentAt(60, info));
  assert.equal(keepFrom({ start: 8, next: 12 }, 60, info), 8);
});

test("a seek inside the run, or to the segment it fetches next, plays on; any other starts a new run there", () => {
  const run = { start: 5, next: 9 };
  assert.equal(seekInto(run, 40, info), "run");
  assert.equal(seekInto(run, 9 * 6 + 1, info), "run");
  assert.equal(seekInto(run, 10 * 6, info), 10);
  assert.equal(seekInto(run, 12, info), 2);
  assert.equal(seekInto({ start: 20, next: 20 }, 121, info), "run");
  assert.equal(seekInto({ start: 20, next: 20 }, 0, info), 0);
});

test("a new encoder run, counting from 0, is placed where its first segment's number says", () => {
  assert.equal(placement(41, 0, null, info), 246);
  assert.equal(placement(0, 0, null, info), 0);
});

test("the segments of one run keep the run's offset, so they join without a gap", () => {
  assert.equal(placement(42, 6.034, 246, info), 246);
  assert.equal(placement(45, 24.001, 246, info), 246);
});

test("a run the server started anew partway, counting from 0 again, is placed by its own first segment", () => {
  assert.equal(placement(50, 0, 246, info), 300);
});

const box = (type, ...parts) => {
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + body.length);
  head.write(type, 4, "latin1");
  return Buffer.concat([head, body]);
};
const full = (version, ...parts) => Buffer.concat([Buffer.from([version, 0, 0, 0]), ...parts]);
const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const u64 = (value) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
};
const traf = (track, version, time) => box("traf", box("tfhd", full(0, u32(track))), box("tfdt", full(version, version === 1 ? u64(time) : u32(time))));

test("a segment says when its first sample of a track is decoded, in that track's seconds", () => {
  const segment = new Uint8Array(Buffer.concat([box("styp", Buffer.from("msdh")), box("moof", box("mfhd", full(0, u32(7))), traf(2, 0, 96000), traf(1, 1, 181_000)), box("mdat", Buffer.alloc(16))]));
  assert.equal(fragmentTime(segment, { id: 1, timescale: 30000 }), 181_000 / 30000);
  assert.equal(fragmentTime(segment, { id: 2, timescale: 48000 }), 2);
  assert.equal(fragmentTime(segment, { id: 3, timescale: 1000 }), null);
});
