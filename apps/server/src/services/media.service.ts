import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { guardedInput, guardedProbe, inputProtocols } from "../lib/ffmpeg-input.js";
import { hwAccelPreference, renderNodes, softwareOnly, testEncode } from "../lib/hw-accel.js";
import { logger } from "../lib/logger.js";
import { PANORAMA_HEIGHT, planPanorama, videoStreams, type VideoStream } from "../lib/panorama.js";
import { sharpAvailable, writeAvif } from "../lib/sharp.js";
import { Storyboards, type StoryboardState } from "../lib/storyboard.js";
import { isPictureFormat, streamLanguage, SUBTITLE_DEMUXER, TEXT_SUBTITLES, type PictureSubtitleFormat, type SubtitleFormat } from "../lib/subtitles.js";
import { accelFor, TONEMAPS, TRANSFER, type Accel, type Tonemap } from "../lib/video-encoding.js";
import type { MediaInfo, MediaTags, Storyboard, SubtitleList, SubtitleTrack } from "@kago/contract";
import type { FsService } from "./fs.service.js";
import { SEGMENT_SECONDS, Transcoder } from "./transcoder.js";

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

/** A 360° recording to stitch: the opened file, and the other half of it when its camera writes one file per lens. */
export const mediaPanoramaSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  companionPath: z.string().min(1).nullable().default(null)
});

export const mediaStreamSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  index: z.coerce.number().int().min(0).max(255)
});

export const mediaPrewarmSchema = z.object({
  time: z.number().finite().min(0).max(1_000_000).nullable(),
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
}).strict();

/** Where in a file a stream of its sound re-encoded as Opus should begin. */
export const mediaAudioSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  start: z.coerce.number().min(0).max(1_000_000).default(0)
});

const NO_TAGS: MediaTags = { title: "", artist: "", album: "", albumArtist: "", track: "", date: "", genre: "", lyrics: "" };
/** Lyrics are kept whole in a tag; anything longer than a song's worth is not lyrics. */
const MAX_LYRICS_LENGTH = 100_000;

/** Only what tells one version of a file from the next is read from `stat`. */
type FileVersion = { size: number; mtimeMs: number };

/** A sidecar subtitle file as `FsService.subtitles` lists it. */
type Sidecar = Awaited<ReturnType<FsService["subtitles"]>>[number];
/** A picture subtitle file beside the video. */
export type PictureSubtitleFile = { absolutePath: string; stat: FileVersion; format: PictureSubtitleFormat };

const LADDER = [2160, 1440, 1080, 720, 480, 360];
/** A player that seeks hangs up and asks again; the gap between the two is not the end of watching. */
const DIRECT_PLAY_GRACE_MS = 5_000;
/** Picture subtitles ffmpeg can decode and lay over the video: Blu-ray, DVD, broadcast and DivX. */
const PICTURE_SUBTITLES = new Set(["hdmv_pgs_subtitle", "dvd_subtitle", "dvb_subtitle", "xsub"]);
/** What the player calls each kind of picture subtitle. */
const PICTURE_FORMAT_NAMES: Record<string, SubtitleTrack["format"]> = { hdmv_pgs_subtitle: "pgs", dvd_subtitle: "vobsub", dvb_subtitle: "dvb" };
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

/**
 * What a media file holds and what can be taken out of it: its streams and tags, subtitles, fonts, covers and
 * storyboards. Encoding it for playback is the `Transcoder`'s, which this hands the probed file to.
 */
