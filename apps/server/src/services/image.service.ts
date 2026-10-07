import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { ExifTool, type Tags } from "exiftool-vendored";
import { AppError } from "../lib/errors.js";

const execFileAsync = promisify(execFile);

const HEIF_EXTENSIONS = new Set(["heic", "heif", "hif", "heics", "heifs"]);
const RAW_EXTENSIONS = new Set(
  "3fr arw cr2 cr3 crw dcr dng erf fff iiq k25 kdc mef mos mrw nef nrw orf pef raf raw rw2 rwl sr2 srf srw x3f".split(" ")
);
/** A preview is for looking at: a 40-megapixel frame is scaled to fit this before it is sent. */
const MAX_EDGE = 4096;
const CONVERT_TIMEOUT_MS = 60_000;
/** Embedded previews, largest wins; a thumbnail is only used when a camera embedded nothing better. */
const PREVIEW_TAGS = ["JpgFromRaw", "PreviewImage", "OtherImage", "ThumbnailImage"] as const;

export type ImageMetadata = {
  camera?: string;
  lens?: string;
  /** Wall-clock time where the picture was taken, as the camera wrote it. */
  takenAt?: string;
  timeZone?: string;
  exposureTime?: string;
  aperture?: number;
  iso?: number;
  focalLength?: string;
  focalLength35?: string;
  exposureCompensation?: number;
  flash?: string;
  whiteBalance?: string;
  meteringMode?: string;
  exposureProgram?: string;
  width?: number;
  height?: number;
  colorSpace?: string;
  software?: string;
  gps?: { latitude: number; longitude: number; altitude?: number };
};

/** How a picture the browser cannot decode is turned into one it can; null for a file that needs no such help. */
export function renditionKind(name: string): "heif" | "raw" | null {
  const extension = path.extname(name).slice(1).toLowerCase();
  return HEIF_EXTENSIONS.has(extension) ? "heif" : RAW_EXTENSIONS.has(extension) ? "raw" : null;
}

/**
 * Pictures browsers cannot show (HEIF from phones and cameras, camera RAW) as JPEGs they can, and the
 * shooting data of any picture. Conversions are kept, keyed by the file as it was, so each is made once.
 */
export class ImageService {
  private readonly cacheDir: string;
  private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  private readonly pending = new Map<string, Promise<string>>();
  private exiftool: ExifTool | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(appDataDir: string) {
    this.cacheDir = path.join(appDataDir, "previews");
  }

  /** The path of a JPEG rendition of the file, converting it first unless that was done before. */
  async rendition(absolutePath: string, stat: fs.Stats): Promise<string> {
    const kind = renditionKind(absolutePath);
    if (!kind) throw new AppError(422, "This file needs no conversion", "IMAGE_NOT_CONVERTIBLE");
    const key = createHash("sha256").update(`${absolutePath}:${stat.mtimeMs}:${stat.size}`).digest("hex");
    const target = path.join(this.cacheDir, `${key}.jpg`);
    if (fs.existsSync(target)) return target;
    let job = this.pending.get(target);
    if (!job) {
      // One at a time: decoding a large frame takes every core for a moment, and a folder of them is opened in bursts.
      job = this.enqueue(async () => {
        await fsp.mkdir(this.cacheDir, { recursive: true });
        const partial = path.join(this.cacheDir, `${key}.partial.jpg`);
        try {
          await (kind === "heif" ? this.decodeHeif(absolutePath, partial) : this.extractRawPreview(absolutePath, partial));
          await fsp.rename(partial, target);
        } finally {
          await fsp.rm(partial, { force: true });
        }
        return target;
      }).finally(() => this.pending.delete(target));
      this.pending.set(target, job);
    }
    return job;
  }

