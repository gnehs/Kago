import { execFile } from "node:child_process";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile) as (
  file: string,
  args: string[],
  options: { timeout: number; maxBuffer: number; encoding: "utf8"; killSignal: "SIGKILL"; windowsHide: true }
) => Promise<{ stdout: string; stderr: string }>;

const CACHE_MS = 30_000;
const PROCESS_TIMEOUT_MS = 5_000;
const MAX_PROCESS_OUTPUT_BYTES = 128 * 1024;
const TEST_FRAMES = 4;
const TEST_SOURCE = "testsrc2=size=320x180:rate=4:duration=1";
const COMMON_ARGS = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y"];
const PROGRESS_ARGS = ["-progress", "pipe:1", "-nostats"];

export type CompatibilityStatus = "passed" | "failed" | "unsupported" | "unavailable";
export type CompatibilityOperation = "encode" | "decode";
export type CompatibilityDeviceScope = "device" | "system" | "none";

export type CompatibilityCheck = {
  id: string;
  label: string;
  codec: "H.264" | "HEVC Main 10";
  operation: CompatibilityOperation;
  backend: "CPU" | "NVIDIA NVENC / CUDA" | "VA-API" | "Apple VideoToolbox";
  hardware: boolean;
  status: CompatibilityStatus;
  /** Stable localization key. Never includes a process error, command line, or local path. */
  detail: string;
  durationMs: number | null;
  deviceId: string | null;
  deviceLabel: string | null;
  deviceScope: CompatibilityDeviceScope;
};

export type CompatibilityReport = {
  checkedAt: string;
  ffmpeg: { available: boolean; version: string | null };
  checks: CompatibilityCheck[];
  /** Stable localization keys describing discovery limits; raw process errors are never returned. */
  discoveryNotes?: string[];
};

type RunOptions = { timeoutMs: number; maxBufferBytes: number };
type RunResult = { stdout: string; stderr: string };
export type CompatibilityRunner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

type Codec = {
  id: "h264" | "hevc-main10";
  label: "H.264" | "HEVC Main 10";
  softwareEncoder: "libx264" | "libx265";
  softwareDecoder: "h264" | "hevc";
  hardwareEncoder: Record<HardwareBackend["id"], string>;
  hardwareDecoder: Record<HardwareBackend["id"], string>;
  pixelFormat: "yuv420p" | "yuv420p10le";
  hardwarePixelFormat: "yuv420p" | "p010le";
  vaapiPixelFormat: "nv12" | "p010le";
};

type HardwareBackend = {
  id: "nvenc" | "vaapi" | "videotoolbox";
  label: CompatibilityCheck["backend"] & string;
  hardwareAcceleration: "cuda" | "vaapi" | "videotoolbox";
};

const CODECS: Codec[] = [
  {
    id: "h264",
    label: "H.264",
    softwareEncoder: "libx264",
    softwareDecoder: "h264",
    hardwareEncoder: { nvenc: "h264_nvenc", vaapi: "h264_vaapi", videotoolbox: "h264_videotoolbox" },
    hardwareDecoder: { nvenc: "h264_cuvid", vaapi: "h264", videotoolbox: "h264" },
    pixelFormat: "yuv420p",
    hardwarePixelFormat: "yuv420p",
    vaapiPixelFormat: "nv12"
  },
  {
    id: "hevc-main10",
    label: "HEVC Main 10",
    softwareEncoder: "libx265",
    softwareDecoder: "hevc",
    hardwareEncoder: { nvenc: "hevc_nvenc", vaapi: "hevc_vaapi", videotoolbox: "hevc_videotoolbox" },
    hardwareDecoder: { nvenc: "hevc_cuvid", vaapi: "hevc", videotoolbox: "hevc" },
    pixelFormat: "yuv420p10le",
    hardwarePixelFormat: "p010le",
    vaapiPixelFormat: "p010le"
  }
];

const HARDWARE_BACKENDS: HardwareBackend[] = [
  { id: "nvenc", label: "NVIDIA NVENC / CUDA", hardwareAcceleration: "cuda" },
  { id: "vaapi", label: "VA-API", hardwareAcceleration: "vaapi" },
  { id: "videotoolbox", label: "Apple VideoToolbox", hardwareAcceleration: "videotoolbox" }
];

