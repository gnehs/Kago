import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { AppError } from "../lib/errors.js";
import { guardedInput, inputProtocols } from "../lib/ffmpeg-input.js";
import { id as createId } from "../lib/ids.js";
import { idleCores } from "../lib/idle-cores.js";
import { logger } from "../lib/logger.js";
import type { Storyboards } from "../lib/storyboard.js";
import { SUBTITLE_DEMUXER, type PictureSubtitleFormat } from "../lib/subtitles.js";
import { accelFor, liftFilter, TRANSFER, type Accel, type Tonemap } from "../lib/video-encoding.js";
import type { HdrTransfer as Hdr, MediaInfo } from "@kago/contract";

/** A recording of a 360° camera's lenses, stitched by ffmpeg into one picture of the whole sphere. */
type Panorama = { inputs: string[]; graph: string };

type Session = {
  id: string;
  actorId: string;
  input: string;
  panorama: Panorama | null;
  dir: string;
  info: MediaInfo;
  height: number;
  audioIndex: number;
  subtitleIndex: number | null;
  subtitleFile: { absolutePath: string; format: PictureSubtitleFormat } | null;
  /** HDR in, HDR out. Such a stream is HEVC in fragmented MP4, the one form of it browsers take over HLS. */
  hdr: boolean;
  /** Segments in fragmented MP4 behind an init segment, rather than MPEG-TS: for HDR, and for Media Source Extensions. */
  fragmented: boolean;
  lift: boolean;
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
  prewarmRevision: number;
  prewarmIndex: number | null;
  warmed: Map<number, { file: string; at: number; initBytes: Buffer | null }>;
};

type PrewarmRequest = { sessionId: string; actorId: string; index: number; revision: number; queuedAt: number };
type PrewarmJob = PrewarmRequest & { dir: string; proc: ChildProcess; cancelled: boolean; initBytes: Buffer | null };

export const SEGMENT_SECONDS = 6;
const MAX_KBPS: Record<number, number> = { 2160: 16000, 1440: 10000, 1080: 6000, 720: 3000, 480: 1500, 360: 800 };
const SESSIONS_PER_ACTOR = 3;
/** ffmpeg stops when nobody has asked for a segment this long; the session itself outlives it so a paused player can resume. */
const IDLE_KILL_MS = 60_000;
const SESSION_TTL_MS = 15 * 60_000;
/** A queued hover is useful only while the pointer is likely to remain near its target. */
const PREWARM_QUEUE_TTL_MS = 15_000;
/** A speculative encode is short and bounded even when the source or a hardware encoder stalls. */
const PREWARM_TIMEOUT_MS = 30_000;
/** Keep only a small, recent window after the pointer leaves the timeline. */
const PREWARM_CACHE_TTL_MS = 60_000;
const PREWARM_SEGMENTS = 2;
const PREWARM_QUEUE_LIMIT = 8;
/** ffmpeg is suspended once it is this many segments ahead of the player, and resumed when the lead halves. */
const THROTTLE_AHEAD = 20;
const KEEP_BEHIND = 10;
const SEGMENT_WAIT_MS = 55_000;
/**
 * Where white subtitles sit on an HDR signal: at the level of reference white (203 nits), not at the peak of
 * the curve, where they would be the brightest thing on screen.
 */
const SUBTITLE_LEVEL: Record<Hdr, number> = { pq: 0.58, hlg: 0.75 };
const INIT_SEGMENT = "init.mp4";
/** The mastering peak assumed for a picture that does not give one. */
const DEFAULT_PEAK_NITS = 1000;
/** How far before the video a subtitle file starts being read, so a line already on screen at that point is there. */
const SUBTITLE_LEAD_SECONDS = 120;

/** Music re-encoded for a browser that cannot decode it: Opus at a rate where it is not told from the original. */
const AUDIO_KBPS = 160;
/** One for each music window that may be loading at once; a seek opens a new stream before the old one is let go. */
const AUDIO_STREAMS_PER_ACTOR = 4;

/**
 * On-the-fly video transcoding, modelled on Jellyfin: the playlist is computed up front from the
 * duration, and ffmpeg is started (or restarted at another offset) lazily as segments are requested.
 * Every ffmpeg someone is waiting on runs here, the Opus of a sound included, so speculative work can yield to
 * all of them.
 */
