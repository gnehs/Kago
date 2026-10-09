import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { guardedInput, guardedProbe, inputProtocols } from "../lib/ffmpeg-input.js";
import { id as createId } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { loadSharp } from "../lib/sharp.js";
import { streamLanguage, type PictureSubtitleFormat, type SubtitleFormat } from "../lib/subtitles.js";

const execFileAsync = promisify(execFile);

export const mediaSessionSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  height: z.number().int().min(144).max(4320),
  audioIndex: z.number().int().min(0).max(63).default(0),
  /** A picture subtitle to draw into the frames, numbered among the subtitle streams of the file it is in. */
  subtitleIndex: z.number().int().min(0).max(255).nullable().default(null),
  /** The file that subtitle is in, when it lies next to the video rather than inside it. */
  subtitlePath: z.string().min(1).nullable().default(null),
  /** Whether the player's screen and browser can show HDR; otherwise an HDR source is tone-mapped to SDR. */
  hdr: z.boolean().default(false),
  /** Whether a PQ picture kept as HDR is brightened to sit where other players put it. */
  lift: z.boolean().default(false)
});

export const mediaStreamSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  index: z.coerce.number().int().min(0).max(255)
});

/** Where in a file a stream of its sound re-encoded as Opus should begin. */
export const mediaAudioSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  start: z.coerce.number().min(0).max(1_000_000).default(0)
});

export type MediaInfo = {
  /** False when ffmpeg is missing; the client then falls back to playing the file as-is. */
  transcode: boolean;
  duration: number;
  /** ffprobe's format name list, e.g. `mov,mp4,m4a,3gp,3g2,mj2` or `matroska,webm`. */
  container: string;
  /** Bits per second of the whole file; 0 where a figure is not known, here and for each stream. */
  bitrate: number;
  /**
   * `hdr` names the transfer curve of an HDR picture: PQ (HDR10, Dolby Vision with an HDR10 base) or HLG.
   * `peak` is the brightest its mastering display went, in nits; 0 when the file does not say.
   * `level` is as ffprobe gives it (41 for H.264 level 4.1, 153 for HEVC level 5.1); `dolbyVision` is the profile, 0 without it.
   */
  video: {
    codec: string;
    profile: string;
    level: number;
    width: number;
    height: number;
    fps: number;
    bitDepth: number;
    pixelFormat: string;
    interlaced: boolean;
    bitrate: number;
    hdr: Hdr | null;
    peak: number;
    dolbyVision: number;
  } | null;
  audio: Array<{ codec: string; profile: string; channels: number; layout: string; sampleRate: number; bitrate: number; language: string; title: string; default: boolean }>;
  /** Subtitle streams inside the file, numbered among themselves. `text` ones are handed to the player; `picture` ones are drawn into the frames. */
  subtitles: Array<{ index: number; codec: string; language: string; title: string; default: boolean; forced: boolean; sdh: boolean; text: boolean; picture: boolean }>;
  /** Fonts attached to the file for its subtitles, numbered among the attachments. */
  fonts: Array<{ index: number; name: string }>;
  /** Heights the file can be transcoded to, tallest first. */
  qualities: number[];
  /** What the file says about itself: ID3 in an MP3, Vorbis comments in FLAC and Ogg, atoms in MP4, and so on. Empty where it says nothing. */
  tags: MediaTags;
  /** Which of the file's video streams is a picture attached to it, such as the cover of an album; null without one. */
  cover: number | null;
  /** Whether the file's sound can be re-encoded as Opus as it plays, for music the browser cannot decode. */
  audioTranscode: boolean;
  /** What does the encoding: `software`, or the GPU API in use. */
  encoder: Encoder;
  /** Whether an HDR source can be transcoded as HDR (10-bit HEVC), for a screen that shows it. */
  hdrOutput: boolean;
  /** Whether an HDR source can be tone-mapped to SDR. Without it the transcoded picture is washed out. */
  tonemap: boolean;
};

export type MediaTags = { title: string; artist: string; album: string; albumArtist: string; track: string; date: string; genre: string; lyrics: string };

const NO_TAGS: MediaTags = { title: "", artist: "", album: "", albumArtist: "", track: "", date: "", genre: "", lyrics: "" };
/** Lyrics are kept whole in a tag; anything longer than a song's worth is not lyrics. */
const MAX_LYRICS_LENGTH = 100_000;

type Hdr = "pq" | "hlg";

/** A picture subtitle file beside the video. */
/** Only what tells one version of a file from the next is read from `stat`. */
type FileVersion = { size: number; mtimeMs: number };

export type PictureSubtitleFile = { absolutePath: string; stat: FileVersion; format: PictureSubtitleFormat };

type Encoder = "software" | "nvenc" | "vaapi" | "vaapi-cqp" | "videotoolbox";