type HardwareDevice = {
  /** Safe suffix used in check IDs. */
  idSegment: string;
  /** Opaque backend-local identifier used by the UI and API. */
  deviceId: string | null;
  deviceLabel: string | null;
  deviceScope: Exclude<CompatibilityDeviceScope, "none">;
  /** Internal FFmpeg selector. Never included in the report. */
  selector: string | null;
};

type HardwareExecution = { backend: HardwareBackend; device: HardwareDevice };
type NvidiaDiscovery = { state: "ready" | "empty" | "unknown" | "not-applicable"; devices: HardwareDevice[] };
type VaapiDiscovery = { state: "ready" | "empty" | "unknown"; devices: Array<HardwareDevice & { path: string }> };
type CheckDescriptor = Omit<CompatibilityCheck, "status" | "detail" | "durationMs">;

const SYSTEM_DEVICE: HardwareDevice = {
  idSegment: "system",
  deviceId: null,
  deviceLabel: null,
  deviceScope: "system",
  selector: null
};

function descriptors(devices: Record<HardwareBackend["id"], HardwareDevice[]> = {
  nvenc: [SYSTEM_DEVICE],
  vaapi: [SYSTEM_DEVICE],
  videotoolbox: [SYSTEM_DEVICE]
}): CheckDescriptor[] {
  const software = CODECS.flatMap((codec) =>
    (["encode", "decode"] as const).map((operation) => descriptor(codec, operation, "CPU", false, "cpu", null))
  );
  const hardware = HARDWARE_BACKENDS.flatMap((backend) =>
    devices[backend.id].flatMap((device) =>
      CODECS.flatMap((codec) =>
        (["encode", "decode"] as const).map((operation) =>
          descriptor(codec, operation, backend.label, true, backend.id, device)
        )
      )
    )
  );
  return [...software, ...hardware];
}

function descriptor(
  codec: Codec,
  operation: CompatibilityOperation,
  backend: CompatibilityCheck["backend"],
  hardware: boolean,
  backendId: "cpu" | HardwareBackend["id"],
  device: HardwareDevice | null
): CheckDescriptor {
  const idPrefix = backendId === "cpu" ? "cpu" : backendId + "-" + (device?.idSegment ?? "system");
  return {
    id: idPrefix + "-" + codec.id + "-" + operation,
    label: codec.label + " " + operation,
    codec: codec.label,
    operation,
    backend,
    hardware,
    deviceId: backendId === "cpu" ? null : device?.deviceId ?? null,
    deviceLabel: backendId === "cpu" ? null : device?.deviceLabel ?? null,
    deviceScope: backendId === "cpu" ? "none" : device?.deviceScope ?? "system"
  };
}

function makeCheck(
  descriptor: CheckDescriptor,
  status: CompatibilityStatus,
  detail: string,
  durationMs: number | null
): CompatibilityCheck {
  return { ...descriptor, status, detail, durationMs };
}

function cloneReport(report: CompatibilityReport): CompatibilityReport {
  return {
    ...report,
    ffmpeg: { ...report.ffmpeg },
    ...(report.discoveryNotes ? { discoveryNotes: [...report.discoveryNotes] } : {}),
    checks: report.checks.map((check) => ({ ...check }))
  };
}

