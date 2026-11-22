import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PANORAMA_HEIGHT, planPanorama, videoStreams } from "../src/lib/panorama.ts";

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
const hasFfmpeg = await run(ffmpeg, ["-version"]).then(
  () => true,
  () => false
);

const video = (stream, width, height) => ({ stream, width, height });

test("a file with a stream per lens is stitched from itself, its first stream in front", () => {
  const plan = planPanorama([{ name: "CAM_20260922093618_0009_D.OSV", videos: [video(0, 3840, 3840), video(1, 3840, 3840)] }]);
  assert.equal(plan.layout, "two-tracks");
  assert.deepEqual(plan.inputs, [0]);
  assert.match(plan.graph, /^\[0:0\].*\[0:1\].*hstack.*v360=input=dfisheye/);
});

test("a lens per file puts the _00_ file first whichever of the two was opened", () => {
  const front = { name: "VID_20240414_135511_00_202.insv", videos: [video(0, 2944, 2880)] };
  const back = { name: "VID_20240414_135511_10_202.insv", videos: [video(0, 2944, 2880)] };
  assert.deepEqual(planPanorama([front, back]).inputs, [0, 1]);
  const openedBack = planPanorama([back, front]);
  assert.equal(openedBack.layout, "two-files");
  assert.deepEqual(openedBack.inputs, [1, 0]);
  assert.match(openedBack.graph, /^\[0:0\].*\[1:0\].*v360=input=dfisheye/);
});

test("one picture twice as wide as it is tall goes to v360 as it is", () => {
  const plan = planPanorama([{ name: "VID_20230101_120000_00_001.insv", videos: [video(0, 5760, 2880)] }]);
  assert.equal(plan.layout, "side-by-side");
  assert.doesNotMatch(plan.graph, /hstack/);
  assert.match(plan.graph, /v360=input=dfisheye/);
});

test("a lens whose other file is missing shows the front half of the sphere", () => {
  const plan = planPanorama([{ name: "VID_20240414_135511_10_202.insv", videos: [video(0, 2944, 2880)] }]);
  assert.equal(plan.layout, "one-lens");
  assert.match(plan.graph, /v360=input=fisheye:/);
});

test("a file with no video has nothing to stitch", () => {
  assert.equal(planPanorama([{ name: "a.insv", videos: [] }]), null);
});

test("cover pictures are not taken for a lens", () => {
  const streams = [
    { index: 0, codec_type: "video", codec_name: "hevc", width: 3840, height: 3840 },
    { index: 1, codec_type: "video", codec_name: "hevc", width: 3840, height: 3840 },
    { index: 2, codec_type: "audio", codec_name: "aac" },
    { index: 7, codec_type: "video", codec_name: "mjpeg", width: 688, height: 344, disposition: { attached_pic: 1 } }
  ];
  assert.deepEqual(videoStreams(streams), [video(0, 3840, 3840), video(1, 3840, 3840)]);
});

/** Runs a plan's graph over test pictures of the given sizes, one input per file, and says how big the picture made is. */
async function stitch(plan, files) {
  const dir = await mkdtemp(path.join(tmpdir(), "kago-panorama-"));
  try {
    const out = path.join(dir, "out.png");
    const inputs = plan.inputs.flatMap((index) => files[index].flatMap(([width, height]) => ["-f", "lavfi", "-i", `testsrc2=size=${width}x${height}:rate=1`]));
    // lavfi gives each picture an input of its own, so a file of two streams is two inputs here.
    const graph = files[plan.inputs[0]].length === 2 ? plan.graph.replace("[0:1]", "[1:0]") : plan.graph;
    await run(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", ...inputs, "-filter_complex", `${graph}[out]`, "-map", "[out]", "-frames:v", "1", out]);
    const { stdout } = await run(process.env.FFPROBE_PATH ?? "ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", out]);
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("each layout's graph makes an equirectangular picture twice as wide as tall", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const expected = `${PANORAMA_HEIGHT * 2},${PANORAMA_HEIGHT}`;
  const twoTracks = [[[640, 640], [640, 640]]];
  assert.equal(await stitch(planPanorama([{ name: "a.osv", videos: [video(0, 640, 640), video(1, 640, 640)] }]), twoTracks), expected);
  const twoFiles = [[[656, 640]], [[656, 640]]];
  assert.equal(await stitch(planPanorama([{ name: "x_10_1.insv", videos: [video(0, 656, 640)] }, { name: "x_00_1.insv", videos: [video(0, 656, 640)] }]), twoFiles), expected);
  assert.equal(await stitch(planPanorama([{ name: "a.insv", videos: [video(0, 1280, 640)] }]), [[[1280, 640]]]), expected);
  assert.equal(await stitch(planPanorama([{ name: "a.insv", videos: [video(0, 656, 640)] }]), [[[656, 640]]]), expected);
});
