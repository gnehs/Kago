import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { id as createId } from "../lib/ids.js";
import { logger } from "../lib/logger.js";

const execFileAsync = promisify(execFile);

export const mediaSessionSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  height: z.number().int().min(144).max(4320),
  audioIndex: z.number().int().min(0).max(63).default(0)
});

export type MediaInfo = {
  /** False when ffmpeg is missing; the client then falls back to playing the file as-is. */
  transcode: boolean;
  duration: number;
  /** ffprobe's format name list, e.g. `mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`. */
  container: string;
  video: { codec: string; profile: string; width: number; height: number; bitDepth: number } | null;
  audio: Array<{ codec: string; channels: number; language: string; title: string }>;
  /** Heights the file can be transcoded to, tallest first. */
  qualities: number[];
  /** What does the encoding: `software`, or the GPU API in use. */
  encoder: Encoder;
};

type Encoder = "software" | "nvenc" | "vaapi" | "vaapi-cqp" | "videotoolbox";

/** How one encoder is driven: what goes before the input, after the scaler, and in place of libx264. */
type Accel = {
  encoder: Encoder;
  input: string[];
  filter: string;
  codec: (maxKbps: number) => string[];
};

type Session = {
  id: string;
  actorId: string;
  input: string;
  dir: string;
  info: MediaInfo;
  height: number;
  audioIndex: number;
  segmentCount: number;
  proc: ChildProcess | null;
  /** Set once the GPU pipeline has failed on this file; the rest of the session encodes on the CPU. */
  software: boolean;
  /** Bumped on every ffmpeg (re)start so waiters from an abandoned run give up. */
  run: number;
  runStart: number;
  /** The segment the current run is writing; everything from `runStart` up to it is complete. */
  head: number;
  paused: boolean;
  lastRequested: number;
  pruned: number;
  lastAccess: number;
};

const SEGMENT_SECONDS = 6;
const LADDER = [2160, 1440, 1080, 720, 480, 360];
const MAX_KBPS: Record<number, number> = { 2160: 16000, 1440: 10000, 1080: 6000, 720: 3000, 480: 1500, 360: 800 };
const SESSIONS_PER_ACTOR = 3;
/** ffmpeg stops when nobody has asked for a segment this long; the session itself outlives it so a paused player can resume. */
const IDLE_KILL_MS = 60_000;
const SESSION_TTL_MS = 15 * 60_000;
/** ffmpeg is suspended once it is this many segments ahead of the player, and resumed when the lead halves. */
const THROTTLE_AHEAD = 20;
const KEEP_BEHIND = 10;
const SEGMENT_WAIT_MS = 55_000;

/**
 * On-the-fly video transcoding, modelled on Jellyfin: the playlist is computed up front from the
 * duration, and ffmpeg is started (or restarted at another offset) lazily as segments are requested.
 */
export class MediaService {
  private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  private readonly ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  private readonly baseDir: string;
  private readonly available: Promise<boolean>;
  private accel: Accel = accelFor("software");
  private readonly sessions = new Map<string, Session>();
  private readonly probes = new Map<string, Omit<MediaInfo, "transcode" | "encoder">>();
  private readonly ticker: NodeJS.Timeout;

  constructor(appDataDir: string) {
    this.baseDir = path.join(appDataDir, "temp", "transcode");
    fs.rmSync(this.baseDir, { recursive: true, force: true });
    this.available = Promise.all([execFileAsync(this.ffmpeg, ["-version"]), execFileAsync(this.ffprobe, ["-version"])]).then(
      async () => {
        this.accel = await this.detectAccel();
        logger.info(`video transcoding uses ${this.accel.encoder}`);
        return true;
      },
      () => {
        logger.warn("ffmpeg/ffprobe not found; video transcoding is disabled");
        return false;
      }
    );
    this.ticker = setInterval(() => this.tick(), 1000);
    this.ticker.unref();
  }

  async info(absolutePath: string, stat: fs.Stats): Promise<MediaInfo> {
    if (!(await this.available)) return { transcode: false, duration: 0, container: "", video: null, audio: [], qualities: [], encoder: "software" };
    const key = `${absolutePath}:${stat.mtimeMs}:${stat.size}`;
    let probed = this.probes.get(key);
    if (!probed) {
      probed = await this.probe(absolutePath);
      if (this.probes.size >= 200) this.probes.delete(this.probes.keys().next().value!);
      this.probes.set(key, probed);
    }
    return { transcode: probed.qualities.length > 0, encoder: this.accel.encoder, ...probed };
  }

