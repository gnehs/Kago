import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { availableParallelism, loadavg } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { AppError } from "./errors.js";
import { guardedInput, guardedProbe } from "./ffmpeg-input.js";
import { pruneKeptFiles, useKeptFile } from "./kept-files.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * The small pictures shown over a video's timeline: one every `interval` seconds, laid out in sheets of
 * `columns` by `rows`, each `width` by `height`. Picture `n` is in sheet `n / (columns * rows)`.
 */
export type Storyboard = { interval: number; count: number; width: number; height: number; columns: number; rows: number; sheets: number };

export type StoryboardState = ({ status: "ready" } & Storyboard) | { status: "pending" | "unavailable" };

type FileVersion = { size: number; mtimeMs: number };
type Source = { duration: number; /** What turns an HDR picture into SDR, or nothing for a picture that is SDR. */ tonemap: string | null };
type Request = Source & { key: string; input: string };
type Job = Request & { proc: ChildProcess; dir: string; paused: boolean; ranMs: number; since: number; /** Stopped along with the server; it is simply made another time. */ abandoned: boolean };

const COLUMNS = 10;
const ROWS = 10;
/** The box each picture is fitted into: half again what is shown, so it holds up on a dense screen. */
const BOX_WIDTH = 240;
const BOX_HEIGHT = 135;
/** Seconds between pictures; the first that keeps a video under `MAX_PICTURES` is taken. */
const INTERVALS = [1, 2, 5, 10, 15, 20, 30, 60, 120, 300];
const MAX_PICTURES = 600;
/** A video shorter than this is found one's way around without pictures. */
const MIN_DURATION = 5;
const QUEUE_LIMIT = 20;
/** How long ffmpeg may work on one video, not counting the time it is held back. */
const MAX_RUN_MS = 20 * 60_000;
const FAILURES_KEPT = 500;

/** Processor cores nothing is asking for. Windows has no load average, which is not evidence of any. */
const idleCores = () => (process.platform === "win32" ? 0 : availableParallelism() - (loadavg()[0] ?? Number.POSITIVE_INFINITY));

/**
 * Makes storyboards one at a time, and only while the server has nothing better to do: ffmpeg is held back
 * whenever a video is being encoded for someone watching, and let go on when that is over.
 */
export class Storyboards {
  /** Videos waiting their turn; the one asked about last is the one somebody is watching, and goes first. */
  private readonly queue = new Map<string, Request>();
  private readonly failed = new Set<string>();
  private job: Job | null = null;

