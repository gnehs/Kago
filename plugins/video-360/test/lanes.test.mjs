import assert from "node:assert/strict";
import test from "node:test";
import { correction, cutFragments, fragmentAt, JUMP_DRIFT, nextBatch } from "../src/lanes.ts";

/** `count` samples `step` seconds apart, a sync sample every `gop`. */
function samples(count, step, gop) {
  return { count, times: Float64Array.from({ length: count }, (_, index) => index * step), sync: Uint8Array.from({ length: count }, (_, index) => (index % gop === 0 ? 1 : 0)) };
}

test("fragments start at every sync sample and run half a second at most", () => {
  const fragments = cutFragments(samples(120, 1 / 30, 60));
  assert.deepEqual(fragments.map(({ first, end, sync }) => [first, end, sync]), [[0, 15, true], [15, 30, false], [30, 45, false], [45, 60, false], [60, 75, true], [75, 90, false], [90, 105, false], [105, 120, false]]);
  assert.ok(fragments.every((fragment, index) => index === 0 || fragment.first === fragments[index - 1].end), "every sample is in one fragment");
});

test("a short group of pictures is a fragment of its own", () => {
  const fragments = cutFragments(samples(45, 1 / 30, 15));
  assert.deepEqual(fragments.map(({ first, end }) => [first, end]), [[0, 15], [15, 30], [30, 45]]);
});

test("a seek plays from the fragment of the sync sample at or before the target", () => {
  const fragments = cutFragments(samples(240, 1 / 30, 60));
  assert.equal(fragmentAt(fragments, 0), 0);
  assert.equal(fragments[fragmentAt(fragments, 1.99)].first, 0);
  assert.equal(fragments[fragmentAt(fragments, 2)].first, 60);
  assert.equal(fragments[fragmentAt(fragments, 7.9)].first, 180);
});

test("the lanes' fragments of the same moment are fetched together, never past the horizon", () => {
  const video = cutFragments(samples(120, 1 / 30, 60));
  const sound = cutFragments({ count: 200, times: Float64Array.from({ length: 200 }, (_, index) => index * 0.02), sync: new Uint8Array(200).fill(1) });
  const lanes = [{ fragments: video, cursor: 0 }, { fragments: video, cursor: 0 }, { fragments: sound, cursor: 0 }];
  assert.deepEqual(nextBatch(lanes, 6), [[0], [0], [0]]);
  lanes[2].cursor = 1;
  assert.deepEqual(nextBatch(lanes, 6), [[0], [0], []], "a lane ahead of the others waits for them");
  assert.equal(nextBatch(lanes, 0), null);
  assert.equal(nextBatch([{ fragments: video, cursor: video.length }], 100), null, "nothing is left");
});

test("small drift is won back by playing slower or faster, large drift by a jump", () => {
  assert.deepEqual(correction(0.002), { rate: 1 });
  const ahead = correction(0.05);
  const behind = correction(-0.05);
  assert.ok(ahead.rate < 1 && ahead.rate > 0.9, "a video ahead slows down");
  assert.ok(behind.rate > 1 && behind.rate < 1.1, "a video behind speeds up");
  assert.ok(correction(0.15).rate >= 0.9, "the rate strays only so far");
  assert.deepEqual(correction(JUMP_DRIFT + 0.01), { jump: true });
  assert.deepEqual(correction(-1), { jump: true });
});

test("sound, every sample a sync sample, is cut by time alone", () => {
  const fragments = cutFragments({ count: 100, times: Float64Array.from({ length: 100 }, (_, index) => index * 0.02), sync: new Uint8Array(100).fill(1) });
  assert.deepEqual(fragments.map(({ first, end }) => [first, end]), [[0, 25], [25, 50], [50, 75], [75, 100]]);
});