/** How one encoder is driven: what goes before the input, after the scaler, and in place of libx264. */
type Accel = {
  encoder: Encoder;
  input: string[];
  filter: string;
  codec: (maxKbps: number) => string[];
  /** The same two for HDR output, which is 10-bit HEVC. */
  hdrFilter: string;
  hevc: (maxKbps: number) => string[];
};

/** A filter chain that turns an HDR picture into BT.709 SDR. */
type Tonemap = { name: string; filter: (hdr: Hdr) => string };

type Session = {
  id: string;
  actorId: string;
  input: string;
  dir: string;
  info: MediaInfo;
  height: number;
  audioIndex: number;
  subtitleIndex: number | null;
  subtitleFile: PictureSubtitleFile | null;
  /** HDR in, HDR out. Such a stream is HEVC in fragmented MP4, the one form of it browsers take over HLS. */
  hdr: boolean;
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
/** Subtitle codecs that are text and can be rewritten as ASS or SubRip; the rest are pictures. */
const TEXT_SUBTITLES = new Set(["ass", "ssa", "subrip", "srt", "mov_text", "webvtt", "text"]);
/** Picture subtitles ffmpeg can decode and lay over the video: Blu-ray, DVD, broadcast and DivX. */
const PICTURE_SUBTITLES = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]);
const TRANSFER: Record<Hdr, string> = { pq: "smpte2084", hlg: "arib-std-b67" };
/**
 * Where white subtitles sit on an HDR signal: at the level of reference white (203 nits), not at the peak of
 * the curve, where they would be the brightest thing on screen.
 */
const SUBTITLE_LEVEL: Record<Hdr, number> = { pq: 0.58, hlg: 0.75 };
const INIT_SEGMENT = "init.mp4";
/**
 * Browsers show PQ with 203 nits as the white of the page; players that follow Apple's convention put 100 nits
 * there, a stop brighter. A film graded dark then looks dull next to a page. Lifting by the ratio of the two
 * makes up the difference.
 */
const LIFT_GAIN = 2.03;
/** The mastering peak assumed for a picture that does not give one. */
const DEFAULT_PEAK_NITS = 1000;
/** The demuxer each kind of subtitle file is read with. It is named outright, so what is in the file cannot pick another. */
const SUBTITLE_DEMUXER: Record<PictureSubtitleFormat, string> = { pgs: "sup", vobsub: "vobsub" };
/** How far before the video a subtitle file starts being read, so a line already on screen at that point is there. */
const SUBTITLE_LEAD_SECONDS = 120;
/** Reading a subtitle stream out means reading through the whole file, which takes a while on a large one. */
const EXTRACT_TIMEOUT_MS = 180_000;
/** What ffmpeg hands over through a pipe is held whole in memory: a cover scaled down for a screen, hardly packed, fits many times over. */
const MAX_PIPED_BYTES = 64 * 1024 * 1024;
const EXTRACT_KEEP = 24;
/** How many files are looked at, and how many have something taken out of them, at one time; the rest wait their turn. */
const PROBE_JOBS = 4;
const EXTRACT_JOBS = 2;
/** How many may wait before the next is turned away instead: more than a folder of music asks for, less than a flood. */
const MAX_WAITING_JOBS = 2000;
const PROBES_KEPT = 1000;

/** Lets `limit` jobs run at once and makes the others wait in line, so a burst of requests is not a burst of processes. */
function slots(limit: number) {
  let running = 0;
  const waiting: Array<() => void> = [];
  return async <T>(job: () => Promise<T>): Promise<T> => {
    if (running < limit) running += 1;
    else if (waiting.length >= MAX_WAITING_JOBS) throw new AppError(503, "The server is busy; try again later", "MEDIA_BUSY");
    // Whoever finishes hands its slot straight to the next in line, so the count only drops when nobody waits.
    else await new Promise<void>((resolve) => waiting.push(resolve));
    try {
      return await job();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else running -= 1;
    }
  };
}

/** A picture attached to a file is decoded whole before it is shrunk; one larger than this is left alone. */
const MAX_COVER_PIXELS = 64_000_000;
/** No name of a song is this long; a tag that is longer is cut, so a file cannot make its listing arbitrarily large. */
const MAX_TAG_LENGTH = 500;

/** Music re-encoded for a browser that cannot decode it: Opus at a rate where it is not told from the original. */
const AUDIO_KBPS = 160;
/** One for each music window that may be loading at once; a seek opens a new stream before the old one is let go. */
const AUDIO_STREAMS_PER_ACTOR = 4;

/**
 * On-the-fly video transcoding, modelled on Jellyfin: the playlist is computed up front from the
 * duration, and ffmpeg is started (or restarted at another offset) lazily as segments are requested.
 */
