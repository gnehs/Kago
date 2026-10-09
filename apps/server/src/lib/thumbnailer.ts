import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import type { ThumbnailJob, ThumbnailJobResult } from "../workers/thumbnail-worker.js";
import { guardedInput, guardedProbe, PICTURE_FORMATS } from "./ffmpeg-input.js";
import { pruneKeptFiles, useKeptFile } from "./kept-files.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/** Thumbnails fit inside a square of this many pixels unless a larger one is asked for; smaller pictures are not enlarged. */
const MAX_EDGE = 512;
const TIMEOUT_MS = 30_000;
/** A folder of pictures asks for all of its thumbnails at once; only this many are drawn at a time. */
const MAX_JOBS = 3;
/** Files that could not be drawn are remembered, so a folder full of them is not retried on every visit. */
const MAX_REMEMBERED_FAILURES = 2000;
/** What ffmpeg hands over is held whole in memory: a desktop background's worth of pixels, hardly packed, fits. */
const MAX_FRAME_BYTES = 256 * 1024 * 1024;

/**
 * A square cut out of a picture, in parts of the picture so it does not matter how large the copy being cut is:
 * `x` and `y` are its corner as parts of the width and height, `size` its side as a part of the shorter of the two.
 */
export type Crop = { x: number; y: number; size: number };

// Written out in full: a small number would otherwise be spelled with an exponent.
const part = (value: number) => value.toFixed(6);
// A square where none is named is the one in the middle, as large as the picture allows. One that reaches past an edge is moved back inside.
const cut = (square: true | Crop) =>
  square === true ? "crop='min(iw,ih)':'min(iw,ih)'," : `crop='max(2,min(iw,ih)*${part(square.size)})':'max(2,min(iw,ih)*${part(square.size)})':'iw*${part(square.x)}':'ih*${part(square.y)}',`;

// Where ffmpeg does the reading, it cuts the picture, scales it down and hands it over as a PNG, with whatever is transparent in it.
const filter = (edge: number, square: boolean | Crop = false) => `[0:v:0]${square ? cut(square) : ""}scale='min(${edge},iw)':'min(${edge},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2[out]`;
// Barely packed: it is read back at once, and packing it well would take longer than writing the AVIF.
const AS_PNG = ["-map", "[out]", "-frames:v", "1", "-c:v", "png", "-compression_level", "1", "-f", "image2pipe", "pipe:1"];
/** How sharp writes an AVIF: the effort is the least that still comes out smaller than the encoders ffmpeg has, in about the time they took. */
const AVIF = { quality: 50, effort: 2 } as const;

type Sharp = (typeof import("sharp"))["default"];

/**
 * The kinds of picture sharp reads by itself, which takes about half as long as having ffmpeg read them first: the
 * ones every browser shows, whose decoders are the most worn in. They are told by how the file begins, not by its
 * name, so that nothing else is opened as one: sharp would draw an SVG, and an SVG can name other files to draw.
 */
const SHARP_READS: Array<(head: Buffer) => boolean> = [
  (head) => head.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  (head) => head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  (head) => ["GIF87a", "GIF89a"].includes(head.toString("latin1", 0, 6)),
  (head) => head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP"
];

/** Whether a file on this machine's disk begins the way one of those does. A remote location's file is an address, and is left to ffmpeg. */
async function sharpReads(file: string): Promise<boolean> {
  if (!path.isAbsolute(file)) return false;
  const handle = await fsp.open(file, "r").catch(() => null);
  if (!handle) return false;
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(12), 0, 12, 0);
    return SHARP_READS.some((begins) => begins(buffer.subarray(0, bytesRead)));
  } finally {
    await handle.close();
  }
}

/**
 * How a file becomes a picture: images and videos are read by ffmpeg directly; the first page of a PDF is drawn first,
 * and a document's own preview picture is taken out of it, both off the main thread.
 */
export type ThumbnailSource = "image" | "video" | "pdf" | "embedded";

/**
 * Draws AVIF thumbnails, keeping each one on disk under the key it was asked for. sharp writes them all, and reads
 * the common kinds of picture itself; ffmpeg reads the rest, videos among them, and hands sharp what it made of them.
 */
export class Thumbnailer {
  private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  private readonly ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  private writer?: Promise<Sharp | null>;
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly failed = new Set<string>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private worker: Worker | null = null;
  private readonly jobs = new Map<number, (ok: boolean) => void>();
  private nextJob = 0;