  async createSession(actorId: string, absolutePath: string, stat: fs.Stats, height: number, audioIndex: number) {
    const info = await this.info(absolutePath, stat);
    if (!info.transcode) throw new AppError(422, "This file cannot be transcoded", "TRANSCODE_UNAVAILABLE");
    if (!info.qualities.includes(height)) throw new AppError(400, "Unsupported quality", "INVALID_INPUT");

    const own = [...this.sessions.values()].filter((session) => session.actorId === actorId).sort((a, b) => a.lastAccess - b.lastAccess);
    for (const stale of own.slice(0, Math.max(0, own.length - SESSIONS_PER_ACTOR + 1))) this.destroy(stale);

    const id = createId("med");
    const dir = path.join(this.baseDir, id);
    await fsp.mkdir(dir, { recursive: true });
    // A tail shorter than a second is folded into the previous segment, so every listed segment really gets produced.
    const segmentCount = Math.max(1, Math.floor(info.duration / SEGMENT_SECONDS) + (info.duration % SEGMENT_SECONDS >= 1 ? 1 : 0));
    this.sessions.set(id, {
      id,
      actorId,
      input: absolutePath,
      dir,
      info,
      height,
      audioIndex: Math.min(audioIndex, Math.max(0, info.audio.length - 1)),
      segmentCount,
      proc: null,
      software: false,
      run: 0,
      runStart: 0,
      head: 0,
      paused: false,
      lastRequested: 0,
      pruned: 0,
      lastAccess: Date.now()
    });
    return { id };
  }