export class MediaService {
  private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  private readonly ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  private readonly baseDir: string;
  private readonly extractDir: string;
  /** Extractions under way or done, by output path; the oldest files are dropped as new ones arrive. */
  private readonly extracts = new Map<string, Promise<string>>();
  private readonly available: Promise<boolean>;
  private accel: Accel = accelFor("software");
  private hdrOutput = false;
  private tonemap: Tonemap | null = null;
  private opus = false;
  /** The ffmpeg behind each stream of re-encoded music, oldest first, by whose it is. */
  private readonly audioStreams = new Map<string, Set<ChildProcess>>();
  private readonly sessions = new Map<string, Session>();
  private readonly probes = new Map<string, Omit<MediaInfo, "transcode" | "audioTranscode" | "encoder" | "hdrOutput" | "tonemap">>();
  private readonly probing = new Map<string, Promise<Omit<MediaInfo, "transcode" | "audioTranscode" | "encoder" | "hdrOutput" | "tonemap">>>();
  // Anyone who may look at a folder may ask about every file in it; each question is a process of its own.
  private readonly probeSlots = slots(PROBE_JOBS);
  private readonly extractSlots = slots(EXTRACT_JOBS);
  private readonly subtitleProbes = new Map<string, Array<{ index: number; language: string }>>();
  private readonly ticker: NodeJS.Timeout;