  async metadata(absolutePath: string): Promise<ImageMetadata> {
    let tags: Tags;
    try {
      tags = await this.tool().read(absolutePath);
    } catch {
      throw new AppError(422, "The file has no readable metadata", "METADATA_UNREADABLE");
    }
    const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : typeof value === "number" ? String(value) : undefined);
    const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
    const make = text(tags.Make);
    const model = text(tags.Model);
    // "2026:06:19 15:51:10+09:00": the camera's own clock, which is the time the photographer remembers.
    const taken = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(rawValue(tags.DateTimeOriginal ?? tags.CreateDate) ?? "");
    const latitude = number(tags.GPSLatitude);
    const longitude = number(tags.GPSLongitude);
    const metadata: ImageMetadata = {
      // Makers disagree on whether the model repeats their name.
      camera: make && model && !model.toLowerCase().startsWith(make.split(" ")[0]!.toLowerCase()) ? `${make} ${model}` : model ?? make,
      lens: text(tags.LensModel) ?? text(tags.LensID) ?? text(tags.Lens),
      takenAt: taken ? `${taken[1]}-${taken[2]}-${taken[3]} ${taken[4]}` : undefined,
      timeZone: text(tags.OffsetTimeOriginal) ?? text(tags.OffsetTime),
      exposureTime: text(tags.ExposureTime),
      aperture: number(tags.FNumber) ?? number(tags.ApertureValue),
      iso: number(tags.ISO),
      focalLength: text(tags.FocalLength),
      focalLength35: text(tags.FocalLengthIn35mmFormat),
      exposureCompensation: number(tags.ExposureCompensation),
      flash: text(tags.Flash),
      whiteBalance: text(tags.WhiteBalance),
      meteringMode: text(tags.MeteringMode),
      exposureProgram: text(tags.ExposureProgram),
      width: number(tags.ImageWidth),
      height: number(tags.ImageHeight),
      colorSpace: text(tags.ColorSpace),
      software: text(tags.Software),
      gps: latitude !== undefined && longitude !== undefined && (latitude !== 0 || longitude !== 0) ? { latitude, longitude, altitude: number(tags.GPSAltitude) } : undefined
    };
    return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)) as ImageMetadata;
  }

  async stop(): Promise<void> {
    await this.exiftool?.end();
    this.exiftool = undefined;
  }

  /** exiftool is a long-lived child process, so it is only started by the first request that needs it. */
  private tool(): ExifTool {
    this.exiftool ??= new ExifTool({ maxProcs: 2, taskTimeoutMillis: 30_000 });
    return this.exiftool;
  }

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Whichever decoder the machine has: ffmpeg ships with the image, libheif and macOS's own are for development. */
  private async decodeHeif(source: string, target: string): Promise<void> {
    const scale = `scale=w='min(${MAX_EDGE},iw)':h='min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease[out]`;
    // A large picture is stored as a grid of tiles, which ffmpeg presents as a stream group; a small one is a single stream.
    const ffmpeg = (input: string): [string, string[]] => [this.ffmpeg, ["-v", "error", "-nostdin", "-y", "-i", source, "-filter_complex", `[${input}]${scale}`, "-map", "[out]", "-frames:v", "1", "-q:v", "3", target]];
    const decoders: Array<[string, string[]]> = [
      ffmpeg("0:g:0"),
      ffmpeg("0:v:0"),
      ["heif-dec", ["-q", "88", source, target]],
      ["heif-convert", ["-q", "88", source, target]],
      ...(process.platform === "darwin" ? [sips(source, target)] : [])
    ];
    for (const [command, args] of decoders) {
      await fsp.rm(target, { force: true });
      try {
        await execFileAsync(command, args, { timeout: CONVERT_TIMEOUT_MS });
        if ((await fsp.stat(target)).size > 0) return;
      } catch {
        // Not installed, or it could not read this file: the next one may.
      }
    }
    throw new AppError(422, "The image could not be decoded", "IMAGE_UNREADABLE");
  }

  /** Every RAW file carries a JPEG the camera rendered for its own screen; that is the preview, not a development of the sensor data. */
  private async extractRawPreview(source: string, target: string): Promise<void> {
    const tool = this.tool();
    try {
      const tags = await tool.read(source);
      const size = (tag: (typeof PREVIEW_TAGS)[number]) => (tags[tag] as { bytes?: number } | undefined)?.bytes ?? 0;
      const largest = [...PREVIEW_TAGS].sort((a, b) => size(b) - size(a))[0]!;
      if (size(largest) > 0) {
        await tool.extractBinaryTag(largest, source, target);
        // The embedded picture lies as the sensor did; the file says which way up it was held.
        const orientation = typeof tags.Orientation === "number" ? tags.Orientation : 1;
        if (orientation > 1 && (await tool.read(target)).Orientation === undefined) {
          await tool.write(target, { "Orientation#": orientation }, { writeArgs: ["-overwrite_original"] });
        }
        return;
      }
    } catch {
      // Fall through to a decoder that reads the sensor data itself.
    }
    if (process.platform === "darwin") {
      await fsp.rm(target, { force: true });
      const [command, args] = sips(source, target);
      const done = await execFileAsync(command, args, { timeout: CONVERT_TIMEOUT_MS }).then(() => fs.existsSync(target), () => false);
      if (done) return;
    }
    throw new AppError(422, "The RAW file has no embedded preview", "IMAGE_UNREADABLE");
  }
}

const sips = (source: string, target: string): [string, string[]] => ["sips", ["-Z", String(MAX_EDGE), "-s", "format", "jpeg", "-s", "formatOptions", "88", source, "--out", target]];

const rawValue = (value: unknown) => (typeof value === "string" ? value : typeof value === "object" && value !== null && "rawValue" in value ? String(value.rawValue) : undefined);