export class Transcoder {
  private readonly baseDir: string;
  /** The ffmpeg behind each stream of re-encoded music, oldest first, by whose it is. */
  private readonly audioStreams = new Map<string, Set<ChildProcess>>();
  private readonly sessions = new Map<string, Session>();
  /** At most one speculative ffmpeg runs on the server; queued targets are latest-wins per session. */
  private readonly pendingPrewarms = new Map<string, PrewarmRequest>();
  private activePrewarm: PrewarmJob | null = null;
  /** Blocks a new speculative job while a foreground encoder waits for the active child to close. */
  private foregroundStarts = 0;

  constructor(
    appDataDir: string,
    private readonly ffmpeg: string,
    private readonly storyboards: Storyboards,
    /** The encoder and tone mapping found to work here; settled before the first session or stream can be asked for. */
    private readonly encoding: () => { accel: Accel; tonemap: Tonemap | null }
  ) {
    this.baseDir = path.join(appDataDir, "temp", "transcode");
    fs.rmSync(this.baseDir, { recursive: true, force: true });
  }

  async addSession(actorId: string, input: string, info: MediaInfo, options: Pick<Session, "panorama" | "height" | "audioIndex" | "subtitleIndex" | "subtitleFile" | "hdr" | "fragmented" | "lift">): Promise<Session> {
    const own = [...this.sessions.values()].filter((session) => session.actorId === actorId).sort((a, b) => a.lastAccess - b.lastAccess);
    for (const stale of own.slice(0, Math.max(0, own.length - SESSIONS_PER_ACTOR + 1))) this.destroy(stale);
    const id = createId("med");
    const dir = path.join(this.baseDir, id);
    await fsp.mkdir(dir, { recursive: true });
    // A tail shorter than a second is folded into the previous segment, so every listed segment really gets produced.
    const segmentCount = Math.max(1, Math.floor(info.duration / SEGMENT_SECONDS) + (info.duration % SEGMENT_SECONDS >= 1 ? 1 : 0));
    const session: Session = {
      id,
      actorId,
      input,
      dir,
      info,
      ...options,
      segmentCount,
      proc: null,
      software: false,
      run: 0,
      runStart: 0,
      head: 0,
      paused: false,
      lastRequested: 0,
      pruned: 0,
      lastAccess: Date.now(),
      prewarmRevision: 0,
      prewarmIndex: null,
      warmed: new Map()
    };
    this.sessions.set(id, session);
    return session;
  }

  /** Speculatively encodes up to two segments around a scrub target when foreground work leaves room. */
  prewarm(actorId: string, id: string, request: { time: number | null; revision: number }): { status: "ready" | "queued" | "skipped"; reason?: string } {
    const session = this.require(actorId, id);
    if (request.revision <= session.prewarmRevision) return { status: "skipped", reason: "stale-revision" };
    session.prewarmRevision = request.revision;

    if (request.time === null) {
      session.prewarmIndex = null;
      this.pendingPrewarms.delete(id);
      this.cancelPrewarm(id);
      this.pumpPrewarms();
      return { status: "skipped", reason: "cancelled" };
    }

    const index = Math.min(session.segmentCount - 1, Math.floor(request.time / SEGMENT_SECONDS));
    session.prewarmIndex = index;
    this.retainWarmWindow(session, index);
    const wasQueued = this.pendingPrewarms.has(id);
    this.pendingPrewarms.delete(id);

    const segment = this.segmentPath(session, index);
    if (fs.existsSync(segment)) {
      this.cancelPrewarm(id);
      return { status: "ready" };
    }
    const cached = session.warmed.get(index);
    if (cached && this.warmCompatible(session, cached)) {
      this.cancelPrewarm(id);
      return { status: "ready" };
    }
    if (cached) this.removeWarmSegment(session, index);
    if (session.fragmented && !this.readInitBytes(session)) {
      session.prewarmIndex = null;
      return { status: "skipped", reason: "init-unavailable" };
    }

    const active = this.activePrewarm;
    if (active && active.sessionId === id && active.index === index && !active.cancelled) {
      active.revision = request.revision;
      active.queuedAt = Date.now();
      return { status: "queued" };
    }
    if (active?.sessionId === id && active.index !== index) this.cancelPrewarm(id);

    if (!wasQueued && this.pendingPrewarms.size >= PREWARM_QUEUE_LIMIT) {
      session.prewarmIndex = null;
      return { status: "skipped", reason: "queue-full" };
    }
    this.pendingPrewarms.set(id, { sessionId: id, actorId, index, revision: request.revision, queuedAt: Date.now() });
    this.pumpPrewarms();
    return { status: "queued" };
  }