  constructor(appDataDir: string) {
    this.baseDir = path.join(appDataDir, "temp", "transcode");
    this.extractDir = path.join(appDataDir, "temp", "media-extract");
    fs.rmSync(this.baseDir, { recursive: true, force: true });
    fs.rmSync(this.extractDir, { recursive: true, force: true });
    this.available = Promise.all([execFileAsync(this.ffmpeg, ["-version"]), execFileAsync(this.ffprobe, ["-version"])]).then(
      async () => {
        this.accel = await this.detectAccel();
        [this.hdrOutput, this.tonemap, this.opus] = await Promise.all([this.detectHdrOutput(this.accel), this.detectTonemap(), this.detectOpus()]);
        if (!this.opus) logger.warn("this ffmpeg has no libopus encoder; music the browser cannot play will not be transcoded");
        logger.info(`video transcoding uses ${this.accel.encoder}; HDR is ${this.hdrOutput ? "kept for screens that show it" : "not encoded"} and ${this.tonemap ? `tone-mapped with ${this.tonemap.name}` : "cannot be tone-mapped"} for the rest`);
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

  async info(absolutePath: string, stat: FileVersion): Promise<MediaInfo> {
    if (!(await this.available)) return { transcode: false, duration: 0, container: "", bitrate: 0, video: null, audio: [], subtitles: [], fonts: [], qualities: [], tags: NO_TAGS, cover: null, audioTranscode: false, encoder: "software", hdrOutput: false, tonemap: false };
    const key = `${absolutePath}:${stat.mtimeMs}:${stat.size}`;
    let probed = this.probes.get(key);
    if (!probed) {
      // Asked about twice at once, a file is still looked at once.
      let probing = this.probing.get(key);
      if (!probing) {
        probing = this.probeSlots(() => this.probe(absolutePath)).finally(() => this.probing.delete(key));
        this.probing.set(key, probing);
      }
      probed = await probing;
      if (this.probes.size >= PROBES_KEPT) this.probes.delete(this.probes.keys().next().value!);
      this.probes.set(key, probed);
    }
    return { transcode: probed.qualities.length > 0, audioTranscode: this.opus && probed.audio.length > 0, encoder: this.accel.encoder, hdrOutput: this.hdrOutput, tonemap: this.tonemap !== null, ...probed };
  }

  /** A subtitle stream written out as a file of its own: ASS as it is, any other text format as SubRip. */
  async subtitle(absolutePath: string, stat: FileVersion, index: number): Promise<{ file: string; format: SubtitleFormat }> {
    const stream = (await this.info(absolutePath, stat)).subtitles.find((item) => item.index === index);
    if (!stream?.text) throw new AppError(404, "Subtitle not found", "NOT_FOUND");
    const format: SubtitleFormat = stream.codec === "ass" || stream.codec === "ssa" ? "ass" : "srt";
    const file = await this.extract(absolutePath, stat, `sub-${index}.${format}`, (out) => [
      ...guardedInput(absolutePath), "-map", `0:s:${index}`, "-c:s", format === "ass" ? "copy" : "srt", "-f", format, out
    ]);
    return { file, format };
  }

  /** The streams of a picture subtitle file: one in a Blu-ray `.sup`, one for each language in a DVD index. */
  async pictureStreams(file: PictureSubtitleFile): Promise<Array<{ index: number; language: string }>> {
    if (!(await this.available)) return [];
    const key = `${file.absolutePath}:${file.stat.mtimeMs}:${file.stat.size}`;
    let streams = this.subtitleProbes.get(key);
    if (!streams) {
      try {
        const result = await execFileAsync(this.ffprobe, ["-v", "error", "-protocol_whitelist", inputProtocols(file.absolutePath), "-f", SUBTITLE_DEMUXER[file.format], "-print_format", "json", "-show_streams", file.absolutePath], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
        const found = (JSON.parse(result.stdout) as { streams?: Array<Record<string, any>> }).streams ?? [];
        streams = found
          .filter((stream) => PICTURE_SUBTITLES.has(String(stream.codec_name ?? "")))
          .map((stream, index) => ({ index, language: streamLanguage(String(stream.tags?.language ?? ""), "") }));
      } catch {
        streams = [];
      }
      if (this.subtitleProbes.size >= 200) this.subtitleProbes.delete(this.subtitleProbes.keys().next().value!);
      this.subtitleProbes.set(key, streams);
    }
    return streams;
  }

  /** A font attached to the file, e.g. the ones a Matroska release carries for its styled subtitles. */
  async font(absolutePath: string, stat: FileVersion, index: number): Promise<string> {
    if (!(await this.info(absolutePath, stat)).fonts.some((item) => item.index === index)) throw new AppError(404, "Attachment not found", "NOT_FOUND");
    return this.extract(absolutePath, stat, `font-${index}`, (out) => [`-dump_attachment:t:${index}`, out, ...guardedInput(absolutePath)]);
  }

  /**
   * The picture attached to a file, no larger than a screen needs. ffmpeg takes it out of the file and sharp writes
   * it as an AVIF, well under half the size of the JPEG it is where there is no sharp to do so.
   */
  async cover(absolutePath: string, stat: FileVersion): Promise<string> {
    const index = (await this.info(absolutePath, stat)).cover;
    if (index === null) throw new AppError(404, "Cover not found", "NOT_FOUND");
    const picture = (out: string, format: string[]) => [...guardedInput(absolutePath), "-map", `0:v:${index}`, "-frames:v", "1", "-vf", "scale='min(1200,iw)':-2", ...format, out];
    const sharp = await loadSharp();
    if (!sharp) return this.extract(absolutePath, stat, "cover.jpg", (out) => picture(out, ["-q:v", "3", "-f", "mjpeg"]));
    return this.extract(
      absolutePath,
      stat,
      "cover.avif",
      (out) => picture(out, ["-c:v", "png", "-compression_level", "1", "-f", "image2pipe"]),
      (frame, out) => sharp(frame).avif({ quality: 60, effort: 2 }).toFile(out)
    );
  }

  /**
   * Something ffmpeg takes out of a file, kept under the file's key and `name`. With `write`, ffmpeg hands what it
   * took out over through a pipe instead of writing it, and `write` makes the file of it.
   */
  private extract(absolutePath: string, stat: FileVersion, name: string, args: (out: string) => string[], write?: (made: Buffer, out: string) => Promise<unknown>): Promise<string> {
    const key = createHash("sha1").update(`${absolutePath}:${stat.mtimeMs}:${stat.size}`).digest("hex");
    const target = path.join(this.extractDir, `${key}-${name}`);
    let pending = this.extracts.get(target);
    if (!pending) {
      pending = this.extractSlots(async () => {
        await fsp.mkdir(this.extractDir, { recursive: true });
        const partial = `${target}.part`;
        if (write) {
          const made = await execFileAsync(this.ffmpeg, ["-v", "error", "-nostdin", ...args("pipe:1")], { timeout: EXTRACT_TIMEOUT_MS, encoding: "buffer", maxBuffer: MAX_PIPED_BYTES }).then(({ stdout }) => stdout, () => null);
          if (made?.length) await write(made, partial).catch(() => {});
        } else {
          // Dumping an attachment has no output file, which ffmpeg reports as an error after writing it.
          await execFileAsync(this.ffmpeg, ["-v", "error", "-nostdin", "-y", ...args(partial)], { timeout: EXTRACT_TIMEOUT_MS }).catch(() => {});
        }
        try {
          await fsp.rename(partial, target);
        } catch {
          throw new AppError(422, "This stream cannot be read", "MEDIA_UNREADABLE");
        }
        return target;
      });
      this.extracts.set(target, pending);
      pending.catch(() => this.extracts.delete(target));
      if (this.extracts.size > EXTRACT_KEEP) {
        const oldest = this.extracts.keys().next().value!;
        this.extracts.delete(oldest);
        void fsp.rm(oldest, { force: true });
      }
    }
    return pending;
  }

  async createSession(actorId: string, absolutePath: string, stat: FileVersion, options: { height: number; audioIndex: number; subtitleIndex: number | null; subtitleFile?: PictureSubtitleFile | null; hdr: boolean; lift?: boolean }) {
    const { height, audioIndex, subtitleIndex } = options;
    const subtitleFile = subtitleIndex === null ? null : (options.subtitleFile ?? null);
    const info = await this.info(absolutePath, stat);
    if (!info.transcode) throw new AppError(422, "This file cannot be transcoded", "TRANSCODE_UNAVAILABLE");
    if (!info.qualities.includes(height)) throw new AppError(400, "Unsupported quality", "INVALID_INPUT");
    const drawable = subtitleFile ? await this.pictureStreams(subtitleFile) : info.subtitles.filter((item) => item.picture);
    if (subtitleIndex !== null && !drawable.some((item) => item.index === subtitleIndex)) throw new AppError(400, "Unsupported subtitle", "INVALID_INPUT");

    const own = [...this.sessions.values()].filter((session) => session.actorId === actorId).sort((a, b) => a.lastAccess - b.lastAccess);
    for (const stale of own.slice(0, Math.max(0, own.length - SESSIONS_PER_ACTOR + 1))) this.destroy(stale);

    const hdr = options.hdr && this.hdrOutput && Boolean(info.video?.hdr);
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
      subtitleIndex,
      subtitleFile,
      hdr,
      // HLG is relative to the screen already and needs no such correction.
      lift: hdr && Boolean(options.lift) && info.video?.hdr === "pq",
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
    return { id, hdr: this.sessions.get(id)!.hdr };
  }

  /**
   * The sound of a file from `start` seconds in, re-encoded as Opus while it is being sent. Nothing is kept:
   * ffmpeg writes straight into the response and runs no faster than the player reads, and a seek is a new stream.
   */
  async audioStream(actorId: string, absolutePath: string, stat: FileVersion, start: number): Promise<{ stream: Readable; stop: () => void }> {
    const info = await this.info(absolutePath, stat);
    if (!info.audioTranscode) throw new AppError(422, "This file cannot be transcoded", "TRANSCODE_UNAVAILABLE");
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
    });
    return { stream: proc.stdout, stop: () => proc.kill("SIGKILL") };
  }

  playlist(actorId: string, id: string): string {
    const session = this.require(actorId, id);
    const lines = ["#EXTM3U", `#EXT-X-VERSION:${session.hdr ? 7 : 3}`, `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS + 1}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD"];
    if (session.hdr) lines.push(`#EXT-X-MAP:URI="${INIT_SEGMENT}"`);
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

    this.advanceHead(session);
    const onItsWay = session.proc && index >= session.runStart && index <= session.head + 2;
    if (!onItsWay) this.start(session, index);
    else this.resume(session);
    return this.awaitFile(session, file);
  }

  /**
   * The header of a fragmented MP4 stream. Every run writes it anew, and it is whole once that run's first segment
   * is, so until then this waits rather than hand out a file ffmpeg has only just opened.
   */
  async initSegment(actorId: string, id: string): Promise<string> {
    const session = this.require(actorId, id);
    if (!session.hdr) throw new AppError(404, "Segment not found", "NOT_FOUND");
    const file = path.join(session.dir, INIT_SEGMENT);
    const deadline = Date.now() + SEGMENT_WAIT_MS;
    let started = false;
    while (Date.now() < deadline && this.sessions.has(id)) {
      this.advanceHead(session);
      const settled = !session.proc || session.head > session.runStart;
      if (settled && (fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0) return file;
      if (session.proc) {
        this.resume(session);
      } else {
        if (started) break;
        this.start(session, session.lastRequested);
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
    clearInterval(this.ticker);
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
    return path.join(session.dir, `${index}.${session.hdr ? "m4s" : "ts"}`);
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
    const [boxWidth, boxHeight] = landscape ? [long, session.height] : [session.height, long];
    const hasAudio = session.info.audio.length > 0;
    const accel = session.software ? accelFor("software") : this.accel;
    const sourceHdr = video?.hdr ?? null;
    const seconds = index * SEGMENT_SECONDS;
    const picture = [
      `scale=w=${boxWidth}:h=${boxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      // Scaled first: tone mapping is the costly step, and a smaller picture makes it cheaper.
      ...(sourceHdr && !session.hdr && this.tonemap ? [this.tonemap.filter(sourceHdr)] : []),
      ...(session.lift ? [liftFilter(video?.peak || DEFAULT_PEAK_NITS)] : [])
    ].join(",");
    const upload = session.hdr ? accel.hdrFilter : accel.filter;
    let filters: string[];
    if (session.subtitleIndex === null) {
      filters = ["-map", "0:v:0", "-vf", `${picture}${upload}`];
    } else {
      // The subtitle's canvas is fitted to the picture as it comes out, which a cropped film does not fill the box with.
      const fit = video && video.width > 0 && video.height > 0 ? Math.min(boxWidth / video.width, boxHeight / video.height) : 0;
      const [width, height] = fit > 0 ? [Math.floor((video!.width * fit) / 2) * 2, Math.floor((video!.height * fit) / 2) * 2] : [boxWidth, boxHeight];
      const level = session.hdr && sourceHdr ? SUBTITLE_LEVEL[sourceHdr] : 1;
      const dim = level < 1 ? `,colorchannelmixer=rr=${level}:gg=${level}:bb=${level}` : "";
      filters = [
        "-filter_complex",
        `[0:v:0]${picture}[picture];[${session.subtitleFile ? 1 : 0}:s:${session.subtitleIndex}]scale=w=${width}:h=${height}:force_original_aspect_ratio=decrease${dim}[subtitle];` +
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
      ...(session.hdr ? ["-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", INIT_SEGMENT] : ["-hls_segment_type", "mpegts"]),
      // Segments appear under their final name only once complete.
      "-hls_flags", "temp_file",
      "-start_number", String(index),
      "-hls_segment_filename", path.join(session.dir, `%d.${session.hdr ? "m4s" : "ts"}`),
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

  /** Whether this encoder also makes 10-bit HEVC, which is what HDR is sent as. */
  private async detectHdrOutput(accel: Accel): Promise<boolean> {
    try {
      await execFileAsync(
        this.ffmpeg,
        [
          "-nostdin", "-hide_banner", "-loglevel", "error",
          ...accel.input,
          "-f", "lavfi", "-i", "testsrc2=size=1280x720:rate=30",
          "-frames:v", "30",
          "-vf", `scale=w=640:h=360,format=yuv420p10le${accel.hdrFilter}`,
          ...accel.hevc(800),
          "-f", "null", "-"
        ],
        { timeout: 20_000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Whether this ffmpeg build encodes Opus, which is what music is re-encoded to. */
  private async detectOpus(): Promise<boolean> {
    try {
      await execFileAsync(this.ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=0.2", "-c:a", "libopus", "-f", "null", "-"], { timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Picks the first tone-mapping chain this ffmpeg build can run. */
  private async detectTonemap(): Promise<Tonemap | null> {
    for (const candidate of TONEMAPS) {
      try {
        await execFileAsync(
          this.ffmpeg,
          [
            "-nostdin", "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv",
            "-frames:v", "5",
            "-vf", candidate.filter("pq"),
            "-f", "null", "-"
          ],
          { timeout: 20_000 }
        );
        return candidate;
      } catch {
        // Not in this build; try the next one.
      }
    }
    logger.warn("this ffmpeg cannot tone-map (no tonemapx, zscale or colour-aware scale filter); transcoded HDR video will look washed out");
    return null;
  }

  /** A picture's transfer curve and mastering peak as its first frame carries them, for files whose container does not say. */
  private async frameColour(absolutePath: string): Promise<{ transfer: string; peak: number }> {
    try {
      const result = await execFileAsync(
        this.ffprobe,
        ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_entries", "frame=color_transfer:frame_side_data=max_luminance", "-print_format", "json", ...guardedProbe(absolutePath)],
        { timeout: 20_000 }
      );
      const frame = (JSON.parse(result.stdout) as { frames?: Array<Record<string, any>> }).frames?.[0];
      return { transfer: String(frame?.color_transfer ?? ""), peak: masteringPeak(frame?.side_data_list) };
    } catch {
      return { transfer: "", peak: 0 };
    }
  }

  private async probe(absolutePath: string): Promise<Omit<MediaInfo, "transcode" | "audioTranscode" | "encoder" | "hdrOutput" | "tonemap">> {
    let raw: string;
    try {
      const result = await execFileAsync(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...guardedProbe(absolutePath)], {
        timeout: 20_000,
        maxBuffer: 8 * 1024 * 1024
      });
      raw = result.stdout;
    } catch {
      throw new AppError(422, "This file is not a playable video", "MEDIA_UNREADABLE");
    }
    const data = JSON.parse(raw) as { format?: Record<string, unknown>; streams?: Array<Record<string, any>> };
    const streams = data.streams ?? [];
    const videoStreams = streams.filter((stream) => stream.codec_type === "video");
    const videoStream = videoStreams.find((stream) => !stream.disposition?.attached_pic);
    const cover = videoStreams.findIndex((stream) => stream.disposition?.attached_pic && Number(stream.width) * Number(stream.height) <= MAX_COVER_PIXELS);
    const audioStreams = streams.filter((stream) => stream.codec_type === "audio");
    const subtitleStreams = streams.filter((stream) => stream.codec_type === "subtitle");
    const attachments = streams.filter((stream) => stream.codec_type === "attachment");
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
      const bitDepth = Number(videoStream.bits_per_raw_sample) || (/1[026](le|be)/.test(pixFmt) ? 10 : 8);
      const declared = String(videoStream.color_transfer ?? "");
      const known = declared !== "" && declared !== "unknown";
      let peak = masteringPeak(videoStream.side_data_list);
      // Only a picture that may be HDR is worth a second look.
      const frame = bitDepth > 8 && (!known || (declared === TRANSFER.pq && peak === 0)) ? await this.frameColour(absolutePath) : null;
      const transfer = known ? declared : (frame?.transfer ?? "");
      peak ||= frame?.peak ?? 0;
      video = {
        codec: String(videoStream.codec_name ?? ""),
        profile: String(videoStream.profile ?? ""),
        level: Math.max(0, Number(videoStream.level) || 0),
        width,
        height,
        fps: frameRate(videoStream.avg_frame_rate) || frameRate(videoStream.r_frame_rate),
        bitDepth,
        pixelFormat: pixFmt,
        interlaced: !["", "unknown", "progressive"].includes(String(videoStream.field_order ?? "")),
        bitrate: streamBitrate(videoStream),
        hdr: transfer === TRANSFER.pq ? "pq" : transfer === TRANSFER.hlg ? "hlg" : null,
        peak,
        dolbyVision: Number((videoStream.side_data_list as Array<Record<string, unknown>> | undefined)?.find((side) => side.dv_profile !== undefined)?.dv_profile) || 0
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
      bitrate: Number(data.format?.bit_rate) || 0,
      video,
      // Ogg keeps its comments on the stream rather than on the file.
      tags: readTags({ ...(audioStreams[0]?.tags as Record<string, unknown> | undefined), ...(data.format?.tags as Record<string, unknown> | undefined) }),
      cover: cover === -1 ? null : cover,
      subtitles: subtitleStreams.map((stream, index) => {
        const title = String(stream.tags?.title ?? "");
        return {
          index,
          codec: String(stream.codec_name ?? ""),
          language: streamLanguage(String(stream.tags?.language ?? ""), title),
          title,
          default: Boolean(stream.disposition?.default),
          forced: Boolean(stream.disposition?.forced),
          sdh: Boolean(stream.disposition?.hearing_impaired),
          text: TEXT_SUBTITLES.has(String(stream.codec_name ?? "")),
          picture: PICTURE_SUBTITLES.has(String(stream.codec_name ?? ""))
        };
      }),
      fonts: attachments
        .map((stream, index) => ({ index, name: String(stream.tags?.filename ?? ""), mime: String(stream.tags?.mimetype ?? "") }))
        .filter((item) => /\.(ttf|otf|ttc|otc|woff2?)$/i.test(item.name) || /font|truetype|opentype/i.test(item.mime))
        .map(({ index, name }) => ({ index, name })),
      audio: audioStreams.map((stream) => ({
        codec: String(stream.codec_name ?? ""),
        profile: String(stream.profile ?? ""),
        channels: Number(stream.channels) || 0,
        layout: String(stream.channel_layout ?? ""),
        sampleRate: Number(stream.sample_rate) || 0,
        bitrate: streamBitrate(stream),
        language: streamLanguage(String(stream.tags?.language ?? ""), String(stream.tags?.title ?? "")),
        title: String(stream.tags?.title ?? ""),
        default: Boolean(stream.disposition?.default)
      })),
      qualities
    };
  }
}

/** The tags a player shows, whatever case and spelling the format gave their names. */
function readTags(raw: Record<string, unknown>): MediaTags {
  const named = new Map(Object.entries(raw).map(([name, value]) => [name.toLowerCase(), String(value ?? "").trim()] as const));
  const first = (...names: string[]) => (names.map((name) => named.get(name)).find(Boolean) ?? "").slice(0, MAX_TAG_LENGTH);
  // ID3 files lyrics under their language: `lyrics-eng`.
  const lyrics = ["lyrics", "unsyncedlyrics", "syncedlyrics"].map((name) => named.get(name)).find(Boolean) ?? [...named].find(([name]) => name.startsWith("lyrics-"))?.[1] ?? "";
  return {
    title: first("title"),
    artist: first("artist"),
    album: first("album"),
    albumArtist: first("album_artist", "albumartist", "album artist"),
    track: first("track", "tracknumber"),
    date: first("date", "year", "originaldate"),
    genre: first("genre"),
    lyrics: lyrics.length <= MAX_LYRICS_LENGTH ? lyrics : ""
  };
}

/** ffprobe writes a rate as a fraction: `24000/1001`, or `0/0` where there is none. */
function frameRate(value: unknown): number {
  const [count, per = "1"] = String(value ?? "").split("/");
  const rate = Number(count) / Number(per);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate * 1000) / 1000 : 0;
}

/** Matroska keeps a stream's bit rate in a tag mkvmerge writes, rather than where ffprobe reports one. */
function streamBitrate(stream: Record<string, any>): number {
  const tags = (stream.tags ?? {}) as Record<string, unknown>;
  const tagged = Object.keys(tags).find((name) => /^BPS(-|$)/i.test(name));
  return Number(stream.bit_rate) || Number(tagged ? tags[tagged] : 0) || 0;
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
        codec: (maxKbps) => ["-c:v", "h264_nvenc", ...gop, "-preset", "p4", "-rc", "vbr", "-cq", "24", "-b:v", "0", "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`, "-pix_fmt", "yuv420p", "-profile:v", "high", "-forced-idr", "1"],
        hdrFilter: "",
        hevc: (maxKbps) => ["-c:v", "hevc_nvenc", ...gop, "-preset", "p4", "-rc", "vbr", "-cq", "26", "-b:v", "0", "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`, "-pix_fmt", "p010le", "-profile:v", "main10", "-forced-idr", "1"]
      };
    case "vaapi":
    case "vaapi-cqp":
      return {
        encoder,
        input: ["-init_hw_device", `vaapi=va:${device}`, "-hwaccel", "vaapi", "-hwaccel_device", "va", "-filter_hw_device", "va"],
        filter: ",format=nv12,hwupload",
        // Some Intel generations only do bitrate control with HuC firmware loaded; constant QP always works.
        codec: (maxKbps) => ["-c:v", "h264_vaapi", ...gop, ...(encoder === "vaapi" ? rate(maxKbps) : ["-rc_mode", "CQP", "-qp", "25"]), "-profile:v", "high"],
        hdrFilter: ",format=p010,hwupload",
        hevc: (maxKbps) => ["-c:v", "hevc_vaapi", ...gop, ...(encoder === "vaapi" ? rate(maxKbps) : ["-rc_mode", "CQP", "-qp", "27"]), "-profile:v", "main10"]
      };
    case "videotoolbox":
      return {
        encoder,
        input: ["-hwaccel", "videotoolbox"],
        filter: "",
        codec: (maxKbps) => ["-c:v", "h264_videotoolbox", ...gop, "-b:v", `${Math.round(maxKbps * 0.7)}k`, "-pix_fmt", "yuv420p", "-profile:v", "high"],
        hdrFilter: "",
        hevc: (maxKbps) => ["-c:v", "hevc_videotoolbox", ...gop, "-b:v", `${Math.round(maxKbps * 0.7)}k`, "-pix_fmt", "p010le", "-profile:v", "main10"]
      };
    default:
      return {
        encoder: "software",
        input: [],
        filter: "",
        codec: (maxKbps) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`, "-pix_fmt", "yuv420p", "-profile:v", "high"],
        hdrFilter: "",
        hevc: (maxKbps) => ["-c:v", "libx265", ...gop, "-preset", "superfast", "-crf", "25", "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`, "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error"]
      };
  }
}

/** The peak of the mastering display in ffprobe's side data, in nits. */
function masteringPeak(sideData: unknown): number {
  const mastering = (Array.isArray(sideData) ? sideData : []).find((item) => item?.max_luminance !== undefined);
  const [value, scale] = String(mastering?.max_luminance ?? "").split("/").map(Number);
  const nits = value! / (scale || 1);
  return Number.isFinite(nits) && nits > 0 ? nits : 0;
}

/**
 * Brightens a PQ picture in linear light: `LIFT_GAIN` times as bright in the shadows and midtones, easing off
 * towards the mastering peak, which stays where it was so the stream's metadata still describes it. A gain on
 * light is a gain on each of red, green and blue, so the three go through one lookup table.
 */
function liftFilter(peakNits: number): string {
  const [m1, m2, c1, c2, c3] = [0.1593017578125, 78.84375, 0.8359375, 18.8515625, 18.6875];
  const peak = peakNits / 10000;
  const curve = [
    // The table runs past the values ten bits can hold, where the curve has no meaning.
    `st(0,pow(min(val/maxval,1),1/${m2}))`,
    `st(1,pow(max(ld(0)-${c1},0)/(${c2}-${c3}*ld(0)),1/${m1}))`,
    `st(2,pow(${LIFT_GAIN}*ld(1)/(1+${LIFT_GAIN - 1}*ld(1)/${peak}),${m1}))`,
    `maxval*pow((${c1}+${c2}*ld(2))/(1+${c3}*ld(2)),${m2})`
  ].join(";").replaceAll(",", "\\,");
  return `scale=in_color_matrix=bt2020nc:in_range=tv,format=gbrp10le,lutrgb=r='${curve}':g='${curve}':b='${curve}',scale=out_color_matrix=bt2020nc:out_range=tv,format=yuv420p10le`;
}

/**
 * Ways to tone-map, best first: jellyfin-ffmpeg's own filter, then zimg, then the colour-aware scaler of ffmpeg 7.1
 * and later. Each names the source's curve itself, as frames decoded on a GPU may arrive without it.
 */
const TONEMAPS: Tonemap[] = [
  { name: "tonemapx", filter: () => "tonemapx=tonemap=bt2390:desat=0:peak=100:t=bt709:m=bt709:p=bt709:format=yuv420p" },
  {
    name: "zscale",
    filter: (hdr) => `zscale=tin=${TRANSFER[hdr]}:min=bt2020nc:pin=bt2020:rin=tv:t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p`
  },
  {
    name: "scale",
    filter: (hdr) => `scale=in_transfer=${TRANSFER[hdr]}:in_primaries=bt2020:in_color_matrix=bt2020nc:out_transfer=bt709:out_primaries=bt709:out_color_matrix=bt709,format=yuv420p`
  }
];