  playlist(actorId: string, id: string): string {
    const session = this.require(actorId, id);
    const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS + 1}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
    for (let index = 0; index < session.segmentCount; index += 1) {
      const last = index === session.segmentCount - 1;
      const length = last ? Math.max(0.1, session.info.duration - index * SEGMENT_SECONDS) : SEGMENT_SECONDS;
      lines.push(`#EXTINF:${length.toFixed(6)},`, `${index}.ts`);
    }
    lines.push("#EXT-X-ENDLIST", "");
    return lines.join("\n");
  }

  /** Resolves with the path of a finished segment, starting or re-aiming ffmpeg when it is not on its way already. */
  async segment(actorId: string, id: string, index: number): Promise<string> {
    const session = this.require(actorId, id);
    if (index >= session.segmentCount) throw new AppError(404, "Segment not found", "NOT_FOUND");
    session.lastRequested = index;
    const file = this.segmentPath(session, index);
    if (fs.existsSync(file)) return file;

    this.advanceHead(session);
    const onItsWay = session.proc && index >= session.runStart && index <= session.head + 2;
    if (!onItsWay) this.start(session, index);
    else this.resume(session);

    const run = session.run;
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return file;
      if (session.run !== run || !this.sessions.has(id)) throw new AppError(404, "Segment was abandoned", "NOT_FOUND");
      if (!session.proc) break;
      session.lastAccess = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (fs.existsSync(file)) return file;
    throw new AppError(500, "Transcoding failed", "TRANSCODE_FAILED");
  }

  close(actorId: string, id: string): void {
    const session = this.sessions.get(id);
    if (session && session.actorId === actorId) this.destroy(session);
  }

  stop(): void {
    clearInterval(this.ticker);
    for (const session of [...this.sessions.values()]) this.destroy(session);
  }

  private require(actorId: string, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.actorId !== actorId) throw new AppError(404, "Playback session not found", "NOT_FOUND");
    session.lastAccess = Date.now();
    return session;
  }

  private segmentPath(session: Session, index: number): string {
    return path.join(session.dir, `${index}.ts`);
  }

  private advanceHead(session: Session): void {
    while (session.head < session.segmentCount && fs.existsSync(this.segmentPath(session, session.head))) session.head += 1;
  }

  private start(session: Session, index: number, sameRun = false): void {
    this.kill(session);
    // Segments from an earlier run at or past the new start would make `head` lie about how far this run has got.
    for (const name of fs.readdirSync(session.dir)) {
      if (name.endsWith(".tmp") || Number.parseInt(name, 10) >= index) fs.rmSync(path.join(session.dir, name), { force: true });
    }
    if (!sameRun) session.run += 1;
    session.runStart = index;
    session.head = index;

    const { video } = session.info;
    const landscape = !video || video.width >= video.height;
    const long = Math.round((session.height * 16) / 9);
    const box = landscape ? `w=${long}:h=${session.height}` : `w=${session.height}:h=${long}`;
    const hasAudio = session.info.audio.length > 0;
    const accel = session.software ? accelFor("software") : this.accel;
    const args = [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      ...accel.input,
      // Seeking the input, not the output: a run for the middle of the file starts decoding there.
      "-ss", String(index * SEGMENT_SECONDS),
      "-i", session.input,
      "-map", "0:v:0",
      ...(hasAudio ? ["-map", `0:a:${session.audioIndex}`] : []),
      "-sn", "-dn",
      "-vf", `scale=${box}:force_original_aspect_ratio=decrease:force_divisible_by=2${accel.filter}`,
      ...accel.codec(MAX_KBPS[session.height] ?? 6000),
      // A keyframe on every segment boundary, so segments line up with the precomputed playlist.
      "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
      ...(hasAudio ? ["-c:a", "aac", "-ac", "2", "-b:a", session.height <= 480 ? "96k" : "128k"] : []),
      // Keep source timestamps so a run started mid-file lands where the playlist says it does.
      "-copyts", "-avoid_negative_ts", "disabled", "-max_muxing_queue_size", "2048",
      "-f", "hls", "-hls_time", String(SEGMENT_SECONDS), "-hls_segment_type", "mpegts",
      // Segments appear under their final name only once complete.
      "-hls_flags", "temp_file",
      "-start_number", String(index),
      "-hls_segment_filename", path.join(session.dir, "%d.ts"),
      "-hls_playlist_type", "vod", "-hls_list_size", "0",
      path.join(session.dir, "ffmpeg.m3u8")
    ];
    const proc = spawn(this.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    proc.on("error", (error) => logger.error("ffmpeg failed to start", error.message));
    proc.on("close", (code, signal) => {
      if (session.proc !== proc) return;
      session.proc = null;
      if (code === 0 || signal) return;
      logger.error(`ffmpeg (${accel.encoder}) exited with code ${code}`, stderr.trim());
      this.advanceHead(session);
      // A GPU that cannot take this particular file should not make it unplayable.
      if (accel.encoder !== "software" && session.head === session.runStart && this.sessions.has(session.id)) {
        session.software = true;
        this.start(session, session.runStart, true);
      }
    });
    session.proc = proc;
    session.paused = false;
  }

  private kill(session: Session): void {
    const proc = session.proc;
    if (!proc) return;
    session.proc = null;
    session.paused = false;
    proc.kill("SIGKILL");
  }

  private resume(session: Session): void {
    if (session.proc && session.paused) {
      session.proc.kill("SIGCONT");
      session.paused = false;
    }
  }

  private destroy(session: Session): void {
    this.sessions.delete(session.id);
    const proc = session.proc;
    this.kill(session);
    // Wait for ffmpeg to be gone, or it may write one more segment into a directory being removed.
    const remove = () => fs.rm(session.dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.once("close", remove);
    else remove();
  }

  private tick(): void {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      const idle = now - session.lastAccess;
      if (idle > SESSION_TTL_MS) {
        this.destroy(session);
        continue;
      }
      if (session.proc) {
        if (idle > IDLE_KILL_MS) {
          this.kill(session);
        } else {
          this.advanceHead(session);
          const ahead = session.head - session.lastRequested;
          if (!session.paused && ahead > THROTTLE_AHEAD) {
            session.proc.kill("SIGSTOP");
            session.paused = true;
          } else if (session.paused && ahead <= THROTTLE_AHEAD / 2) {
            this.resume(session);
          }
        }
      }
      // Drop what the player has moved well past; seeking back re-encodes it.
      for (const limit = session.lastRequested - KEEP_BEHIND; session.pruned < limit; session.pruned += 1) {
        fs.rm(this.segmentPath(session, session.pruned), { force: true }, () => {});
      }
      if (session.lastRequested < session.pruned) session.pruned = Math.max(0, session.lastRequested - KEEP_BEHIND);
    }
  }

  /** Picks the first encoder that survives a real test encode, so a GPU that is present but unusable is skipped. */
  private async detectAccel(): Promise<Accel> {
    const wanted = (process.env.TRANSCODE_HWACCEL ?? "auto").toLowerCase();
    if (wanted === "none" || wanted === "software") return accelFor("software");
    const renderNodes = process.env.TRANSCODE_VAAPI_DEVICE
      ? [process.env.TRANSCODE_VAAPI_DEVICE]
      : await fsp.readdir("/dev/dri").then((names) => names.filter((name) => name.startsWith("renderD")).sort().map((name) => `/dev/dri/${name}`), () => []);
    const candidates: Accel[] = [
      accelFor("nvenc"),
      // With several GPUs the Intel/AMD one is not necessarily the first render node.
      ...renderNodes.map((node) => accelFor("vaapi", node)),
      ...renderNodes.map((node) => accelFor("vaapi-cqp", node)),
      accelFor("videotoolbox")
    ].filter((candidate) => wanted === "auto" || candidate.encoder.startsWith(wanted));
    for (const candidate of candidates) {
      try {
        await execFileAsync(
          this.ffmpeg,
          [
            "-nostdin", "-hide_banner", "-loglevel", "error",
            ...candidate.input,
            "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
            "-frames:v", "30",
            "-vf", `scale=w=640:h=360${candidate.filter}`,
            ...candidate.codec(800),
            "-f", "null", "-"
          ],
          { timeout: 20_000 }
        );
        return candidate;
      } catch {
        // Not available here; try the next one.
      }
    }
    if (wanted !== "auto") logger.warn(`TRANSCODE_HWACCEL=${wanted} is not usable here; falling back to software encoding`);
    return accelFor("software");
  }

  private async probe(absolutePath: string): Promise<Omit<MediaInfo, "transcode" | "encoder">> {
    let raw: string;
    try {
      const result = await execFileAsync(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", absolutePath], {
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024
      });
      raw = result.stdout;
    } catch {
      throw new AppError(422, "This file is not a playable video", "MEDIA_UNREADABLE");
    }
    const data = JSON.parse(raw) as { format?: Record<string, unknown>; streams?: Array<Record<string, any>> };
    const streams = data.streams ?? [];
    const videoStream = streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
    const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
    const durations = [Number(data.format?.duration), Number(videoStream?.duration)].filter((value) => Number.isFinite(value) && value > 0);
    const duration = durations.length > 0 ? Math.min(...durations) : 0;

    let video: MediaInfo["video"] = null;
    let qualities: number[] = [];
    if (videoStream) {
      const rotation = Number((videoStream.side_data_list as Array<Record<string, unknown>> | undefined)?.find((side) => side.rotation !== undefined)?.rotation ?? 0);
      const turned = Math.abs(rotation) % 180 === 90;
      const width = Number(turned ? videoStream.height : videoStream.width) || 0;
      const height = Number(turned ? videoStream.width : videoStream.height) || 0;
      const pixFmt = String(videoStream.pix_fmt ?? "");
      video = {
        codec: String(videoStream.codec_name ?? ""),
        profile: String(videoStream.profile ?? ""),
        width,
        height,
        bitDepth: Number(videoStream.bits_per_raw_sample) || (/1[026](le|be)/.test(pixFmt) ? 10 : 8)
      };
      if (duration > 0 && width > 0 && height > 0) {
        // Rate a cropped or portrait picture by the 16:9 frame it fills, so 1920x804 still counts as 1080p.
        const rating = Math.max(Math.min(width, height), Math.round((Math.max(width, height) * 9) / 16));
        qualities = LADDER.filter((step) => step <= rating);
        if (qualities.length === 0) qualities = [LADDER[LADDER.length - 1]!];
      }
    }

    return {
      duration,
      container: String(data.format?.format_name ?? ""),
      video,
      audio: audioStreams.map((stream) => ({
        codec: String(stream.codec_name ?? ""),
        channels: Number(stream.channels) || 0,
        language: String(stream.tags?.language ?? ""),
        title: String(stream.tags?.title ?? "")
      })),
      qualities
    };
  }
}