export class MediaService {
  private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  private readonly ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";
  private readonly extractDir: string;
  /** Extractions under way or done, by output path; the oldest files are dropped as new ones arrive. */
  private readonly extracts = new Map<string, Promise<string>>();
  private readonly available: Promise<boolean>;
  private accel: Accel = accelFor("software");
  private hdrOutput = false;
  private tonemap: Tonemap | null = null;
  private opus = false;
  /** Videos and sounds being sent as they are to someone playing them, and when the last of those ended. */
  private directPlays = 0;
  private directPlayEnded = 0;
  private readonly probes = new Map<string, Omit<MediaInfo, "transcode" | "audioTranscode" | "encoder" | "hdrOutput" | "tonemap">>();
  private readonly probing = new Map<string, Promise<Omit<MediaInfo, "transcode" | "audioTranscode" | "encoder" | "hdrOutput" | "tonemap">>>();
  // Anyone who may look at a folder may ask about every file in it; each question is a process of its own.
  private readonly probeSlots = slots(PROBE_JOBS);
  private readonly extractSlots = slots(EXTRACT_JOBS);
  private readonly subtitleProbes = new Map<string, Array<{ index: number; language: string }>>();
  private readonly storyboards: Storyboards;
  readonly transcoder: Transcoder;
  private readonly ticker: NodeJS.Timeout;

