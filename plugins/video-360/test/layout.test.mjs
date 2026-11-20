import assert from "node:assert/strict";
import test from "node:test";
import { planRecording } from "../src/source.ts";
import { planReads } from "../src/reads.ts";

const video = (file, trackId, width, height) => ({ file, trackId, codec: "hvc1.2.4.H156.B0", width, height });
const whole = (width, height) => ({ x: 0, y: 0, w: width, h: height });

test("a file with a track per lens is played as two lenses, the first track in front", () => {
  const plan = planRecording([{ name: "CAM_20260922093618_0009_D.OSV", videos: [video(0, 1, 3840, 3840), video(0, 2, 3840, 3840)] }]);
  assert.equal(plan.layout, "two-tracks");
  assert.deepEqual(plan.streams, [{ file: 0, trackId: 1 }, { file: 0, trackId: 2 }]);
  assert.deepEqual(plan.lenses, [{ stream: 0, crop: whole(3840, 3840) }, { stream: 1, crop: whole(3840, 3840) }]);
  assert.equal(plan.missingLens, false);
});

test("one picture twice as wide as it is tall holds both lenses, left in front", () => {
  const plan = planRecording([{ name: "VID_20230101_120000_00_001.insv", videos: [video(0, 1, 5760, 2880)] }]);
  assert.equal(plan.layout, "side-by-side");
  assert.deepEqual(plan.streams, [{ file: 0, trackId: 1 }]);
  assert.deepEqual(plan.lenses, [{ stream: 0, crop: whole(2880, 2880) }, { stream: 0, crop: { x: 2880, y: 0, w: 2880, h: 2880 } }]);
});

test("a lens per file puts the _00_ file in front whichever of the two was opened", () => {
  const front = { name: "VID_20240414_135511_00_202.insv", videos: [video(0, 1, 2944, 2880)] };
  const back = { name: "VID_20240414_135511_10_202.insv", videos: [video(1, 1, 2944, 2880)] };
  const openedFront = planRecording([front, back]);
  assert.equal(openedFront.layout, "two-files");
  assert.deepEqual(openedFront.streams, [{ file: 0, trackId: 1 }, { file: 1, trackId: 1 }]);

  const openedBack = planRecording([{ ...back, videos: [video(0, 1, 2944, 2880)] }, { ...front, videos: [video(1, 1, 2944, 2880)] }]);
  assert.deepEqual(openedBack.streams, [{ file: 1, trackId: 1 }, { file: 0, trackId: 1 }]);
  assert.equal(openedBack.missingLens, false);
});

test("a lens whose other file is missing is shown alone, and says so", () => {
  const plan = planRecording([{ name: "VID_20240414_135511_10_202.insv", videos: [video(0, 1, 2944, 2880)] }]);
  assert.equal(plan.layout, "one-lens");
  assert.deepEqual(plan.lenses, [{ stream: 0, crop: whole(2944, 2880) }]);
  assert.equal(plan.missingLens, true);
});

test("tracks of different sizes are not taken for a pair, and no video is no plan", () => {
  const plan = planRecording([{ name: "clip.osv", videos: [video(0, 1, 3840, 3840), video(0, 2, 1920, 1080)] }]);
  assert.equal(plan.layout, "one-lens");
  assert.equal(plan.missingLens, false);
  assert.equal(planRecording([{ name: "clip.osv", videos: [] }]), null);
});

const MiB = 1024 * 1024;

test("samples close together in a file are fetched in one read, gap and all", () => {
  const spans = [
    { file: 0, offset: 1000, size: 300 },
    { file: 0, offset: 0, size: 500 },
    { file: 0, offset: 600, size: 100 }
  ];
  assert.deepEqual(planReads(spans, 8 * MiB, 512 * 1024), [{ file: 0, start: 0, end: 1300, spans: [1, 2, 0] }]);
});

test("a read never passes the most Kago hands back, nor spans a wide gap or two files", () => {
  const spans = [
    { file: 0, offset: 0, size: 5 * MiB },
    { file: 0, offset: 5 * MiB, size: 4 * MiB },
    { file: 0, offset: 20 * MiB, size: 10 },
    { file: 1, offset: 20 * MiB + 10, size: 10 }
  ];
  assert.deepEqual(
    planReads(spans, 8 * MiB, 512 * 1024).map(({ file, start, end }) => [file, start, end]),
    [
      [0, 0, 5 * MiB],
      [0, 5 * MiB, 9 * MiB],
      [0, 20 * MiB, 20 * MiB + 10],
      [1, 20 * MiB + 10, 20 * MiB + 20]
    ]
  );
});

test("one sample larger than a read is still read whole, on its own", () => {
  assert.deepEqual(planReads([{ file: 0, offset: 10, size: 9 * MiB }], 8 * MiB, 0), [{ file: 0, start: 10, end: 10 + 9 * MiB, spans: [0] }]);
});