  constructor(private readonly ffmpeg: string, private readonly ffprobe: string, private readonly dir: string, private readonly tempDir: string) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }

  /** The storyboard of a video if it has been made; otherwise it is put in line to be. */
  async request(input: string, stat: FileVersion, source: Source | null): Promise<StoryboardState> {
    // Every picture of a remote file would be a read of the whole of it from wherever it is kept.
    if (!source || source.duration < MIN_DURATION || /^https?:/.test(input)) return { status: "unavailable" };
    const key = keyOf(input, stat);
    const made = await this.read(key);
    if (made) return { status: "ready", ...made };
    if (this.failed.has(key)) return { status: "unavailable" };
    if (this.job?.key !== key) {
      this.queue.delete(key);
      this.queue.set(key, { key, input, ...source });
      if (this.queue.size > QUEUE_LIMIT) this.queue.delete(this.queue.keys().next().value!);
    }
    return { status: "pending" };
  }

  async sheet(input: string, stat: FileVersion, index: number): Promise<string> {
    const file = this.sheetPath(keyOf(input, stat), index);
    if (!(await useKeptFile(file))) throw new AppError(404, "Preview not found", "NOT_FOUND");
    return file;
  }

  /** Called every second and whenever an encoder starts: `encoding` is whether one runs for someone watching. */
  pump(encoding: boolean): void {
    const job = this.job;
    if (!job) {
      if (!encoding && this.queue.size > 0 && idleCores() > 1) this.start();
      return;
    }
    const now = Date.now();
    if (!job.paused) {
      job.ranMs += now - job.since;
      job.since = now;
      if (job.ranMs > MAX_RUN_MS) job.proc.kill("SIGKILL");
      // Its own work is part of the load, so it is held back only once there is less than nothing to spare.
      else if (encoding || idleCores() < 0) {
        job.proc.kill("SIGSTOP");
        job.paused = true;
      }
    } else if (!encoding && idleCores() > 1) {
      job.proc.kill("SIGCONT");
      job.paused = false;
      job.since = now;
    }
  }

  prune(): Promise<number> {
    return pruneKeptFiles(this.dir);
  }

  stop(): void {
    this.queue.clear();
    if (this.job) this.job.abandoned = true;
    this.job?.proc.kill("SIGKILL");
  }

  private sheetPath(key: string, index: number): string {
    return path.join(this.dir, `${key}-${index}.jpg`);
  }

  private async read(key: string): Promise<Storyboard | null> {
    const file = path.join(this.dir, `${key}.json`);
    if (!(await useKeptFile(file))) return null;
    try {
      const board = JSON.parse(await fsp.readFile(file, "utf8")) as Storyboard;
      // The sheets are marked as used along with it, so none of them is cleared away before the rest.
      const kept = await Promise.all(Array.from({ length: board.sheets }, (_, index) => useKeptFile(this.sheetPath(key, index))));
      return kept.every(Boolean) ? board : null;
    } catch {
      return null;
    }
  }

  private start(): void {
    const request = [...this.queue.values()].at(-1)!;
    this.queue.delete(request.key);
    const interval = INTERVALS.find((seconds) => request.duration / seconds <= MAX_PICTURES) ?? INTERVALS.at(-1)!;
    const dir = path.join(this.tempDir, request.key);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const size = (limit: string) => `2*trunc(min(${limit})/2)`;
    const filters = [
      `fps=1/${interval}`,
      // Sized by the shape the picture is shown in, which for a film stored with oblong pixels is not that of its frames.
      `scale=w='max(2,${size(`${BOX_WIDTH},${BOX_HEIGHT}*dar`)})':h='max(2,${size(`${BOX_HEIGHT},${BOX_WIDTH}/dar`)})'`,
      "setsar=1",
      ...(request.tonemap ? [request.tonemap] : [])
    ];
    const proc = spawn(
      this.ffmpeg,
      [
        "-nostdin", "-hide_banner", "-loglevel", "error",
        // Only the frames that stand on their own are decoded: a picture every few seconds needs no more, and a film is gone through in minutes.
        "-threads", "2", "-skip_frame", "nokey",
        ...guardedInput(request.input),
        // The pictures go two ways: into the sheets, and nowhere at all, which is what has them counted.
        "-filter_complex", `[0:V:0]${filters.join(",")},split[counted][laid];[laid]tile=${COLUMNS}x${ROWS}[sheets]`,
        "-map", "[counted]", "-fps_mode", "passthrough", "-f", "null", "-",
        "-map", "[sheets]", "-fps_mode", "passthrough", "-q:v", "5", "-f", "image2", "-start_number", "0",
        path.join(dir, "%d.jpg"),
        "-progress", "pipe:1"
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    const job: Job = { ...request, proc, dir, paused: false, ranMs: 0, since: Date.now(), abandoned: false };
    this.job = job;
    let stderr = "";
    let count = 0;
    proc.stdout.on("data", (chunk: Buffer) => {
      for (const [, frames] of chunk.toString().matchAll(/^frame=\s*(\d+)/gm)) count = Number(frames);
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    proc.on("error", () => {});
    proc.on("close", (code) => {
      void (code === 0 ? this.keep(job, interval, count) : Promise.reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`)))
        .catch((error) => {
          if (job.abandoned) return;
          if (this.failed.size >= FAILURES_KEPT) this.failed.delete(this.failed.values().next().value!);
          this.failed.add(job.key);
          logger.warn("could not make the timeline pictures of a video", String(error));
        })
        .finally(() => {
          if (this.job === job) this.job = null;
          fs.rm(dir, { recursive: true, force: true }, () => {});
        });
    });
  }

  /** Moves the finished sheets to where they are kept; the description is written last, and is what says they are all there. */
  private async keep(job: Job, interval: number, made: number): Promise<void> {
    const sheets = (await fsp.readdir(job.dir)).filter((name) => /^\d+\.jpg$/.test(name)).length;
    if (sheets === 0) throw new Error("ffmpeg made no pictures");
    const probed = await execFileAsync(
      this.ffprobe,
      ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-print_format", "json", ...guardedProbe(path.join(job.dir, "0.jpg"), ["image2", "jpeg_pipe"])],
      { timeout: 20_000 }
    );
    const sheet = (JSON.parse(probed.stdout) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0];
    const width = Math.floor(Number(sheet?.width) / COLUMNS);
    const height = Math.floor(Number(sheet?.height) / ROWS);
    if (!(width > 0 && height > 0)) throw new Error("the pictures have no size");
    const perSheet = COLUMNS * ROWS;
    // The last sheet is filled out with black, which is not to be taken for the end of the video.
    const count = Math.min(sheets * perSheet, Math.max((sheets - 1) * perSheet + 1, made));
    for (let index = 0; index < sheets; index += 1) await fsp.rename(path.join(job.dir, `${index}.jpg`), this.sheetPath(job.key, index));
    const board: Storyboard = { interval, count, width, height, columns: COLUMNS, rows: ROWS, sheets };
    const file = path.join(this.dir, `${job.key}.json`);
    await fsp.writeFile(`${file}.part`, JSON.stringify(board));
    await fsp.rename(`${file}.part`, file);
  }
}

const keyOf = (input: string, stat: FileVersion) => createHash("sha1").update(`${input}:${stat.mtimeMs}:${stat.size}`).digest("hex");