  constructor(appDataDir: string) {
    this.extractDir = path.join(appDataDir, "temp", "media-extract");
    fs.rmSync(this.extractDir, { recursive: true, force: true });
    this.storyboards = new Storyboards(this.ffmpeg, this.ffprobe, path.join(appDataDir, "storyboards"), path.join(appDataDir, "temp", "storyboards"));
    this.transcoder = new Transcoder(appDataDir, this.ffmpeg, this.storyboards, () => ({ accel: this.accel, tonemap: this.tonemap }));
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

  /**
   * Every subtitle track of a video the player can offer: the files lying next to it, then the streams inside it,
   * with the picture ones last, and the fonts its container carries.
   */
  async subtitleTracks(rootSlug: string, logicalPath: string, file: { input: string; stat: FileVersion }, sidecars: Sidecar[]): Promise<SubtitleList> {
    // Something ffprobe cannot read simply has no streams of its own to offer.
    const info = await this.info(file.input, file.stat).catch(() => null);
    const own = new URLSearchParams({ rootSlug, path: logicalPath }).toString();
    const embedded = info?.subtitles ?? [];
    // A DVD index holds a stream for each language; they are listed apart, and say their own language where the name does not.
    const pictureFiles = info?.transcode
      ? (
          await Promise.all(
            sidecars.map(async ({ path: sidecarPath, name, absolutePath, stat, ...track }) => {
              if (!isPictureFormat(track.format) || !absolutePath || !stat) return [];
              const streams = await this.pictureStreams({ absolutePath, stat, format: track.format });
              return streams.map((stream) => ({
                ...track,
                language: track.language || stream.language,
                id: streams.length > 1 ? `file:${sidecarPath}#${stream.index}` : `file:${sidecarPath}`,
                embedded: false,
                url: "",
                file: sidecarPath,
                stream: stream.index
              }));
            })
          )
        ).flat()
      : [];
    return {
      tracks: [
        ...sidecars
          .filter((sidecar) => !isPictureFormat(sidecar.format))
          .map(({ path: sidecarPath, name, absolutePath, stat, ...track }) => ({
            ...track,
            id: `file:${sidecarPath}`,
            embedded: false,
            url: `/api/fs/preview?${new URLSearchParams({ rootSlug, path: sidecarPath }).toString()}`
          })),
        ...embedded
          .filter((stream) => stream.text)
          .map(({ index, codec, text, picture, ...track }): SubtitleTrack => ({
            ...track,
            format: codec === "ass" || codec === "ssa" ? "ass" : "srt",
            id: `stream:${index}`,
            embedded: true,
            url: `/api/media/subtitle?${own}&index=${index}`
          })),
        // Picture subtitles (Blu-ray, DVD) come after the text ones: showing one means transcoding, as it is drawn into the frames.
        ...pictureFiles,
        ...embedded
          .filter((stream) => stream.picture && info?.transcode)
          .map(({ index, codec, text, picture, ...track }): SubtitleTrack => ({
            ...track,
            format: PICTURE_FORMAT_NAMES[codec] ?? "picture",
            id: `stream:${index}`,
            embedded: true,
            url: "",
            stream: index
          }))
      ],
      fonts: (info?.fonts ?? []).map((font) => `/api/media/attachment?${own}&index=${font.index}`),
      /** Subtitles in a form that can be neither handed to the browser nor drawn into the picture. */
      unsupported: embedded.filter((stream) => !stream.text && !(stream.picture && info?.transcode)).length
    };
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
    if (!(await sharpAvailable())) return this.extract(absolutePath, stat, "cover.jpg", (out) => picture(out, ["-q:v", "3", "-f", "mjpeg"]));
    return this.extract(
      absolutePath,
      stat,
      "cover.avif",
      (out) => picture(out, ["-c:v", "png", "-compression_level", "1", "-f", "image2pipe"]),
      (frame, out) => writeAvif({ input: frame, target: out, quality: 60 })
    );
  }

  /** The pictures shown over the timeline of a video. They are made while nothing is being encoded, so the first to ask finds none yet. */
  async storyboard(absolutePath: string, stat: FileVersion): Promise<Storyboard> {
    const { video, duration } = await this.info(absolutePath, stat);
    // The sheets are kept by the browser; `version` tells those of one state of the file from the next.
    const version = Math.round(stat.mtimeMs);
    return { version, ...await this.request(absolutePath, stat, video, duration) };
  }

  private request(absolutePath: string, stat: FileVersion, video: MediaInfo["video"], duration: number): Promise<StoryboardState> {
    return this.storyboards.request(absolutePath, stat, video ? { duration, tonemap: video.hdr && this.tonemap ? this.tonemap.filter(video.hdr) : null } : null);
  }

  storyboardSheet(absolutePath: string, stat: FileVersion, index: number): Promise<string> {
    return this.storyboards.sheet(absolutePath, stat, index);
  }

  pruneStoryboards(): Promise<number> {
    return this.storyboards.prune();
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

    const hdr = options.hdr && this.hdrOutput && Boolean(info.video?.hdr);
    const session = await this.transcoder.addSession(actorId, absolutePath, info, {
      panorama: null,
      height,
      audioIndex: Math.min(audioIndex, Math.max(0, info.audio.length - 1)),
      subtitleIndex,
      subtitleFile,
      hdr,
      fragmented: hdr,
      // HLG is relative to the screen already and needs no such correction.
      lift: hdr && Boolean(options.lift) && info.video?.hdr === "pq"
    });
    return { id: session.id, hdr: session.hdr };
  }

  /**
   * A session that stitches a 360° camera's recording into an equirectangular picture, in fragmented MP4 for a
   * page's Media Source to play. `files` are the opened file and the other half of its recording, if it has one.
   */
  async createPanorama(actorId: string, files: Array<{ name: string; absolutePath: string; stat: FileVersion }>) {
    if (!(await this.available)) throw new AppError(422, "This file cannot be transcoded", "TRANSCODE_UNAVAILABLE");
    const probed = await Promise.all(files.map(async (file) => ({ ...file, info: await this.info(file.absolutePath, file.stat), videos: await this.probeVideoStreams(file.absolutePath) })));
    const plan = planPanorama(probed);
    if (!plan || !probed[0]!.info.transcode) throw new AppError(422, "This file cannot be transcoded", "TRANSCODE_UNAVAILABLE");
    const inputs = plan.inputs.map((index) => probed[index]!);
    // The sound, and the clock, are the front lens's; two files of one recording can differ by a frame in length.
    const front = inputs[0]!;
    const info = { ...front.info, duration: Math.min(...inputs.map((input) => input.info.duration)) };
    const session = await this.transcoder.addSession(actorId, front.absolutePath, info, {
      panorama: { inputs: inputs.map((input) => input.absolutePath), graph: plan.graph },
      height: PANORAMA_HEIGHT,
      audioIndex: 0,
      subtitleIndex: null,
      subtitleFile: null,
      hdr: false,
      fragmented: true,
      lift: false
    });
    return { id: session.id, duration: info.duration, segmentSeconds: SEGMENT_SECONDS, segmentCount: session.segmentCount };
  }

  private async probeVideoStreams(absolutePath: string): Promise<VideoStream[]> {
    try {
      const result = await this.probeSlots(() =>
        execFileAsync(this.ffprobe, ["-v", "error", "-print_format", "json", "-show_entries", "stream=index,codec_type,codec_name,width,height:stream_disposition=attached_pic,timed_thumbnails", ...guardedProbe(absolutePath)], { timeout: 20_000, maxBuffer: 1024 * 1024 })
      );
      return videoStreams((JSON.parse(result.stdout) as { streams?: Array<Record<string, any>> }).streams ?? []);
    } catch {
      throw new AppError(422, "This file is not a playable video", "MEDIA_UNREADABLE");
    }
  }

  async audioStream(actorId: string, absolutePath: string, stat: FileVersion, start: number): Promise<{ stream: Readable; stop: () => void }> {
    const info = await this.info(absolutePath, stat);
    if (!info.audioTranscode) throw new AppError(422, "This file cannot be transcoded", "TRANSCODE_UNAVAILABLE");
    return this.transcoder.audioStream(actorId, absolutePath, start);
  }

  stop(): void {
    clearInterval(this.ticker);
    this.storyboards.stop();
    this.transcoder.stop();
  }

  private tick(): void {
    this.transcoder.tick();
    // Last in line: a storyboard is worked on only while nobody is waiting for a picture or a sound.
    this.storyboards.pump(this.transcoder.busy() || this.playingDirectly());
  }


  /**
   * Marks a file being sent as it is to someone playing it; call what is returned once it is no longer being sent.
   * A storyboard reads the whole of a video as fast as the disk goes, and on a hard drive the player would wait behind it.
   */
  directPlay(): () => void {
    this.directPlays += 1;
    this.storyboards.pump(true);
    return () => {
      this.directPlays -= 1;
      this.directPlayEnded = Date.now();
    };
  }

  private playingDirectly(): boolean {
    return this.directPlays > 0 || Date.now() - this.directPlayEnded < DIRECT_PLAY_GRACE_MS;
  }

  /** Picks the first encoder that survives a real test encode, so a GPU that is present but unusable is skipped. */
  private async detectAccel(): Promise<Accel> {
    const wanted = hwAccelPreference();
    if (softwareOnly(wanted)) return accelFor("software");
    const nodes = await renderNodes();
    const candidates: Accel[] = [
      accelFor("nvenc"),
      // With several GPUs the Intel/AMD one is not necessarily the first render node.
      ...nodes.map((node) => accelFor("vaapi", node)),
      ...nodes.map((node) => accelFor("vaapi-cqp", node)),
      accelFor("videotoolbox")
    ].filter((candidate) => wanted === "auto" || candidate.encoder.startsWith(wanted));
    for (const candidate of candidates) {
      try {
        await testEncode(this.ffmpeg, candidate.input, `scale=w=640:h=360${candidate.filter}`, candidate.codec(800));
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
      await testEncode(this.ffmpeg, accel.input, `scale=w=640:h=360,format=yuv420p10le${accel.hdrFilter}`, accel.hevc(800));
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
        ["-v", "error", "-select_streams", "V:0", "-read_intervals", "%+#1", "-show_entries", "frame=color_transfer:frame_side_data=max_luminance", "-print_format", "json", ...guardedProbe(absolutePath)],
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
    const videoStream = videoStreams.find((stream) => !stream.disposition?.attached_pic && !stream.disposition?.timed_thumbnails);
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

/** The peak of the mastering display in ffprobe's side data, in nits. */
function masteringPeak(sideData: unknown): number {
  const mastering = (Array.isArray(sideData) ? sideData : []).find((item) => item?.max_luminance !== undefined);
  const [value, scale] = String(mastering?.max_luminance ?? "").split("/").map(Number);
  const nits = value! / (scale || 1);
  return Number.isFinite(nits) && nits > 0 ? nits : 0;
}