function parseNvidiaOrdinals(output: string): number[] {
  const indices = new Set<number>();
  for (const match of output.matchAll(/\bGPU\s*#(\d+)\s*-/gi)) {
    const index = Number(match[1]);
    if (Number.isSafeInteger(index) && index >= 0) indices.add(index);
  }
  return [...indices].sort((a, b) => a - b);
}

function processOutput(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const output = [
    "stdout" in error && typeof error.stdout === "string" ? error.stdout : "",
    "stderr" in error && typeof error.stderr === "string" ? error.stderr : ""
  ].join("\n");
  return output.slice(0, MAX_PROCESS_OUTPUT_BYTES);
}

function nvidiaDevice(index: number): HardwareDevice {
  return {
    idSegment: "cuda-" + index,
    deviceId: "cuda-" + index,
    deviceLabel: "NVIDIA GPU " + index,
    deviceScope: "device",
    selector: String(index)
  };
}

function vaapiDevices(paths: string[], configuredPath: string | null): Array<HardwareDevice & { path: string }> {
  const sorted = [...new Set(paths)].sort();
  const usedSegments = new Set<string>();
  return sorted.map((devicePath, index) => {
    const basename = path.basename(devicePath);
    const renderNode = /^renderD\d{1,6}$/.test(basename) ? basename : null;
    const configured = configuredPath === devicePath;
    const baseSegment = renderNode ?? (configured ? "configured" : "device-" + (index + 1));
    let idSegment = baseSegment;
    let duplicate = 2;
    while (usedSegments.has(idSegment)) idSegment = baseSegment + "-" + duplicate++;
    usedSegments.add(idSegment);
    const publicLabel = renderNode
      ? "VA-API " + renderNode + (configured ? " (configured)" : "")
      : configured
        ? "VA-API configured device"
        : "VA-API device " + (index + 1);
    return {
      idSegment,
      deviceId: "vaapi-" + idSegment,
      deviceLabel: publicLabel,
      deviceScope: "device",
      selector: devicePath,
      path: devicePath
    };
  });
}

function parseVersion(stdout: string): string | null {
  const candidate = /^ffmpeg version ([^\s]+)/m.exec(stdout)?.[1];
  return candidate && /^[A-Za-z0-9.+_-]{1,80}$/.test(candidate) ? candidate : null;
}

function hasListedName(listing: string, name: string): boolean {
  return listing.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[1] === name);
}

function hasHardwareAcceleration(listing: string, name: string): boolean {
  return listing.split(/\r?\n/).some((line) => line.trim() === name);
}

function frameCount(stdout: string): number {
  let frames = 0;
  for (const match of stdout.matchAll(/^frame=(\d+)\s*$/gm)) frames = Math.max(frames, Number(match[1]));
  return frames;
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const stderr = "stderr" in error ? error.stderr : undefined;
  return typeof stderr === "string" ? stderr.slice(0, 16 * 1024) : "";
}

function hardwareFailureStatus(error: unknown): { status: CompatibilityStatus; detail: string } {
  const text = errorText(error);
  if (/hardware encoder (may be busy|is busy)|cannot create compression session|failed setup for format.*hwaccel initiali[sz]ation returned error|kiosurface.*failed/i.test(text)) {
    return { status: "unavailable", detail: "compatibility.hardwareUnavailable" };
  }
  if (/not supported|unsupported|no support|does not support/i.test(text)) {
    return { status: "unsupported", detail: "compatibility.hardwareCodecUnsupported" };
  }
  if (/no .*device|device .*not found|cannot (open|load|create|initialize|initialise)|failed to (open|create|initialize|initialise).*device|no va display|no vaapi device|no nvenc capable device|cannot load libcuda|hardware.*not available/i.test(text)) {
    return { status: "unavailable", detail: "compatibility.hardwareUnavailable" };
  }
  return { status: "failed", detail: "compatibility.hardwareTestFailed" };
}

type CompatibilityServiceOptions = {
  ffmpegPath?: string;
  runner?: CompatibilityRunner;
  /** Test seam for a temporary parent directory; production uses the operating system temporary directory. */
  tempRoot?: string;
  /** Test seam for platform and render-node discovery. */
  platform?: NodeJS.Platform;
  renderNodes?: () => Promise<string[]>;
  /** Test seam for CUDA-visible FFmpeg device ordinals. */
  nvidiaDeviceIndices?: () => Promise<number[]>;
  /** Test seam for TRANSCODE_VAAPI_DEVICE without changing transcoder configuration. */
  configuredVaapiDevice?: string;
};

/** Runs small, fixed FFmpeg workloads and reports only the result, never raw process output or paths. */
export class CompatibilityService {
  private readonly ffmpegPath: string;
  private readonly runner: CompatibilityRunner;
  private readonly tempRoot: string;
  private readonly platform: NodeJS.Platform;
  private readonly renderNodesOverride: (() => Promise<string[]>) | undefined;
  private readonly nvidiaDeviceIndicesOverride: (() => Promise<number[]>) | undefined;
  private readonly configuredVaapiDeviceOverride: string | undefined;
  private inFlight: Promise<CompatibilityReport> | null = null;
  private cached: { expiresAt: number; report: CompatibilityReport } | null = null;

