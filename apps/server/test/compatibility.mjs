import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../src/app.ts";
import { CompatibilityService } from "../src/services/compatibility.service.ts";

const ENCODERS = [
  " V....D libx264 H.264 encoder",
  " V....D libx265 HEVC encoder",
  " V....D h264_nvenc NVIDIA encoder",
  " V....D hevc_nvenc NVIDIA encoder",
  " V....D h264_vaapi VAAPI encoder",
  " V....D hevc_vaapi VAAPI encoder",
  " V....D h264_videotoolbox VideoToolbox encoder",
  " V....D hevc_videotoolbox VideoToolbox encoder"
].join("\n");
const DECODERS = [
  " V....D h264 H.264 decoder",
  " V....D hevc HEVC decoder",
  " V....D h264_cuvid NVIDIA decoder",
  " V....D hevc_cuvid NVIDIA decoder"
].join("\n");
const HWACCELS = "Hardware acceleration methods:\ncuda\nvaapi\nvideotoolbox\n";

test("diagnostics use fixed synthetic inputs, report hardware decode independently, single-flight, and cache", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-mock-test-"));
  const commands = [];
  const runner = async (command, args, options) => {
    commands.push({ command, args, options });
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (args[0] === "-version") return { stdout: "ffmpeg version 8.1.2-custom\n", stderr: "" };
    if (args.includes("-encoders")) return { stdout: ENCODERS, stderr: "" };
    if (args.includes("-decoders")) return { stdout: DECODERS, stderr: "" };
    if (args.includes("-hwaccels")) return { stdout: HWACCELS, stderr: "" };
    if (args.includes("h264_nvenc")) {
      const error = new Error("private device failure");
      error.stderr = "No NVENC capable devices found at /private/private-device";
      throw error;
    }
    const output = args.at(-1);
    if (output?.endsWith(".mkv")) await writeFile(output, Buffer.from("synthetic output"));
    return { stdout: "frame=4\nprogress=end\n", stderr: "" };
  };
  const service = new CompatibilityService({
    ffmpegPath: "mock-ffmpeg",
    runner,
    tempRoot: parent,
    platform: "darwin",
    nvidiaDeviceIndices: async () => [0],
    renderNodes: async () => ["/dev/dri/renderD128"]
  });

  try {
    const [first, concurrent] = await Promise.all([service.check(), service.check()]);
    assert.deepEqual(concurrent, first);
    assert.equal(first.ffmpeg.available, true);
    assert.equal(first.ffmpeg.version, "8.1.2-custom");
    assert.equal(first.checks.length, 16);

    const byId = Object.fromEntries(first.checks.map((check) => [check.id, check]));
    assert.equal(byId["nvenc-cuda-0-h264-encode"].status, "unavailable");
    assert.equal(byId["nvenc-cuda-0-h264-decode"].status, "passed", "failed hardware encode does not suppress hardware decode");
    assert.equal(byId["cpu-hevc-main10-encode"].status, "passed");
    assert.equal(byId["videotoolbox-system-hevc-main10-encode"].status, "passed");
    assert.equal(byId["videotoolbox-system-hevc-main10-encode"].backend, "Apple VideoToolbox");
    assert.ok(commands.some(({ args }) => args.includes("h264_cuvid")), "NVIDIA decode selects the hardware decoder directly");
    assert.ok(commands.some(({ args }) => args.includes("-hwaccel_output_format") && args.includes("cuda")), "NVIDIA decode keeps frames in CUDA memory");
    assert.ok(commands.some(({ args }) => args.includes("-hwaccel_output_format") && args.includes("vaapi")), "VA-API decode requires hardware frames");
    assert.ok(commands.some(({ args }) => args.includes("h264_vaapi") && args.includes("format=nv12,hwupload") && args[args.indexOf("-pix_fmt") + 1] === "vaapi"), "VA-API encoding keeps the filtered frame in hardware memory");
    assert.ok(commands.some(({ args }) => args.includes("-vf") && args.includes("hwdownload,format=nv12")), "decode must transfer a hardware frame before counting it");
    assert.ok(commands.some(({ args }) => args.includes("-vf") && args.includes("hwdownload,format=p010le")), "Main 10 decode must transfer a 10-bit hardware frame");
    assert.ok(commands.some(({ args }) => args.includes("-allow_sw") && args.includes("0")), "VideoToolbox encoding disables software fallback");
    assert.ok(commands.every(({ options }) => options.timeoutMs <= 5_000 && options.maxBufferBytes <= 128 * 1024));
    assert.equal(JSON.stringify(first).includes("/private/private-device"), false);
    assert.equal(JSON.stringify(first).includes(parent), false);
    assert.deepEqual(await readdir(parent), [], "temporary fixtures are removed after the report is built");

    const callCount = commands.length;
    await service.check();
    assert.equal(commands.length, callCount, "recent report is served from the short cache");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("missing FFmpeg returns unavailable rows without exposing process errors", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-missing-test-"));
  const service = new CompatibilityService({
    ffmpegPath: "missing-ffmpeg",
    tempRoot: parent,
    runner: async () => {
      const error = new Error("ffmpeg not found at /private/sensitive/install/ffmpeg");
      error.stderr = "/private/sensitive/install/ffmpeg";
      throw error;
    }
  });

  try {
    const report = await service.check();
    assert.deepEqual(report.ffmpeg, { available: false, version: null });
    assert.equal(report.checks.length, 16);
    assert.ok(report.checks.every((check) => check.status === "unavailable" && check.detail === "compatibility.ffmpegMissing"));
    assert.equal(JSON.stringify(report).includes("/private/sensitive"), false);
    assert.deepEqual(await readdir(parent), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("zero-frame decodes and empty encoded files fail validation", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-output-test-"));
  const runner = async (_command, args) => {
    if (args[0] === "-version") return { stdout: "ffmpeg version 8.1.2\n", stderr: "" };
    if (args.includes("-encoders")) return { stdout: ENCODERS, stderr: "" };
    if (args.includes("-decoders")) return { stdout: DECODERS, stderr: "" };
    if (args.includes("-hwaccels")) return { stdout: HWACCELS, stderr: "" };

    if (args.includes("-f") && args[args.indexOf("-f") + 1] === "null") {
      const hardwareDecode = args.includes("-vf") && args.some((arg) => arg.startsWith("hwdownload,format="));
      return { stdout: hardwareDecode ? "frame=4\nprogress=end\n" : "frame=0\nprogress=end\n", stderr: "" };
    }

    const encoder = args[args.indexOf("-c:v") + 1];
    const output = args.at(-1);
    if (output?.endsWith(".mkv")) {
      await writeFile(output, encoder === "libx265" ? Buffer.alloc(0) : Buffer.from("synthetic output"));
    }
    return { stdout: "frame=4\nprogress=end\n", stderr: "" };
  };
  const service = new CompatibilityService({
    ffmpegPath: "mock-ffmpeg",
    runner,
    tempRoot: parent,
    platform: "darwin",
    nvidiaDeviceIndices: async () => [0],
    renderNodes: async () => ["/dev/dri/renderD128"]
  });

  try {
    const report = await service.check();
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.equal(byId["cpu-h264-encode"].status, "passed");
    assert.equal(byId["cpu-h264-decode"].status, "failed");
    assert.equal(byId["cpu-h264-decode"].detail, "compatibility.outputInvalid", "zero decoded frames must not pass");
    assert.equal(byId["cpu-hevc-main10-encode"].status, "failed");
    assert.equal(byId["cpu-hevc-main10-encode"].detail, "compatibility.outputInvalid", "a zero-byte output must not pass even when progress reports frames");
    assert.equal(byId["cpu-hevc-main10-decode"].status, "unavailable", "an invalid fixture cannot be used for decode checks");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("temporary fixtures are removed when the command runner throws", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-runner-error-test-"));
  const runner = async (_command, args) => {
    if (args[0] === "-version") return { stdout: "ffmpeg version 8.1.2\n", stderr: "" };
    if (args.includes("-encoders")) return { stdout: ENCODERS, stderr: "" };
    if (args.includes("-decoders")) return { stdout: DECODERS, stderr: "" };
    if (args.includes("-hwaccels")) return { stdout: HWACCELS, stderr: "" };
    if (args.includes("-c:v") && args.includes("h264_nvenc")) {
      const error = new Error("raw process error");
      error.stderr = "No NVENC capable devices found at /Users/alice/Library/Private GPU diagnostics";
      throw error;
    }
    const output = args.at(-1);
    if (output?.endsWith(".mkv")) await writeFile(output, Buffer.from("synthetic output"));
    return { stdout: "frame=4\nprogress=end\n", stderr: "" };
  };
  const service = new CompatibilityService({
    ffmpegPath: "mock-ffmpeg",
    runner,
    tempRoot: parent,
    platform: "darwin",
    nvidiaDeviceIndices: async () => [0],
    renderNodes: async () => ["/dev/dri/renderD128"]
  });

  try {
    const report = await service.check();
    assert.equal(report.checks.find((check) => check.id === "nvenc-cuda-0-h264-encode").status, "unavailable");
    assert.equal(JSON.stringify(report).includes("/Users/alice"), false);
    assert.deepEqual(await readdir(parent), [], "the temp work directory is cleaned after process failures");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("a failed software fixture does not suppress independent hardware encoders", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-fixture-error-test-"));
  const commands = [];
  const runner = async (_command, args) => {
    commands.push(args);
    if (args[0] === "-version") return { stdout: "ffmpeg version 8.1.2\n", stderr: "" };
    if (args.includes("-encoders")) return { stdout: ENCODERS, stderr: "" };
    if (args.includes("-decoders")) return { stdout: DECODERS, stderr: "" };
    if (args.includes("-hwaccels")) return { stdout: HWACCELS, stderr: "" };
    const encoder = args[args.indexOf("-c:v") + 1];
    if (encoder === "libx264" || encoder === "libx265") throw new Error("synthetic software fixture failure");
    const output = args.at(-1);
    if (output?.endsWith(".mkv")) await writeFile(output, Buffer.from("synthetic hardware output"));
    return { stdout: "frame=4\nprogress=end\n", stderr: "" };
  };
  const service = new CompatibilityService({
    ffmpegPath: "mock-ffmpeg",
    runner,
    tempRoot: parent,
    platform: "darwin",
    nvidiaDeviceIndices: async () => [0],
    renderNodes: async () => ["/dev/dri/renderD128"]
  });

  try {
    const report = await service.check();
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.equal(byId["cpu-h264-encode"].status, "failed");
    assert.equal(byId["cpu-hevc-main10-encode"].status, "failed");
    assert.equal(byId["nvenc-cuda-0-h264-encode"].status, "passed");
    assert.equal(byId["vaapi-renderD128-hevc-main10-encode"].status, "passed");
    assert.equal(byId["videotoolbox-system-h264-encode"].status, "passed");
    assert.equal(byId["nvenc-cuda-0-h264-decode"].status, "unavailable");
    assert.equal(byId["nvenc-cuda-0-h264-decode"].detail, "compatibility.fixtureUnavailable");
    assert.ok(commands.some((args) => args.includes("h264_nvenc")), "hardware encoding is attempted even without a software fixture");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("hardware encoders are probed independently from decoder hwaccel support", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-encode-only-test-"));
  const runner = async (_command, args) => {
    if (args[0] === "-version") return { stdout: "ffmpeg version 8.1.2\n", stderr: "" };
    if (args.includes("-encoders")) return { stdout: ENCODERS, stderr: "" };
    if (args.includes("-decoders")) return { stdout: DECODERS, stderr: "" };
    if (args.includes("-hwaccels")) return { stdout: "Hardware acceleration methods:\n", stderr: "" };
    const output = args.at(-1);
    if (output?.endsWith(".mkv")) await writeFile(output, Buffer.from("synthetic output"));
    return { stdout: "frame=4\nprogress=end\n", stderr: "" };
  };
  const service = new CompatibilityService({
    ffmpegPath: "mock-ffmpeg",
    runner,
    tempRoot: parent,
    platform: "darwin",
    nvidiaDeviceIndices: async () => [0],
    renderNodes: async () => ["/dev/dri/renderD128"]
  });

  try {
    const report = await service.check();
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.equal(byId["nvenc-cuda-0-h264-encode"].status, "passed");
    assert.equal(byId["vaapi-renderD128-h264-encode"].status, "passed");
    assert.equal(byId["videotoolbox-system-hevc-main10-encode"].status, "passed");
    assert.equal(byId["nvenc-cuda-0-h264-decode"].status, "unsupported");
    assert.equal(byId["nvenc-cuda-0-h264-decode"].detail, "compatibility.hardwareBackendUnavailable");
    assert.equal(byId["vaapi-renderD128-h264-decode"].status, "unsupported");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("NVIDIA checks cover every FFmpeg-visible GPU and pin each encode and decode attempt", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-multi-nvidia-"));
  const commands = [];
  const runner = async (_command, args) => {
    commands.push(args);
    if (args[0] === "-version") return { stdout: "ffmpeg version 8.1.2\n", stderr: "" };
    if (args.includes("-encoders")) return { stdout: ENCODERS, stderr: "" };
    if (args.includes("-decoders")) return { stdout: DECODERS, stderr: "" };
    if (args.includes("-hwaccels")) return { stdout: HWACCELS, stderr: "" };

    const gpuOption = args.indexOf("-gpu");
    const gpu = gpuOption === -1 ? null : args[gpuOption + 1];
    const encoder = args[args.indexOf("-c:v") + 1];
    if (gpu === "list") {
      const listing = encoder === "h264_nvenc"
        ? "[ GPU #0 - <private model alpha> has Compute SM 8.9 ]\nsupports NVENC\n[ GPU #1 - <private model beta> has Compute SM 8.6 ]\nsupports NVENC\n"
        : "[ GPU #1 - <private model beta> has Compute SM 8.6 ]\nsupports NVENC\n[ GPU #2 - <private model gamma> has Compute SM 5.0 ]\ndoes not support NVENC\n";
      return { stdout: "", stderr: listing };
    }
    if (encoder === "h264_nvenc" && gpu === "0") {
      const error = new Error("synthetic GPU 0 encode failure");
      error.stderr = "synthetic GPU 0 encode failure";
      throw error;
    }
    if (encoder === "h264_nvenc" && gpu === "2") {
      const error = new Error("synthetic encoder does not support this device");
      error.stderr = "device does not support NVENC";
      throw error;
    }
    if (encoder === "h264_cuvid" && gpu === "1") {
      const error = new Error("synthetic GPU 1 decode failure");
      error.stderr = "synthetic GPU 1 decode failure";
      throw error;
    }
    const output = args.at(-1);
    if (output?.endsWith(".mkv")) await writeFile(output, Buffer.from("synthetic output"));
    return { stdout: "frame=4\nprogress=end\n", stderr: "" };
  };
  const service = new CompatibilityService({
    ffmpegPath: "mock-ffmpeg",
    runner,
    tempRoot: parent,
    platform: "linux",
    nvidiaDeviceIndices: undefined,
    renderNodes: async () => ["/dev/dri/renderD128"]
  });

  try {
    const report = await service.check();
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.equal(byId["nvenc-cuda-0-h264-encode"].status, "failed");
    assert.equal(byId["nvenc-cuda-0-h264-decode"].status, "passed");
    assert.equal(byId["nvenc-cuda-1-h264-encode"].status, "passed");
    assert.equal(byId["nvenc-cuda-1-h264-decode"].status, "failed");
    assert.equal(byId["nvenc-cuda-2-h264-encode"].status, "unsupported", "CUDA-visible devices remain listed when they lack NVENC");
    assert.equal(byId["nvenc-cuda-2-h264-encode"].deviceId, "cuda-2");
    assert.equal(byId["nvenc-cuda-0-h264-encode"].deviceLabel, "NVIDIA GPU 0");
    assert.equal(byId["nvenc-cuda-0-h264-encode"].deviceScope, "device");
    assert.equal(new Set(report.checks.map((check) => check.id)).size, report.checks.length);

    const listProbes = commands.filter((args) => args[args.indexOf("-gpu") + 1] === "list");
    assert.ok(listProbes.some((args) => args.includes("h264_nvenc")));
    assert.ok(listProbes.some((args) => args.includes("hevc_nvenc")));
    const h264EncodeAttempts = commands.filter((args) => args.includes("h264_nvenc") && args[args.indexOf("-gpu") + 1] !== "list");
    const h264DecodeAttempts = commands.filter((args) => args.includes("h264_cuvid"));
    assert.deepEqual(new Set(h264EncodeAttempts.map((args) => args[args.indexOf("-gpu") + 1])), new Set(["0", "1", "2"]));
    assert.deepEqual(new Set(h264DecodeAttempts.map((args) => args[args.indexOf("-gpu") + 1])), new Set(["0", "1", "2"]));
    for (const args of h264DecodeAttempts) {
      const selectedGpu = args[args.indexOf("-gpu") + 1];
      assert.equal(args[args.indexOf("-hwaccel_device") + 1], selectedGpu, "CUVID and CUDA hwaccel use the same FFmpeg-visible ordinal");
    }
    assert.equal(JSON.stringify(report).includes("private model"), false);
    assert.equal(JSON.stringify(report).includes(parent), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("CUDA decode capability without NVENC enumeration stays system-scoped and never defaults to GPU 0", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-cuda-unknown-"));
  const commands = [];
  const encodersWithoutNvenc = ENCODERS.split("\n").filter((line) => !line.includes("_nvenc")).join("\n");
  const runner = async (_command, args) => {
    commands.push(args);
    if (args[0] === "-version") return { stdout: "ffmpeg version 8.1.2\n", stderr: "" };
    if (args.includes("-encoders")) return { stdout: encodersWithoutNvenc, stderr: "" };
    if (args.includes("-decoders")) return { stdout: DECODERS, stderr: "" };
    if (args.includes("-hwaccels")) return { stdout: HWACCELS, stderr: "" };
    const output = args.at(-1);
    if (output?.endsWith(".mkv")) await writeFile(output, Buffer.from("synthetic output"));
    return { stdout: "frame=4\nprogress=end\n", stderr: "" };
  };
  const service = new CompatibilityService({
    ffmpegPath: "mock-ffmpeg",
    runner,
    tempRoot: parent,
    platform: "linux",
    renderNodes: async () => []
  });

  try {
    const report = await service.check();
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.deepEqual(report.discoveryNotes, ["compatibility.nvidiaDeviceEnumerationUnavailable"]);
    assert.equal(byId["nvenc-system-h264-decode"].status, "unavailable");
    assert.equal(byId["nvenc-system-h264-decode"].detail, "compatibility.nvidiaDeviceEnumerationUnavailable");
    assert.equal(byId["nvenc-system-h264-decode"].deviceScope, "system");
    assert.equal(byId["nvenc-system-h264-encode"].status, "unsupported");
    assert.equal(commands.some((args) => args.includes("-gpu")), false, "unknown discovery never selects a default GPU ordinal");
    assert.equal(commands.some((args) => args.some((arg) => arg.endsWith("_cuvid"))), false, "no CUVID workload runs without a selected device");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("VA-API keeps configured aliases and discovers every render node without a four-device cap", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-many-vaapi-"));
  const nodeRoot = path.join(parent, "render-nodes");
  const aliasRoot = path.join(parent, "by-path");
  await mkdir(nodeRoot, { recursive: true });
  await mkdir(aliasRoot, { recursive: true });
  const nodes = [];
  for (let index = 128; index < 135; index += 1) {
    const node = path.join(nodeRoot, "renderD" + index);
    await writeFile(node, "synthetic device node");
    nodes.push(node);
  }
  const configuredAlias = path.join(aliasRoot, "private-configured-alias");
  await symlink(nodes[2], configuredAlias);
  const commands = [];
  const runner = async (_command, args) => {
    commands.push(args);
    if (args[0] === "-version") return { stdout: "ffmpeg version 8.1.2\n", stderr: "" };
    if (args.includes("-encoders")) return { stdout: ENCODERS, stderr: "" };
    if (args.includes("-decoders")) return { stdout: DECODERS, stderr: "" };
    if (args.includes("-hwaccels")) return { stdout: HWACCELS, stderr: "" };
    const output = args.at(-1);
    if (output?.endsWith(".mkv")) await writeFile(output, Buffer.from("synthetic output"));
    return { stdout: "frame=4\nprogress=end\n", stderr: "" };
  };
  const service = new CompatibilityService({
    ffmpegPath: "mock-ffmpeg",
    runner,
    tempRoot: parent,
    platform: "linux",
    nvidiaDeviceIndices: async () => [],
    renderNodes: async () => nodes,
    configuredVaapiDevice: configuredAlias
  });

  try {
    const report = await service.check();
    const vaapiChecks = report.checks.filter((check) => check.backend === "VA-API");
    assert.equal(vaapiChecks.length, nodes.length * 4);
    for (let index = 128; index < 135; index += 1) {
      const deviceId = "vaapi-renderD" + index;
      const deviceChecks = vaapiChecks.filter((check) => check.deviceId === deviceId);
      assert.equal(deviceChecks.length, 4);
      assert.ok(deviceChecks.every((check) => check.deviceScope === "device"));
      assert.ok(report.checks.some((check) => check.id === deviceId + "-h264-encode"));
      const nodeName = path.basename(nodes[index - 128]);
      assert.ok(commands.some((args) => args.some((arg) => arg.startsWith("vaapi=va:") && arg.endsWith("/" + nodeName))));
    }
    assert.equal(vaapiChecks.find((check) => check.deviceId === "vaapi-renderD130").deviceLabel, "VA-API renderD130 (configured)");
    assert.equal(vaapiChecks.some((check) => check.deviceId === "vaapi-configured"), false, "the alias resolves to the already enumerated render node");
    assert.ok(vaapiChecks.every((check) => !check.deviceLabel?.includes("private-configured-alias")));
    assert.equal(new Set(report.checks.map((check) => check.id)).size, report.checks.length);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("failed device discovery remains unknown while configured VA-API checks and notes survive", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "kago-compat-discovery-unknown-"));
  const commands = [];
  const runner = async (_command, args) => {
    commands.push(args);
    if (args[0] === "-version") return { stdout: "ffmpeg version 8.1.2\n", stderr: "" };
    if (args.includes("-encoders")) return { stdout: ENCODERS, stderr: "" };
    if (args.includes("-decoders")) return { stdout: DECODERS, stderr: "" };
    if (args.includes("-hwaccels")) return { stdout: HWACCELS, stderr: "" };
    if (args[args.indexOf("-gpu") + 1] === "list") {
      const error = new Error("private NVIDIA enumeration error");
      error.stderr = "could not enumerate /private/sensitive/nvidia-device";
      throw error;
    }
    const output = args.at(-1);
    if (output?.endsWith(".mkv")) await writeFile(output, Buffer.from("synthetic output"));
    return { stdout: "frame=4\nprogress=end\n", stderr: "" };
  };
  const configuredDevice = "/private/sensitive/configured-vaapi";
  const service = new CompatibilityService({
    ffmpegPath: "mock-ffmpeg",
    runner,
    tempRoot: parent,
    platform: "linux",
    renderNodes: async () => {
      throw new Error("private render-node enumeration error");
    },
    configuredVaapiDevice: configuredDevice
  });

  try {
    const report = await service.check();
    const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
    assert.deepEqual(report.discoveryNotes, [
      "compatibility.nvidiaDeviceEnumerationUnavailable",
      "compatibility.vaapiDeviceEnumerationUnavailable"
    ]);
    for (const id of ["nvenc-system-h264-encode", "nvenc-system-h264-decode"]) {
      assert.equal(byId[id].status, "unavailable");
      assert.equal(byId[id].detail, "compatibility.nvidiaDeviceEnumerationUnavailable");
      assert.equal(byId[id].deviceScope, "system");
      assert.equal(byId[id].deviceId, null);
      assert.equal(byId[id].deviceLabel, null);
    }
    assert.equal(byId["vaapi-configured-h264-encode"].status, "passed", "an explicitly configured device remains testable during partial discovery");
    assert.equal(byId["vaapi-configured-h264-encode"].deviceLabel, "VA-API configured device");
    assert.equal(commands.some((args) => args.includes("h264_vaapi")), true, "VA-API work continues after NVIDIA discovery fails");
    assert.equal(commands.some((args) => args.includes("h264_nvenc") && args[args.indexOf("-gpu") + 1] !== "list"), false);
    assert.equal(JSON.stringify(report).includes("/private/sensitive"), false);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("server diagnostics endpoint requires CSRF, authentication, and an administrator", async () => {
  const fixture = await createFixture();
  const app = await buildApp({
    port: 0,
    dataDir: fixture.dataDir,
    appDataDir: fixture.appDataDir,
    sessionSecret: "compatibility-test-session-secret",
    nodeEnv: "test"
  });
  const admin = client(app);

  try {
    await app.ready();
    const noCsrf = await app.inject({ method: "POST", url: "/api/compatibility/server" });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(noCsrf.json().code, "CSRF_REQUIRED");

    const noSession = await app.inject({ method: "POST", url: "/api/compatibility/server", headers: { "x-kago-csrf": "1" } });
    assert.equal(noSession.statusCode, 401);

    const setup = await admin.post("/api/auth/setup", {
      email: "admin@example.test",
      password: "fake-admin-password-123",
      displayName: "Compatibility Admin"
    });
    assert.equal(setup.statusCode, 200);
    const created = await admin.post("/api/users", {
      email: "viewer@example.test",
      password: "fake-viewer-password-123",
      displayName: "Compatibility Viewer",
      role: "USER"
    });
    assert.equal(created.statusCode, 200);
    const viewer = client(app);
    assert.equal((await viewer.post("/api/auth/login", { email: "viewer@example.test", password: "fake-viewer-password-123" })).statusCode, 200);
    assert.equal((await viewer.post("/api/compatibility/server")).statusCode, 403);

    const response = await admin.post("/api/compatibility/server");
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["cache-control"], "no-store");
    const report = response.json();
    assert.equal(Number.isNaN(Date.parse(report.checkedAt)), false);
    assert.deepEqual(Object.keys(report.ffmpeg).sort(), ["available", "version"]);
    assert.ok(report.checks.length >= 4);
    assert.ok(report.checks.every((check) => typeof check.id === "string" && typeof check.detail === "string"));
    assert.ok(report.checks.every((check) => ["device", "system", "none"].includes(check.deviceScope)));
    assert.equal(new Set(report.checks.map((check) => check.id)).size, report.checks.length);
    assert.equal("selectedEncoder" in report, false);
    if (report.ffmpeg.available) {
      const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
      assert.notEqual(byId["cpu-h264-encode"].status, "failed", "installed FFmpeg should either run the H.264 test or report its encoder unavailable");
      if (byId["cpu-h264-encode"].status === "passed") assert.equal(byId["cpu-h264-decode"].status, "passed");
      assert.notEqual(byId["cpu-hevc-main10-encode"].status, "failed", "installed FFmpeg should either run the Main 10 test or report its encoder unavailable");
      if (byId["cpu-hevc-main10-encode"].status === "passed") assert.equal(byId["cpu-hevc-main10-decode"].status, "passed");
    }
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

async function createFixture() {
  const baseDir = await mkdtemp(path.join(tmpdir(), "kago-compat-endpoint-"));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  await mkdir(path.join(dataDir, "photos", "public"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  return { baseDir, dataDir, appDataDir };
}

function client(app) {
  let cookie = "";

  async function request(method, url, body) {
    const headers = { accept: "application/json", ...(cookie ? { cookie } : {}) };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["x-kago-csrf"] = "1";
    const response = await app.inject({ method, url, headers, payload });
    const setCookies = response.headers["set-cookie"];
    for (const value of Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []) {
      const pair = value.split(";", 1)[0];
      if (!pair) continue;
      const [name] = pair.split("=");
      cookie = cookie.split("; ").filter((item) => item && !item.startsWith(`${name}=`)).concat(pair).join("; ");
    }
    return response;
  }

  return {
    post: (url, body) => request("POST", url, body)
  };
}