/**
 * Decoding is offloaded where it can be but frames come back to system memory for scaling, so a
 * source the GPU cannot decode quietly falls back to the CPU instead of breaking the filter chain.
 */
function accelFor(encoder: Encoder, device = ""): Accel {
  const rate = (maxKbps: number) => ["-b:v", `${Math.round(maxKbps * 0.7)}k`, "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`];
  // Segment boundaries get forced keyframes; the encoder's own cadence (as short as 12 frames by default) only costs bitrate.
  const gop = ["-g", "300"];
  switch (encoder) {
    case "nvenc":
      return {
        encoder,
        input: ["-hwaccel", "cuda"],
        filter: "",
        // NVENC only makes forced keyframes seekable (IDR) when asked to.
        codec: (maxKbps) => ["-c:v", "h264_nvenc", ...gop, "-preset", "p4", "-rc", "vbr", "-cq", "24", "-b:v", "0", "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`, "-pix_fmt", "yuv420p", "-profile:v", "high", "-forced-idr", "1"]
      };
    case "vaapi":
    case "vaapi-cqp":
      return {
        encoder,
        input: ["-init_hw_device", `vaapi=va:${device}`, "-hwaccel", "vaapi", "-hwaccel_device", "va", "-filter_hw_device", "va"],
        filter: ",format=nv12,hwupload",
        // Some Intel generations only do bitrate control with HuC firmware loaded; constant QP always works.
        codec: (maxKbps) => ["-c:v", "h264_vaapi", ...gop, ...(encoder === "vaapi" ? rate(maxKbps) : ["-rc_mode", "CQP", "-qp", "25"]), "-profile:v", "high"]
      };
    case "videotoolbox":
      return {
        encoder,
        input: ["-hwaccel", "videotoolbox"],
        filter: "",
        codec: (maxKbps) => ["-c:v", "h264_videotoolbox", ...gop, "-b:v", `${Math.round(maxKbps * 0.7)}k`, "-pix_fmt", "yuv420p", "-profile:v", "high"]
      };
    default:
      return {
        encoder: "software",
        input: [],
        filter: "",
        codec: (maxKbps) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`, "-pix_fmt", "yuv420p", "-profile:v", "high"]
      };
  }
}