  constructor(private readonly dir: string) {}

  /**
   * The path of the thumbnail for `key`, drawing it first when it is not there yet. Null when the file cannot be drawn.
   * One of another `edge` is another picture, and is kept under a key of its own.
   */
  async render(source: string, key: string, kind: ThumbnailSource, edge = MAX_EDGE): Promise<string | null> {
    const target = path.join(this.dir, `${key}.avif`);
    if (await useKeptFile(target)) return target;
    if (this.failed.has(key)) return null;
    let job = this.pending.get(key);
    if (!job) {
      job = this.draw(source, target, kind, edge).finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    const result = await job;
    if (!result) {
      if (this.failed.size >= MAX_REMEMBERED_FAILURES) this.failed.clear();
      this.failed.add(key);
    }
    return result;
  }

  private async draw(source: string, target: string, kind: ThumbnailSource, edge: number): Promise<string | null> {
    const sharp = await (this.writer ??= this.findWriter());
    if (!sharp) return null;
    // An SVG is a document that may name other files to draw; the browser shows it as it is instead.
    if (kind === "image" && /\.svgz?$/i.test(source)) return null;
    // A video is read as a video and everything else as a still picture, whatever the file turns out to hold.
    const formats = kind === "video" ? undefined : PICTURE_FORMATS;
    await this.acquire();
    const partial = `${target}.partial`;
    const prepared = `${target}.source`;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      let picture = source;
      if (kind === "pdf" || kind === "embedded") {
        if (!(await this.prepare({ kind, source, target: prepared, edge }))) return null;
        picture = prepared;
      }
      // A tenth of the way in is past most title cards; the very first frame is tried when nothing is there.
      const seeks = kind === "video" ? [(await this.duration(source)) * 0.1, 0].filter((seek, index) => index > 0 || seek > 0) : [null];
      let reason = "no frame to draw";
      if (kind !== "video" && (await sharpReads(picture))) {
        try {
          // Turned the way the camera was held, which ffmpeg does by itself.
          await this.write(sharp(picture).rotate().resize(edge, edge, { fit: "inside", withoutEnlargement: true }), partial);
          await fsp.rename(partial, target);
          return target;
        } catch {
          // A file cut short, or one that only begins like a picture: ffmpeg makes more of those.
        }
      }
      for (const seek of seeks) {
        // Past the start only keyframes are decoded: landing between two would mean decoding every frame up to that point,
        // which for 4K HEVC with keyframes ten seconds apart outlasts the timeout on a slow machine.
        const input = seek === null ? guardedInput(picture, formats) : [...(seek > 0 ? ["-skip_frame", "nokey"] : []), "-ss", seek.toFixed(2), ...guardedInput(picture, formats), "-an", "-sn", "-dn"];
        try {
          const frame = await this.read(input, edge);
          // With no frame after the seek, ffmpeg still succeeds and hands over nothing.
          if (!frame) continue;
          await this.write(sharp(frame), partial);
          await fsp.rename(partial, target);
          return target;
        } catch (error) {
          // Tried again from the start of the video, or given up on below.
          reason = failureOf(error);
        }
      }
      logger.warn(`no thumbnail for ${source}`, reason);
      return null;
    } finally {
      await Promise.all([fsp.rm(partial, { force: true }), fsp.rm(prepared, { force: true })]);
      this.release();
    }
  }

  /** What ffmpeg makes of a picture: cut, scaled down to `edge`, and handed over as a PNG. Null when there was no frame to read. */
  private async read(input: string[], edge: number, square: boolean | Crop = false): Promise<Buffer | null> {
    const { stdout } = await execFileAsync(this.ffmpeg, ["-v", "warning", "-nostdin", ...input, "-filter_complex", filter(edge, square), ...AS_PNG], { timeout: TIMEOUT_MS, encoding: "buffer", maxBuffer: MAX_FRAME_BYTES });
    return stdout.length > 0 ? stdout : null;
  }

  /** Writes a picture as an AVIF. What is transparent in it stays so, unless it is to be `opaque`: then it is laid on white. */
  private async write(picture: import("sharp").Sharp, target: string, opaque = false): Promise<void> {
    await (opaque ? picture.flatten({ background: "#ffffff" }) : picture).timeout({ seconds: TIMEOUT_MS / 1000 }).avif(AVIF).toFile(target);
  }