  constructor(options: CompatibilityServiceOptions = {}) {
    this.ffmpegPath = options.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
    this.runner = options.runner ?? runCommand;
    this.tempRoot = options.tempRoot ?? os.tmpdir();
    this.platform = options.platform ?? process.platform;
    this.renderNodesOverride = options.renderNodes;
    this.nvidiaDeviceIndicesOverride = options.nvidiaDeviceIndices;
    this.configuredVaapiDeviceOverride = options.configuredVaapiDevice;
  }

  check(): Promise<CompatibilityReport> {
    if (this.cached && this.cached.expiresAt > Date.now()) return Promise.resolve(cloneReport(this.cached.report));
    if (this.inFlight) return this.inFlight.then(cloneReport);

    const flight = this.runChecks();
    this.inFlight = flight;
    return flight
      .then((report) => {
        this.cached = { expiresAt: Date.now() + CACHE_MS, report: cloneReport(report) };
        return cloneReport(report);
      })
      .finally(() => {
        if (this.inFlight === flight) this.inFlight = null;
      });
  }

  private async runChecks(): Promise<CompatibilityReport> {
    const checkedAt = () => new Date().toISOString();
    const allDescriptors = descriptors();
    let version: string | null;
    try {
      const result = await this.run(["-version"]);
      version = parseVersion(result.stdout);
    } catch {
      return {
        checkedAt: checkedAt(),
        ffmpeg: { available: false, version: null },
        checks: allDescriptors.map((item) => makeCheck(item, "unavailable", "compatibility.ffmpegMissing", null))
      };
    }

    const [encoderProbe, decoderProbe, hwaccelProbe] = await Promise.all([
      this.readListing("-encoders"),
      this.readListing("-decoders"),
      this.readListing("-hwaccels")
    ]);
    if (!encoderProbe.available || !decoderProbe.available || !hwaccelProbe.available) {
      return {
        checkedAt: checkedAt(),
        ffmpeg: { available: true, version },
        checks: allDescriptors.map((item) => makeCheck(item, "unavailable", "compatibility.capabilityProbeFailed", null))
      };
    }
    const { listing: encoderListing } = encoderProbe;
    const { listing: decoderListing } = decoderProbe;
    const { listing: hwaccelListing } = hwaccelProbe;

    let workDir: string;
    try {
      workDir = await mkdtemp(path.join(this.tempRoot, "kago-compat-"));
    } catch {
      return {
        checkedAt: checkedAt(),
        ffmpeg: { available: true, version },
        checks: allDescriptors.map((item) => makeCheck(item, "unavailable", "compatibility.fixtureUnavailable", null))
      };
    }

    try {
      const vaapiDiscovery = await this.getRenderNodes();
      const nvidiaDiscovery = await this.discoverNvidiaDevices(encoderListing, decoderListing, hwaccelListing);
      const checksByDevice = {
        nvenc: nvidiaDiscovery.devices.length ? nvidiaDiscovery.devices : [SYSTEM_DEVICE],
        vaapi: vaapiDiscovery.devices.length ? vaapiDiscovery.devices : [SYSTEM_DEVICE],
        videotoolbox: [SYSTEM_DEVICE]
      };
      const discoveryNotes = [
        ...(nvidiaDiscovery.state === "unknown" ? ["compatibility.nvidiaDeviceEnumerationUnavailable"] : []),
        ...(vaapiDiscovery.state === "unknown" ? ["compatibility.vaapiDeviceEnumerationUnavailable"] : [])
      ];
      const encoded = await Promise.all(
        CODECS.map(async (codec) => {
          const check = descriptor(codec, "encode", "CPU", false, "cpu", null);
          const output = path.join(workDir, "fixture-" + codec.id + ".mkv");
          const result = await this.runEncode(check, codec, output, encoderListing, null);
          return { codec, output: result.status === "passed" ? output : null, check: result };
        })
      );

      const decoded = await Promise.all(
        CODECS.map(async (codec) => {
          const check = descriptor(codec, "decode", "CPU", false, "cpu", null);
          const fixture = encoded.find((item) => item.codec.id === codec.id)?.output;
          if (!fixture) return makeCheck(check, "unavailable", "compatibility.fixtureUnavailable", null);
          return this.runDecode(check, codec, fixture, decoderListing, null);
        })
      );

      const hardwareGroups: CompatibilityCheck[][] = [];
      for (const backend of HARDWARE_BACKENDS) {
        const discovery = backend.id === "nvenc" ? nvidiaDiscovery : backend.id === "vaapi" ? vaapiDiscovery : null;
        const devices = checksByDevice[backend.id].map((device) => {
          if (backend.id !== "vaapi") return device;
          return vaapiDiscovery.devices.find((candidate) => candidate.idSegment === device.idSegment) ?? device;
        });
        hardwareGroups.push(await this.runHardwareBackend(
          backend,
          devices,
          discovery?.state ?? "not-applicable",
          workDir,
          encoded,
          encoderListing,
          decoderListing,
          hwaccelListing
        ));
      }

      return {
        checkedAt: checkedAt(),
        ffmpeg: { available: true, version },
        checks: [...encoded.map(({ check }) => check), ...decoded, ...hardwareGroups.flat()],
        ...(discoveryNotes.length ? { discoveryNotes } : {})
      };
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async readListing(option: "-encoders" | "-decoders" | "-hwaccels"): Promise<{ available: boolean; listing: string }> {
    try {
      return { available: true, listing: (await this.run(["-hide_banner", option])).stdout };
    } catch {
      return { available: false, listing: "" };
    }
  }

  private async getRenderNodes(): Promise<VaapiDiscovery> {
    const configuredRaw = this.configuredVaapiDeviceOverride ?? process.env.TRANSCODE_VAAPI_DEVICE ?? null;
    const configured = configuredRaw ? await this.canonicalDevicePath(configuredRaw) : null;
    let paths: string[] = [];
    let state: VaapiDiscovery["state"] = "empty";
    if (this.renderNodesOverride) {
      try {
        paths = await this.renderNodesOverride();
        state = "ready";
      } catch {
        state = "unknown";
      }
    } else if (this.platform === "linux") {
      try {
        const entries = await readdir("/dev/dri");
        paths = entries.filter((name) => /^renderD\d+$/.test(name)).map((name) => path.join("/dev/dri", name));
        state = "ready";
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
        state = code === "ENOENT" ? "empty" : "unknown";
      }
    }
    const canonicalPaths = await Promise.all(paths.map((devicePath) => this.canonicalDevicePath(devicePath)));
    if (configured && !canonicalPaths.includes(configured)) canonicalPaths.push(configured);
    const devices = vaapiDevices(canonicalPaths, configured);
    if (state !== "unknown") state = devices.length ? "ready" : "empty";
    return { state, devices };
  }

  private async canonicalDevicePath(devicePath: string): Promise<string> {
    try {
      return await realpath(devicePath);
    } catch {
      return path.normalize(devicePath);
    }
  }

  private async discoverNvidiaDevices(
    encoderListing: string,
    decoderListing: string,
    hwaccelListing: string
  ): Promise<NvidiaDiscovery> {
    if (this.nvidiaDeviceIndicesOverride) {
      try {
        const indices = [...new Set((await this.nvidiaDeviceIndicesOverride()).filter((index) =>
          Number.isSafeInteger(index) && index >= 0
        ))].sort((a, b) => a - b);
        return { state: indices.length ? "ready" : "empty", devices: indices.map(nvidiaDevice) };
      } catch {
        return { state: "unknown", devices: [] };
      }
    }

    const encoders = ["h264_nvenc", "hevc_nvenc"].filter((encoder) => hasListedName(encoderListing, encoder));
    if (!encoders.length) {
      const hasCudaDecoder = ["h264_cuvid", "hevc_cuvid"].some((decoder) => hasListedName(decoderListing, decoder));
      const cudaListed = hasHardwareAcceleration(hwaccelListing, "cuda");
      return { state: hasCudaDecoder || cudaListed ? "unknown" : "not-applicable", devices: [] };
    }

    const indices = new Set<number>();
    let explicitEmptyProbes = 0;
    for (const encoder of encoders) {
      const args = [
        "-nostdin", "-hide_banner", "-loglevel", "info", "-y",
        "-f", "lavfi", "-i", TEST_SOURCE,
        "-frames:v", "1", "-an",
        "-c:v", encoder, "-gpu", "list",
        "-f", "null", "-"
      ];
      let output = "";
      try {
        const result = await this.run(args);
        output = result.stdout + "\n" + result.stderr;
      } catch (error) {
        output = processOutput(error);
      }
      for (const index of parseNvidiaOrdinals(output)) indices.add(index);
      if (/no cuda capable devices found/i.test(output)) explicitEmptyProbes += 1;
    }

    const ordered = [...indices].sort((a, b) => a - b);
    if (ordered.length) return { state: "ready", devices: ordered.map(nvidiaDevice) };
    if (explicitEmptyProbes === encoders.length) return { state: "empty", devices: [] };
    return { state: "unknown", devices: [] };
  }

  private async runHardwareBackend(
    backend: HardwareBackend,
    devices: HardwareDevice[],
    discoveryState: NvidiaDiscovery["state"] | VaapiDiscovery["state"] | "not-applicable",
    workDir: string,
    encoded: Array<{ codec: Codec; output: string | null }>,
    encoderListing: string,
    decoderListing: string,
    hwaccelListing: string
  ): Promise<CompatibilityCheck[]> {
    const checks: CompatibilityCheck[] = [];
    for (const device of devices) {
      for (const codec of CODECS) {
        const encode = descriptor(codec, "encode", backend.label, true, backend.id, device);
        checks.push(await this.runHardwareEncode(
          encode,
          codec,
          path.join(workDir, backend.id + "-" + device.idSegment + "-" + codec.id + ".mkv"),
          { backend, device },
          encoderListing,
          discoveryState
        ));

        const decode = descriptor(codec, "decode", backend.label, true, backend.id, device);
        const fixture = encoded.find((item) => item.codec.id === codec.id)?.output;
        if (!fixture) {
          checks.push(makeCheck(decode, "unavailable", "compatibility.fixtureUnavailable", null));
        } else {
          checks.push(await this.runHardwareDecode(
            decode,
            codec,
            fixture,
            { backend, device },
            decoderListing,
            hwaccelListing,
            discoveryState
          ));
        }
      }
    }
    return checks;
  }

  private async runEncode(
    check: CheckDescriptor,
    codec: Codec,
    output: string,
    encoderListing: string,
    hardware: HardwareExecution | null
  ): Promise<CompatibilityCheck> {
    const encoder = hardware ? codec.hardwareEncoder[hardware.backend.id] : codec.softwareEncoder;
    if (!hasListedName(encoderListing, encoder)) {
      return makeCheck(check, "unsupported", "compatibility.encoderUnavailable", null);
    }

    const started = Date.now();
    try {
      const args = hardware
        ? this.hardwareEncodeArgs(codec, encoder, hardware.backend, hardware.device, output)
        : this.softwareEncodeArgs(codec, encoder, output);
      const result = await this.run(args);
      const frames = frameCount(result.stdout);
      const outputBytes = await stat(output).then((file) => file.size, () => 0);
      const durationMs = Math.max(0, Date.now() - started);
      if (frames < 1 || outputBytes < 1) return makeCheck(check, "failed", "compatibility.outputInvalid", durationMs);
      return makeCheck(check, "passed", "compatibility.passed", durationMs);
    } catch (error) {
      const failure = hardware ? hardwareFailureStatus(error) : { status: "failed" as const, detail: "compatibility.encodeFailed" };
      return makeCheck(check, failure.status, failure.detail, Math.max(0, Date.now() - started));
    }
  }

  private async runDecode(
    check: CheckDescriptor,
    codec: Codec,
    fixture: string,
    decoderListing: string,
    hardware: HardwareExecution | null
  ): Promise<CompatibilityCheck> {
    const decoder = hardware ? codec.hardwareDecoder[hardware.backend.id] : codec.softwareDecoder;
    if (hardware && hardware.backend.id === "nvenc") {
      if (!hasListedName(decoderListing, decoder)) return makeCheck(check, "unsupported", "compatibility.decoderUnavailable", null);
    } else if (!hasListedName(decoderListing, decoder)) {
      return makeCheck(check, "unsupported", "compatibility.decoderUnavailable", null);
    }

    const started = Date.now();
    try {
      const args = hardware
        ? this.hardwareDecodeArgs(codec, decoder, hardware.backend, hardware.device, fixture)
        : this.softwareDecodeArgs(codec, decoder, fixture);
      const result = await this.run(args);
      const durationMs = Math.max(0, Date.now() - started);
      if (frameCount(result.stdout) < 1) return makeCheck(check, "failed", "compatibility.outputInvalid", durationMs);
      return makeCheck(check, "passed", "compatibility.passed", durationMs);
    } catch (error) {
      const failure = hardware ? hardwareFailureStatus(error) : { status: "failed" as const, detail: "compatibility.decodeFailed" };
      return makeCheck(check, failure.status, failure.detail, Math.max(0, Date.now() - started));
    }
  }

  private async runHardwareEncode(
    check: CheckDescriptor,
    codec: Codec,
    output: string,
    hardware: HardwareExecution,
    encoderListing: string,
    discoveryState: NvidiaDiscovery["state"] | VaapiDiscovery["state"] | "not-applicable"
  ): Promise<CompatibilityCheck> {
    const { backend, device } = hardware;
    const encoder = codec.hardwareEncoder[backend.id];
    if (!hasListedName(encoderListing, encoder)) return makeCheck(check, "unsupported", "compatibility.encoderUnavailable", null);
    if (backend.id === "videotoolbox" && this.platform !== "darwin") return makeCheck(check, "unavailable", "compatibility.hardwareUnavailable", null);
    if (backend.id === "nvenc" && discoveryState === "unknown") {
      return makeCheck(check, "unavailable", "compatibility.nvidiaDeviceEnumerationUnavailable", null);
    }
    if (backend.id === "nvenc" && discoveryState === "empty") return makeCheck(check, "unavailable", "compatibility.hardwareUnavailable", null);
    if (backend.id === "nvenc" && device.selector === null) {
      return makeCheck(check, "unavailable", "compatibility.nvidiaDeviceEnumerationUnavailable", null);
    }
    if (backend.id === "vaapi" && discoveryState === "unknown") {
      if (device.selector === null) return makeCheck(check, "unavailable", "compatibility.vaapiDeviceEnumerationUnavailable", null);
    }
    if (backend.id === "vaapi" && (discoveryState === "empty" || device.selector === null)) {
      return makeCheck(check, "unavailable", "compatibility.hardwareUnavailable", null);
    }
    return this.runEncode(check, codec, output, encoderListing, hardware);
  }

  private async runHardwareDecode(
    check: CheckDescriptor,
    codec: Codec,
    fixture: string,
    hardware: HardwareExecution,
    decoderListing: string,
    hwaccelListing: string,
    discoveryState: NvidiaDiscovery["state"] | VaapiDiscovery["state"] | "not-applicable"
  ): Promise<CompatibilityCheck> {
    const { backend, device } = hardware;
    const decoder = codec.hardwareDecoder[backend.id];
    if (!hasHardwareAcceleration(hwaccelListing, backend.hardwareAcceleration)) {
      return makeCheck(check, "unsupported", "compatibility.hardwareBackendUnavailable", null);
    }
    if (backend.id === "nvenc" && !hasListedName(decoderListing, decoder)) {
      return makeCheck(check, "unsupported", "compatibility.decoderUnavailable", null);
    }
    if (backend.id === "videotoolbox" && this.platform !== "darwin") return makeCheck(check, "unavailable", "compatibility.hardwareUnavailable", null);
    if (backend.id === "nvenc" && discoveryState === "unknown") {
      return makeCheck(check, "unavailable", "compatibility.nvidiaDeviceEnumerationUnavailable", null);
    }
    if (backend.id === "nvenc" && discoveryState === "empty") return makeCheck(check, "unavailable", "compatibility.hardwareUnavailable", null);
    if (backend.id === "nvenc" && device.selector === null) {
      return makeCheck(check, "unavailable", "compatibility.nvidiaDeviceEnumerationUnavailable", null);
    }
    if (backend.id === "vaapi" && discoveryState === "unknown") {
      if (device.selector === null) return makeCheck(check, "unavailable", "compatibility.vaapiDeviceEnumerationUnavailable", null);
    }
    if (backend.id === "vaapi" && (discoveryState === "empty" || device.selector === null)) {
      return makeCheck(check, "unavailable", "compatibility.hardwareUnavailable", null);
    }
    return this.runDecode(check, codec, fixture, decoderListing, hardware);
  }

  private softwareEncodeArgs(codec: Codec, encoder: string, output: string): string[] {
    return [
      ...COMMON_ARGS,
      "-f", "lavfi", "-i", TEST_SOURCE,
      "-frames:v", String(TEST_FRAMES),
      "-an",
      "-threads", "1",
      "-c:v", encoder,
      "-preset", "ultrafast",
      "-pix_fmt", codec.pixelFormat,
      ...(codec.id === "hevc-main10" ? ["-profile:v", "main10"] : ["-profile:v", "high"]),
      ...PROGRESS_ARGS,
      output
    ];
  }

  private hardwareEncodeArgs(codec: Codec, encoder: string, backend: HardwareBackend, device: HardwareDevice, output: string): string[] {
    const setup = backend.id === "vaapi"
      ? ["-init_hw_device", "vaapi=va:" + (device.selector ?? ""), "-filter_hw_device", "va"]
      : [];
    const formatFilter = backend.id === "vaapi" ? ["-vf", `format=${codec.vaapiPixelFormat},hwupload`] : [];
    const codecOptions = backend.id === "nvenc"
      ? ["-gpu", device.selector!, "-preset", "p4"]
      : backend.id === "vaapi"
        ? ["-rc_mode", "CQP", "-qp", codec.id === "h264" ? "25" : "27"]
        : ["-allow_sw", "0"];
    return [
      ...COMMON_ARGS,
      ...setup,
      "-f", "lavfi", "-i", TEST_SOURCE,
      "-frames:v", String(TEST_FRAMES),
      "-an",
      ...formatFilter,
      "-c:v", encoder,
      ...codecOptions,
      "-pix_fmt", backend.id === "vaapi" ? "vaapi" : codec.hardwarePixelFormat,
      ...(codec.id === "hevc-main10" ? ["-profile:v", "main10"] : ["-profile:v", "high"]),
      ...PROGRESS_ARGS,
      output
    ];
  }

  private softwareDecodeArgs(codec: Codec, decoder: string, fixture: string): string[] {
    return [
      ...COMMON_ARGS,
      "-c:v", decoder,
      "-i", fixture,
      "-map", "0:v:0",
      "-frames:v", String(TEST_FRAMES),
      "-threads", "1",
      ...PROGRESS_ARGS,
      "-f", "null", "-"
    ];
  }

  private hardwareDecodeArgs(codec: Codec, decoder: string, backend: HardwareBackend, device: HardwareDevice, fixture: string): string[] {
    const downloadedFormat = codec.id === "h264" ? "nv12" : "p010le";
    const setup = backend.id === "vaapi"
      ? ["-init_hw_device", "vaapi=va:" + device.selector!, "-hwaccel_device", "va", "-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi", "-c:v", decoder]
      : backend.id === "nvenc"
        ? ["-hwaccel", "cuda", "-hwaccel_device", device.selector!, "-hwaccel_output_format", "cuda", "-c:v", decoder, "-gpu", device.selector!]
        : ["-hwaccel", "videotoolbox", "-hwaccel_output_format", "videotoolbox_vld", "-c:v", decoder];
    return [
      ...COMMON_ARGS,
      ...setup,
      "-i", fixture,
      "-map", "0:v:0",
      "-frames:v", String(TEST_FRAMES),
      "-vf", `hwdownload,format=${downloadedFormat}`,
      ...PROGRESS_ARGS,
      "-f", "null", "-"
    ];
  }

  private run(args: string[]): Promise<RunResult> {
    return this.runner(this.ffmpegPath, args, { timeoutMs: PROCESS_TIMEOUT_MS, maxBufferBytes: MAX_PROCESS_OUTPUT_BYTES });
  }
}

async function runCommand(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  return execFileAsync(command, args, {
    timeout: options.timeoutMs,
    maxBuffer: options.maxBufferBytes,
    encoding: "utf8",
    killSignal: "SIGKILL",
    windowsHide: true
  });
}
