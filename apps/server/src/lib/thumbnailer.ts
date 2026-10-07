import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Worker } from "node:worker_threads";
import type { ThumbnailJob, ThumbnailJobResult } from "../workers/thumbnail-worker.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/** Thumbnails fit inside a square of this many pixels; smaller pictures are not enlarged. */
const MAX_EDGE = 512;
const TIMEOUT_MS = 30_000;
/** A folder of pictures asks for all of its thumbnails at once; only this many are drawn at a time. */
const MAX_JOBS = 3;
/** Files that could not be drawn are remembered, so a folder full of them is not retried on every visit. */
const MAX_REMEMBERED_FAILURES = 2000;

// AVIF has no place for transparency with the encoders at hand, so pictures are laid on white first.
const FILTER = [
  `[0:v:0]scale='min(${MAX_EDGE},iw)':'min(${MAX_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=rgba,split[picture][sheet]`,
  "[sheet]drawbox=c=white:t=fill:replace=1[white]",
  "[white][picture]overlay,format=yuv420p[out]"
].join(";");

const ENCODERS: Record<string, string[]> = {
  libsvtav1: ["-c:v", "libsvtav1", "-crf", "32", "-preset", "8"],
  "libaom-av1": ["-c:v", "libaom-av1", "-crf", "32", "-cpu-used", "8", "-still-picture", "1"]
};

/**
 * How a file becomes a picture: images and videos are read by ffmpeg directly; the first page of a PDF is drawn first,
 * and a document's own preview picture is taken out of it, both off the main thread.
 */
export type ThumbnailSource = "image" | "video" | "pdf" | "embedded";

/** Draws AVIF thumbnails with ffmpeg, keeping each one on disk under the key it was asked for. */
export class Thumbnailer {
  private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  private readonly ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  private encoder?: Promise<string[] | null>;
  private readonly pending = new Map<string, Promise<string | null>>();
  private readonly failed = new Set<string>();
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  private worker: Worker | null = null;
  private readonly jobs = new Map<number, (ok: boolean) => void>();
  private nextJob = 0;

  constructor(private readonly dir: string) {}

  /** The path of the thumbnail for `key`, drawing it first when it is not there yet. Null when the file cannot be drawn. */
  async render(source: string, key: string, kind: ThumbnailSource): Promise<string | null> {
    const target = path.join(this.dir, `${key}.avif`);
    if (await exists(target)) return target;
    if (this.failed.has(key)) return null;
    let job = this.pending.get(key);
    if (!job) {
      job = this.draw(source, target, kind).finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    const result = await job;
    if (!result) {
      if (this.failed.size >= MAX_REMEMBERED_FAILURES) this.failed.clear();
      this.failed.add(key);
    }
    return result;
  }

  private async draw(source: string, target: string, kind: ThumbnailSource): Promise<string | null> {
    const encoder = await (this.encoder ??= this.findEncoder());
    if (!encoder) return null;
    await this.acquire();
    const partial = `${target}.partial`;
    const prepared = `${target}.source`;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      let picture = source;
      if (kind === "pdf" || kind === "embedded") {
        if (!(await this.prepare({ kind, source, target: prepared, edge: MAX_EDGE }))) return null;
        picture = prepared;
      }
      // A tenth of the way in is past most title cards; the very first frame is tried when nothing is there.
      const seeks = kind === "video" ? [(await this.duration(source)) * 0.1, 0].filter((seek, index) => index > 0 || seek > 0) : [null];
      for (const seek of seeks) {
        const input = seek === null ? ["-i", picture] : ["-ss", seek.toFixed(2), "-i", picture, "-an", "-sn", "-dn"];
        try {
          await execFileAsync(this.ffmpeg, ["-v", "error", "-nostdin", "-y", ...input, "-filter_complex", FILTER, "-map", "[out]", "-frames:v", "1", ...encoder, "-f", "avif", partial], { timeout: TIMEOUT_MS });
          if ((await fsp.stat(partial)).size === 0) continue;
          await fsp.rename(partial, target);
          return target;
        } catch {
          // Tried again from the start of the video, or given up on below.
        }
      }
      return null;
    } finally {
      await Promise.all([fsp.rm(partial, { force: true }), fsp.rm(prepared, { force: true })]);
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
    const worker = new Worker(new URL(import.meta.url.endsWith(".ts") ? "../workers/thumbnail-worker.ts" : "../workers/thumbnail-worker.js", import.meta.url), { name: "kago-thumbnail-worker" });
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
      const { stdout } = await execFileAsync(this.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", source], { timeout: TIMEOUT_MS });
      const seconds = Number.parseFloat(stdout);
      return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    } catch {
      return 0;
    }
  }

  private async findEncoder(): Promise<string[] | null> {
    try {
      const { stdout } = await execFileAsync(this.ffmpeg, ["-hide_banner", "-encoders"]);
      const name = Object.keys(ENCODERS).find((encoder) => stdout.includes(` ${encoder} `));
      if (name) return ENCODERS[name]!;
      logger.warn("ffmpeg has no AV1 encoder; thumbnails are disabled");
    } catch {
      logger.warn("ffmpeg not found; thumbnails are disabled");
    }
    return null;
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

const exists = (file: string) =>
  fsp.stat(file).then(
    (stat) => stat.size > 0,
    () => false
  );