  /** Deletes the thumbnails nobody looked at for a month: those of files since changed, moved or deleted, mostly. */
  prune(): Promise<number> {
    return pruneKeptFiles(this.dir);
  }

  /**
   * Writes a picture to `target` as an AVIF no longer than `edge` on its longer side, replacing what was there;
   * `square` cuts it to a square first, the one named or the one in its middle. It is a picture Kago shows over
   * whatever is behind it, so what is transparent in it is laid on white. False when it cannot be done: nothing to
   * draw with, or a file ffmpeg does not read as a picture.
   */
  async convert(source: string, target: string, edge: number, square: boolean | Crop = false): Promise<boolean> {
    const sharp = await (this.writer ??= this.findWriter());
    if (!sharp || /\.svgz?$/i.test(source)) return false;
    await this.acquire();
    // Two conversions for one target may overlap; each writes a file of its own and the later rename wins.
    const partial = `${target}.${process.hrtime.bigint()}.partial`;
    try {
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const frame = await this.read(guardedInput(source, PICTURE_FORMATS), edge, square);
      if (!frame) return false;
      await this.write(sharp(frame), partial, true);
      await fsp.rename(partial, target);
      return true;
    } catch (error) {
      logger.warn(`could not convert ${source}`, failureOf(error));
      return false;
    } finally {
      await fsp.rm(partial, { force: true });
      this.release();
    }
  }

  /** Hands a job to the worker thread, which is started on first use and replaced when it dies or stops answering. */
  private prepare(job: Omit<ThumbnailJob, "id">): Promise<boolean> {
    const worker = (this.worker ??= this.startWorker());
    const id = (this.nextJob += 1);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => void worker.terminate(), TIMEOUT_MS);
      this.jobs.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      worker.postMessage({ id, ...job } satisfies ThumbnailJob);
    });
  }

  private startWorker(): Worker {
    const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "../workers/thumbnail-worker.ts" : "../workers/thumbnail-worker.js", import.meta.url), {
      name: "kago-thumbnail-worker",
      // What it reads is someone's file, whole: one written to exhaust memory takes the worker with it and not the server.
      resourceLimits: { maxOldGenerationSizeMb: 512 }
    });
    // Idle between folders; it must not keep the server from shutting down.
    worker.unref();
    worker.on("message", (result: ThumbnailJobResult) => {
      this.jobs.get(result.id)?.(result.ok);
      this.jobs.delete(result.id);
    });
    worker.on("error", (error) => logger.warn("thumbnail worker failed", error.message));
    worker.once("exit", () => {
      if (this.worker === worker) this.worker = null;
      for (const settle of this.jobs.values()) settle(false);
      this.jobs.clear();
    });
    return worker;
  }

  private async duration(source: string): Promise<number> {
    try {
      const { stdout } = await execFileAsync(this.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", ...guardedProbe(source)], { timeout: TIMEOUT_MS });
      const seconds = Number.parseFloat(stdout);
      return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    } catch {
      return 0;
    }
  }

  /** What pictures are written with, found out once: null where there is no ffmpeg to read what sharp does not, or no sharp built for this machine. */
  private async findWriter(): Promise<Sharp | null> {
    try {
      await execFileAsync(this.ffmpeg, ["-version"]);
    } catch {
      logger.warn("ffmpeg not found; thumbnails are disabled");
      return null;
    }
    try {
      // It carries a library built for one kind of machine, so it is only loaded once a picture needs writing.
      const sharp = (await import("sharp")).default;
      // It would remember a file by its name, and answer for one changed since with what it was before.
      sharp.cache(false);
      return sharp;
    } catch (error) {
      logger.warn("sharp could not be loaded; thumbnails are disabled", (error as Error).message);
      return null;
    }
  }

  private async acquire(): Promise<void> {
    if (this.running >= MAX_JOBS) await new Promise<void>((resolve) => this.waiting.push(resolve));
    else this.running += 1;
  }

  /** A waiting job takes the slot over directly, so the count only drops when nobody is waiting. */
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running -= 1;
  }
}

/** Why a picture could not be drawn, in a line: ffmpeg's last word, or sharp's. */
function failureOf(error: unknown): string {
  const failure = error as { killed?: boolean; stderr?: Buffer | string; message: string };
  return failure.killed ? `timed out after ${TIMEOUT_MS / 1000}s` : String(failure.stderr ?? "").trim().split("\n").at(-1) || failure.message;
}