  /**
   * The sound of a file from `start` seconds in, re-encoded as Opus while it is being sent. Nothing is kept:
   * ffmpeg writes straight into the response and runs no faster than the player reads, and a seek is a new stream.
   */
  async audioStream(actorId: string, absolutePath: string, start: number): Promise<{ stream: Readable; stop: () => void }> {
    this.foregroundStarts += 1;
    try {
      await this.preemptSpeculation();
      const own = this.audioStreams.get(actorId) ?? new Set<ChildProcess>();
      this.audioStreams.set(actorId, own);
      for (const stale of [...own].slice(0, Math.max(0, own.size - AUDIO_STREAMS_PER_ACTOR + 1))) stale.kill("SIGKILL");

      const proc = spawn(
        this.ffmpeg,
        [
          "-nostdin", "-hide_banner", "-loglevel", "error",
          // Seeking the input, not the output: a stream for the middle of an album starts decoding there.
          "-ss", start.toFixed(3),
          ...guardedInput(absolutePath),
          "-map", "0:a:0", "-vn", "-sn", "-dn",
          "-c:a", "libopus", "-b:a", `${AUDIO_KBPS}k`, "-ac", "2",
          "-f", "webm", "pipe:1"
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      own.add(proc);
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      proc.on("error", (error) => logger.error("ffmpeg failed to start", error.message));
      proc.on("close", (code, signal) => {
        own.delete(proc);
        if (own.size === 0 && this.audioStreams.get(actorId) === own) this.audioStreams.delete(actorId);
        if (code !== 0 && !signal) logger.error(`ffmpeg (opus) exited with code ${code}`, stderr.trim());
        this.pumpPrewarms();
      });
      return { stream: proc.stdout, stop: () => proc.kill("SIGKILL") };
    } finally {
      this.foregroundStarts -= 1;
    }
  }

  playlist(actorId: string, id: string): string {
    const session = this.require(actorId, id);
    const lines = ["#EXTM3U", `#EXT-X-VERSION:${session.fragmented ? 7 : 3}`, `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS + 1}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
    if (session.fragmented) lines.push(`#EXT-X-MAP:URI="${INIT_SEGMENT}"`);
    for (let index = 0; index < session.segmentCount; index += 1) {
      const last = index === session.segmentCount - 1;
      const length = last ? Math.max(0.1, session.info.duration - index * SEGMENT_SECONDS) : SEGMENT_SECONDS;
      lines.push(`#EXTINF:${length.toFixed(6)},`, path.basename(this.segmentPath(session, index)));
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

    const cached = session.warmed.get(index);
    if (cached && Date.now() - cached.at <= PREWARM_CACHE_TTL_MS && this.warmCompatible(session, cached)) {
      if (session.prewarmIndex === index) {
        session.prewarmIndex = null;
        this.pendingPrewarms.delete(id);
      }
      const bytes = fs.readFileSync(cached.file);
      if (session.proc) {
        // A paused foreground run could still write this segment after the warm result is served.
        const proc = session.proc;
        const closed = this.waitForClose(proc);
        this.kill(session);
        session.run += 1;
        session.runStart = index;
        session.head = index;
        await closed;
        if (!this.sessions.has(id)) throw new AppError(404, "Playback session not found", "NOT_FOUND");
        fs.rmSync(file, { force: true });
        fs.writeFileSync(file, bytes);
        this.removeWarmSegment(session, index);
        session.prewarmIndex = null;
        this.pendingPrewarms.delete(id);
        this.pumpPrewarms();
        return file;
      }
      try {
        // Serve from the regular session output directory so a later warm-cache eviction cannot race the response stream.
        fs.copyFileSync(cached.file, file, fs.constants.COPYFILE_EXCL);
        this.removeWarmSegment(session, index);
        session.prewarmIndex = null;
        this.pendingPrewarms.delete(id);
        this.cancelPrewarm(id);
        return file;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return file;
        this.removeWarmSegment(session, index);
      }
    } else if (cached) {
      this.removeWarmSegment(session, index);
    }

    // A real cache miss is a seek: discard this session's stale hover, but leave it alone for ordinary file hits above.
    this.retainWarmWindow(session, index);
    this.pendingPrewarms.delete(id);
    session.prewarmIndex = null;
    this.cancelPrewarm(id);

    this.advanceHead(session);
    // Below `head` this run has written the segment already, so a missing file there was pruned and has to be encoded again.
    const onItsWay = session.proc && index >= session.head && index <= session.head + 2;
    if (!onItsWay) await this.start(session, index);
    else await this.resume(session);
    return this.awaitFile(session, file);
  }

  /**
   * The header of a fragmented MP4 stream. Every run writes it anew, and it is whole once that run's first segment
   * is, so until then this waits rather than hand out a file ffmpeg has only just opened.
   */
  async initSegment(actorId: string, id: string): Promise<string> {
    const session = this.require(actorId, id);
    if (!session.fragmented) throw new AppError(404, "Segment not found", "NOT_FOUND");
    const file = path.join(session.dir, INIT_SEGMENT);
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    let started = false;
    while (Date.now() < deadline && this.sessions.has(id)) {
      this.advanceHead(session);
      const settled = !session.proc || session.head > session.runStart;
      if (settled && (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0) return file;
      if (session.proc) {
        await this.resume(session);
      } else {
        if (started) break;
        await this.start(session, session.lastRequested);
        started = true;
      }
      session.lastAccess = Date.now();
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new AppError(500, "Transcoding failed", "TRANSCODE_FAILED");
  }

  private async awaitFile(session: Session, file: string): Promise<string> {
    const run = session.run;
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    while (Date.now() < deadline) {
      if (fs.existsSync(file)) return file;
      if (session.run !== run || !this.sessions.has(session.id)) throw new AppError(404, "Segment was abandoned", "NOT_FOUND");
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
    this.pendingPrewarms.clear();
    for (const session of [...this.sessions.values()]) this.destroy(session);
    for (const own of this.audioStreams.values()) for (const proc of own) proc.kill("SIGKILL");
  }

  private require(actorId: string, id: string): Session {
    const session = this.sessions.get(id);
    if (!session || session.actorId !== actorId) throw new AppError(404, "Playback session not found", "NOT_FOUND");
    session.lastAccess = Date.now();
    return session;
  }

  private segmentPath(session: Session, index: number): string {
    return path.join(session.dir, `${index}.${session.fragmented ? "m4s" : "ts"}`);
  }

  private advanceHead(session: Session): void {
    while (session.head < session.segmentCount && fs.existsSync(this.segmentPath(session, session.head))) session.head += 1;
  }

  private async start(session: Session, index: number, sameRun = false): Promise<void> {
    this.foregroundStarts += 1;
    this.storyboards.pump(true);
    try {
      await this.preemptSpeculation(session.id);
      if (!this.sessions.has(session.id)) throw new AppError(404, "Playback session not found", "NOT_FOUND");
      if (fs.existsSync(this.segmentPath(session, index))) return;
      this.advanceHead(session);
      if (session.proc && index >= session.head && index <= session.head + 2) {
        if (session.paused) {
          session.proc.kill("SIGCONT");
          session.paused = false;
        }
        return;
      }

      this.clearWarmCache(session);
      this.kill(session);
      // Segments from an earlier run at or past the new start would make `head` lie about how far this run has got.
      for (const name of fs.readdirSync(session.dir)) {
        if (name.endsWith(".tmp") || Number.parseInt(name, 10) >= index) fs.rmSync(path.join(session.dir, name), { force: true });
      }
      if (!sameRun) session.run += 1;
      session.runStart = index;
      session.head = index;

      const args = this.transcodeArgs(session, index, session.dir);
      const accel = session.software ? accelFor("software") : this.encoding().accel;
      const proc = spawn(this.ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString()).slice(-2000);
      });
      proc.on("error", (error) => logger.error("ffmpeg failed to start", error.message));
      proc.on("close", (code, signal) => {
        if (session.proc !== proc) return;
        session.proc = null;
        if (code === 0 || signal) {
          this.pumpPrewarms();
          return;
        }
        logger.error(`ffmpeg (${accel.encoder}) exited with code ${code}`, stderr.trim());
        this.advanceHead(session);
        // A GPU that cannot take this particular file should not make it unplayable.
        if (accel.encoder !== "software" && session.head === session.runStart && this.sessions.has(session.id)) {
          session.software = true;
          void this.start(session, session.runStart, true).catch((error) => logger.error("could not restart transcoding", String(error)));
        }
        this.pumpPrewarms();
      });
      session.proc = proc;
      session.paused = false;
    } finally {
      this.foregroundStarts -= 1;
    }
  }

  /** The foreground and speculative encoders use the same streams, filters, codecs, timestamps, and HLS settings. */
  private transcodeArgs(session: Session, index: number, outputDir: string, endTime?: number): string[] {
    const { video } = session.info;
    const landscape = !video || video.width >= video.height;
    const long = Math.round((session.height * 16) / 9);
    const [boxWidth, boxHeight] = landscape ? [long, session.height] : [session.height, long];
    const hasAudio = session.info.audio.length > 0;
    const encoding = this.encoding();
    const accel = session.software ? accelFor("software") : encoding.accel;
    const sourceHdr = video?.hdr ?? null;
    const seconds = index * SEGMENT_SECONDS;
    const picture = [
      `scale=w=${boxWidth}:h=${boxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      // Scaled first: tone mapping is the costly step, and a smaller picture makes it cheaper.
      ...(sourceHdr && !session.hdr && encoding.tonemap ? [encoding.tonemap.filter(sourceHdr)] : []),
      ...(session.lift ? [liftFilter(video?.peak || DEFAULT_PEAK_NITS)] : [])
    ].join(",");
    const upload = session.hdr ? accel.hdrFilter : accel.filter;
    let filters: string[];
    if (session.panorama) {
      const tonemap = sourceHdr && encoding.tonemap ? `,${encoding.tonemap.filter(sourceHdr)}` : "";
      filters = ["-filter_complex", `${session.panorama.graph}${tonemap},format=yuv420p${accel.filter}[out]`, "-map", "[out]"];
    } else if (session.subtitleIndex === null) {
      filters = ["-map", "0:V:0", "-vf", `${picture}${upload}`];
    } else {
      // The subtitle's canvas is fitted to the picture as it comes out, which a cropped film does not fill the box with.
      const fit = video && video.width > 0 && video.height > 0 ? Math.min(boxWidth / video.width, boxHeight / video.height) : 0;
      const [width, height] = fit > 0 ? [Math.floor((video!.width * fit) / 2) * 2, Math.floor((video!.height * fit) / 2) * 2] : [boxWidth, boxHeight];
      const level = session.hdr && sourceHdr ? SUBTITLE_LEVEL[sourceHdr] : 1;
      const dim = level < 1 ? `,colorchannelmixer=rr=${level}:gg=${level}:bb=${level}` : "";
      filters = [
        "-filter_complex",
        `[0:V:0]${picture}[picture];[${session.subtitleFile ? 1 : 0}:s:${session.subtitleIndex}]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease${dim}[subtitle];` +
          `[picture][subtitle]overlay=x=(W-w)/2:y=(H-h)/2:eof_action=pass${session.hdr ? ":format=yuv420p10" : ""}${upload}[out]`,
        "-map", "[out]"
      ];
    }
    const args = [
      "-nostdin", "-hide_banner", "-loglevel", "error",
      ...accel.input,
      // Seeking the input, not the output: a run for the middle of the file starts decoding there.
      "-ss", String(seconds),
      ...guardedInput(session.input),
      // The other lens's file is read from the same moment, so the two pictures stay frame for frame together.
      ...(session.panorama?.inputs.slice(1).flatMap((other) => [...accel.decode, "-ss", String(seconds), ...guardedInput(other)]) ?? []),
      // A subtitle file keeps its own clock, which `-copyts` lines up with the video's.
      ...(session.subtitleFile && session.subtitleIndex !== null
        ? [...(seconds > SUBTITLE_LEAD_SECONDS ? ["-ss", String(seconds - SUBTITLE_LEAD_SECONDS)] : []), "-protocol_whitelist", inputProtocols(session.subtitleFile.absolutePath), "-f", SUBTITLE_DEMUXER[session.subtitleFile.format], "-i", session.subtitleFile.absolutePath]
        : []),
      ...filters,
      ...(hasAudio ? ["-map", `0:a:${session.audioIndex}`] : []),
      "-sn", "-dn",
      ...(session.hdr && sourceHdr
        ? [...accel.hevc(MAX_KBPS[session.height] ?? 6000), "-tag:v", "hvc1", "-color_primaries", "bt2020", "-color_trc", TRANSFER[sourceHdr], "-colorspace", "bt2020nc"]
        : accel.codec(MAX_KBPS[session.height] ?? 6000)),
      // A keyframe on every segment boundary, so segments line up with the precomputed playlist.
      "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_SECONDS})`,
      ...(hasAudio ? ["-c:a", "aac", "-ac", "2", "-b:a", session.height <= 480 ? "96k" : "128k"] : []),
      // Keep source timestamps so a run started mid-file lands where the playlist says it does.
      "-copyts", "-avoid_negative_ts", "disabled", "-max_muxing_queue_size", "2048",
      "-f", "hls", "-hls_time", String(SEGMENT_SECONDS),
      ...(session.fragmented ? ["-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", INIT_SEGMENT] : ["-hls_segment_type", "mpegts"]),
      // Every run's segments count their time from 0 and the page places them by segment number, as a playlist would;
      // the edit list ffmpeg adds to a run started mid-file must not move them again.
      ...(session.panorama ? ["-hls_segment_options", "use_editlist=0"] : []),
      // Segments appear under their final name only once complete.
      "-hls_flags", "temp_file",
      "-start_number", String(index),
      "-hls_segment_filename", path.join(outputDir, `%d.${session.fragmented ? "m4s" : "ts"}`),
      "-hls_playlist_type", "vod", "-hls_list_size", "0",
      // With copyts, a relative -t starts at the source timestamp and can stop before the first sought segment.
      ...(endTime === undefined ? [] : ["-to", String(endTime)]),
      path.join(outputDir, "ffmpeg.m3u8")
    ];
    return args;
  }

  private warmCacheDir(session: Session): string {
    return path.join(session.dir, ".prewarm-cache");
  }

  private warmCachePath(session: Session, index: number): string {
    return path.join(this.warmCacheDir(session), `${index}.${session.fragmented ? "m4s" : "ts"}`);
  }

  private warmCompatible(session: Session, cached: { file: string; at: number; initBytes: Buffer | null }): boolean {
    if (!fs.existsSync(cached.file)) return false;
    if (!session.fragmented) return true;
    if (!cached.initBytes) return false;
    try {
      return fs.readFileSync(path.join(session.dir, INIT_SEGMENT)).equals(cached.initBytes);
    } catch {
      return false;
    }
  }

  private removeWarmSegment(session: Session, index: number): void {
    const cached = session.warmed.get(index);
    session.warmed.delete(index);
    if (cached) {
      try {
        fs.rmSync(cached.file, { force: true });
      } catch (error) {
        logger.warn("could not remove a cached video segment", String(error));
      }
    }
  }

  private retainWarmWindow(session: Session, index: number): void {
    for (const cachedIndex of [...session.warmed.keys()]) {
      if (cachedIndex < index || cachedIndex >= index + PREWARM_SEGMENTS) this.removeWarmSegment(session, cachedIndex);
    }
  }

  private clearWarmCache(session: Session): void {
    session.warmed.clear();
    try {
      fs.rmSync(this.warmCacheDir(session), { recursive: true, force: true });
    } catch (error) {
      logger.warn("could not clear speculative video cache", String(error));
    }
  }

  private removePrewarmDirectory(dir: string): void {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      logger.warn("could not remove a speculative video work directory", String(error));
    }
  }

  private cancelPrewarm(sessionId: string): void {
    const job = this.activePrewarm;
    if (!job || job.sessionId !== sessionId || job.cancelled) return;
    job.cancelled = true;
    job.proc.kill("SIGKILL");
  }

  /** Foreground encoders take priority immediately; the speculative slot stays occupied until `close`. */
  private async preemptSpeculation(foregroundSessionId?: string): Promise<void> {
    const job = this.activePrewarm;
    if (!job) return;
    this.foregroundStarts += 1;
    if (!job.cancelled) job.cancelled = true;
    if (job.sessionId !== foregroundSessionId && job.revision === this.sessions.get(job.sessionId)?.prewarmRevision) {
      const session = this.sessions.get(job.sessionId);
      if (
        session && session.actorId === job.actorId && session.prewarmRevision === job.revision &&
        session.prewarmIndex === job.index && !this.pendingPrewarms.has(job.sessionId) &&
        this.pendingPrewarms.size < PREWARM_QUEUE_LIMIT
      ) {
        this.pendingPrewarms.set(job.sessionId, {
          sessionId: job.sessionId,
          actorId: job.actorId,
          index: job.index,
          revision: job.revision,
          queuedAt: Date.now()
        });
      }
    }
    const closed = this.waitForClose(job.proc);
    try {
      job.proc.kill("SIGKILL");
      await closed;
    } finally {
      this.foregroundStarts -= 1;
    }
  }

  private async waitForClose(proc: ChildProcess): Promise<void> {
    if ((proc as ChildProcess & { closed?: boolean }).closed) return;
    await new Promise<void>((resolve) => proc.once("close", () => resolve()));
  }

  private hasForegroundEncoder(): boolean {
    for (const session of this.sessions.values()) {
      if (session.proc && session.proc.exitCode === null && session.proc.signalCode === null && !session.paused) return true;
    }
    for (const own of this.audioStreams.values()) {
      for (const proc of own) if (proc.exitCode === null && proc.signalCode === null) return true;
    }
    return false;
  }

  private pumpPrewarms(): void {
    const now = Date.now();
    for (const request of this.pendingPrewarms.values()) {
      const session = this.sessions.get(request.sessionId);
      if (
        now - request.queuedAt > PREWARM_QUEUE_TTL_MS ||
        !session ||
        session.actorId !== request.actorId ||
        session.prewarmRevision !== request.revision ||
        session.prewarmIndex !== request.index
      ) {
        this.pendingPrewarms.delete(request.sessionId);
        if (session?.prewarmRevision === request.revision) session.prewarmIndex = null;
        continue;
      }
    }
    if (this.activePrewarm || this.foregroundStarts > 0 || this.hasForegroundEncoder() || idleCores() <= 1) return;
    for (const request of this.pendingPrewarms.values()) {
      const session = this.sessions.get(request.sessionId);
      if (!session) {
        this.pendingPrewarms.delete(request.sessionId);
        continue;
      }
      const file = this.segmentPath(session, request.index);
      if (fs.existsSync(file) || (session.warmed.has(request.index) && this.warmCompatible(session, session.warmed.get(request.index)!))) {
        this.pendingPrewarms.delete(request.sessionId);
        continue;
      }
      const initBytes = session.fragmented ? this.readInitBytes(session) : null;
      if (session.fragmented && !initBytes) {
        this.pendingPrewarms.delete(request.sessionId);
        session.prewarmIndex = null;
        continue;
      }

      this.pendingPrewarms.delete(request.sessionId);
      const dir = path.join(session.dir, `.prewarm-${createId("warm")}`);
      try {
        fs.mkdirSync(dir, { recursive: false });
        const endTime = request.index + PREWARM_SEGMENTS >= session.segmentCount
          ? session.info.duration
          : (request.index + PREWARM_SEGMENTS) * SEGMENT_SECONDS;
        const args = this.transcodeArgs(session, request.index, dir, endTime);
        const proc = spawn(this.ffmpeg, args, {
          stdio: ["ignore", "ignore", "pipe"],
          timeout: PREWARM_TIMEOUT_MS,
          killSignal: "SIGKILL"
        });
        const job: PrewarmJob = { ...request, dir, proc, cancelled: false, initBytes };
        this.activePrewarm = job;
        this.storyboards.pump(true);
        proc.stderr.on("data", () => {});
        proc.on("error", () => {});
        proc.on("close", (code, signal) => {
          if (this.activePrewarm === job) this.activePrewarm = null;
          try {
            const current = this.sessions.get(job.sessionId);
            if (
              code === 0 && !signal && !job.cancelled && current &&
              current.actorId === job.actorId && current.prewarmRevision === job.revision && current.prewarmIndex === job.index
            ) {
              this.promotePrewarm(job, current);
            }
          } catch (error) {
            logger.warn("could not cache speculative video segments", String(error));
            const current = this.sessions.get(job.sessionId);
            if (current) {
              for (let index = job.index; index < Math.min(current.segmentCount, job.index + PREWARM_SEGMENTS); index += 1) {
                this.removeWarmSegment(current, index);
              }
            }
          } finally {
            this.removePrewarmDirectory(job.dir);
            try {
              this.pumpPrewarms();
            } catch (error) {
              logger.error("could not continue speculative video queue", String(error));
            }
          }
        });
      } catch {
        this.removePrewarmDirectory(dir);
        if (session.prewarmRevision === request.revision) session.prewarmIndex = null;
      }
      return;
    }
  }

  private promotePrewarm(job: PrewarmJob, session: Session): void {
    if (session.fragmented) {
      const expected = job.initBytes;
      const made = this.readInitBytesFrom(path.join(job.dir, INIT_SEGMENT));
      const current = this.readInitBytes(session);
      if (!expected || !made?.equals(expected) || !current?.equals(expected)) return;
    }
    const extension = session.fragmented ? "m4s" : "ts";
    const end = Math.min(session.segmentCount, job.index + PREWARM_SEGMENTS);
    const found: Array<{ index: number; source: string }> = [];
    for (let index = job.index; index < end; index += 1) {
      const source = path.join(job.dir, `${index}.${extension}`);
      if ((fs.statSync(source, { throwIfNoEntry: false })?.size ?? 0) > 0) found.push({ index, source });
    }
    if (!found.some((item) => item.index === job.index)) return;
    fs.mkdirSync(this.warmCacheDir(session), { recursive: true });
    for (const item of found) {
      if (session.warmed.has(item.index)) this.removeWarmSegment(session, item.index);
      while (session.warmed.size >= PREWARM_SEGMENTS) this.removeWarmSegment(session, session.warmed.keys().next().value!);
      const target = this.warmCachePath(session, item.index);
      fs.rmSync(target, { force: true });
      fs.renameSync(item.source, target);
      session.warmed.set(item.index, { file: target, at: Date.now(), initBytes: job.initBytes });
    }
  }

  private readInitBytes(session: Session): Buffer | null {
    return this.readInitBytesFrom(path.join(session.dir, INIT_SEGMENT));
  }

  private readInitBytesFrom(file: string): Buffer | null {
    try {
      const bytes = fs.readFileSync(file);
      return bytes.length ? bytes : null;
    } catch {
      return null;
    }
  }

  private kill(session: Session): void {
    const proc = session.proc;
    if (!proc) return;
    session.proc = null;
    session.paused = false;
    proc.kill("SIGKILL");
  }

  private async resume(session: Session): Promise<void> {
    const proc = session.proc;
    if (proc && session.paused) {
      this.foregroundStarts += 1;
      try {
        await this.preemptSpeculation(session.id);
        if (session.proc === proc && session.paused) {
          proc.kill("SIGCONT");
          session.paused = false;
        }
      } finally {
        this.foregroundStarts -= 1;
      }
    }
  }

  private destroy(session: Session): void {
    this.sessions.delete(session.id);
    const proc = session.proc;
    this.pendingPrewarms.delete(session.id);
    session.prewarmIndex = null;
    const warm = this.activePrewarm?.sessionId === session.id ? this.activePrewarm : null;
    if (warm) {
      warm.cancelled = true;
      warm.proc.kill("SIGKILL");
    }
    this.kill(session);
    this.clearWarmCache(session);
    // Wait for both encoders to close, or one could write into a directory being removed.
    const children = [proc, warm?.proc].filter((child): child is ChildProcess => Boolean(child));
    const openChildren = children.filter((child) => !(child as ChildProcess & { closed?: boolean }).closed);
    let remaining = openChildren.length;
    const remove = () => fs.rm(session.dir, { recursive: true, force: true, maxRetries: 3 }, () => {});
    if (remaining === 0) remove();
    else {
      for (const child of openChildren) {
        child.once("close", () => {
          remaining -= 1;
          if (remaining === 0) remove();
        });
        child.kill("SIGKILL");
      }
    }
  }

  tick(): void {
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
            void this.resume(session);
          }
        }
      }
      // Drop what the player has moved well past; seeking back re-encodes it.
      for (const limit = session.lastRequested - KEEP_BEHIND; session.pruned < limit; session.pruned += 1) {
        fs.rm(this.segmentPath(session, session.pruned), { force: true }, () => {});
      }
      if (session.lastRequested < session.pruned) session.pruned = Math.max(0, session.lastRequested - KEEP_BEHIND);
      for (const [index, cached] of session.warmed) {
        if (now - cached.at > PREWARM_CACHE_TTL_MS) this.removeWarmSegment(session, index);
      }
    }
    this.pumpPrewarms();
  }

  /** Whether a picture or a sound is being made, or waited for, right now: what a storyboard waits behind. */
  busy(): boolean {
    return this.activePrewarm !== null || this.pendingPrewarms.size > 0 || this.foregroundStarts > 0 || this.hasForegroundEncoder();
  }
}
