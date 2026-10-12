import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export type HardwareCodec = "h264" | "hevc" | "av1";
type Device = "nvenc" | "vaapi" | "videotoolbox";

/**
 * A GPU that conversions can be handed to. Decoding is offloaded where it can be, but frames come back to system
 * memory for the filters, so a source the GPU cannot decode quietly falls back to the CPU.
 */
export type ConvertAccel = {
  device: Device;
  /** What goes before the input. */
  input: string[];
  /** The codecs it encodes, each proven by a test encode. */
  codecs: HardwareCodec[];
};

const DEFAULT_QUALITY: Record<HardwareCodec, number> = { h264: 23, hevc: 26, av1: 32 };

/**
 * How a codec is encoded on the device: what ends the filter chain, and what takes the place of the software
 * encoder. `crf` is on the scale of that codec's software encoder, and is turned into the nearest the device has.
 */
export function hardwareEncoder(accel: ConvertAccel, codec: HardwareCodec, crf: number | null, tenBit: boolean, format: string): { filter: string[]; args: string[] } {
  const quality = crf ?? DEFAULT_QUALITY[codec];
  // H.264 on a GPU is eight bits; the others keep ten where the picture has them.
  const deep = tenBit && codec !== "h264";
  const tag = codec === "hevc" && (format === "mp4" || format === "mov") ? ["-tag:v", "hvc1"] : [];
  switch (accel.device) {
    case "nvenc":
      return {
        filter: [],
        args: ["-c:v", `${codec}_nvenc`, "-preset", "p5", "-rc", "vbr", "-cq", String(Math.min(quality, 51)), "-b:v", "0", "-pix_fmt", deep ? "p010le" : "yuv420p", ...(deep && codec === "hevc" ? ["-profile:v", "main10"] : []), ...tag]
      };
    case "vaapi":
      return {
        filter: [`format=${deep ? "p010" : "nv12"}`, "hwupload"],
        // Constant QP is the one rate control every driver has. AV1 counts it on a scale four times as long.
        args: ["-c:v", `${codec}_vaapi`, "-rc_mode", "CQP", "-qp", String(codec === "av1" ? Math.min(quality * 4, 255) : Math.min(quality, 51)), ...(deep && codec === "hevc" ? ["-profile:v", "main10"] : []), ...tag]
      };
    case "videotoolbox":
      return {
        filter: [],
        // VideoToolbox counts quality upwards to 100, where the others count loss upwards from 0.
        args: ["-c:v", `${codec}_videotoolbox`, "-q:v", String(Math.max(1, Math.min(100, Math.round(100 - quality * 1.6)))), "-pix_fmt", deep ? "p010le" : "yuv420p", ...(deep ? ["-profile:v", "main10"] : []), ...tag]
      };
  }
}

function candidate(device: Device, node = ""): ConvertAccel {
  const input = device === "nvenc" ? ["-hwaccel", "cuda"] : device === "vaapi" ? ["-init_hw_device", `vaapi=va:${node}`, "-hwaccel", "vaapi", "-hwaccel_device", "va", "-filter_hw_device", "va"] : ["-hwaccel", "videotoolbox"];
  return { device, input, codecs: [] };
}

/**
 * The first GPU that survives a real test encode, with the codecs it managed, so one that is present but unusable
 * is skipped. `TRANSCODE_HWACCEL` picks the kind, or `none` to do without, as it does for playback.
 */
export async function detectConvertAccel(ffmpeg: string): Promise<ConvertAccel | null> {
  const wanted = (process.env.TRANSCODE_HWACCEL ?? "auto").toLowerCase();
  if (wanted === "none" || wanted === "software") return null;
  const nodes = process.env.TRANSCODE_VAAPI_DEVICE
    ? [process.env.TRANSCODE_VAAPI_DEVICE]
    : await fsp.readdir("/dev/dri").then((names) => names.filter((name) => name.startsWith("renderD")).sort().map((name) => `/dev/dri/${name}`), () => []);
  const candidates = [candidate("nvenc"), ...nodes.map((node) => candidate("vaapi", node)), candidate("videotoolbox")].filter((item) => wanted === "auto" || item.device.startsWith(wanted));
  for (const accel of candidates) {
    for (const codec of ["h264", "hevc", "av1"] as const) {
      const { filter, args } = hardwareEncoder(accel, codec, null, false, "mkv");
      try {
        await execFileAsync(
          ffmpeg,
          ["-nostdin", "-hide_banner", "-loglevel", "error", ...accel.input, "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30", "-frames:v", "30", "-vf", ["scale=640:360", ...filter].join(","), ...args, "-f", "null", "-"],
          { timeout: 20_000 }
        );
        accel.codecs.push(codec);
      } catch {
        // Not something this device does.
      }
    }
    if (accel.codecs.length > 0) {
      logger.info(`conversions use ${accel.device} for ${accel.codecs.join(", ")}`);
      return accel;
    }
  }
  return null;
}
