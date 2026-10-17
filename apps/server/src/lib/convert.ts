import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { hardwareEncoder, type ConvertAccel, type HardwareCodec } from "./convert-accel.js";
import { AppError, errnoIs } from "./errors.js";
import { guardedInput, guardedProbe, MEDIA_FORMATS, PICTURE_FORMATS } from "./ffmpeg-input.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/** What a file is converted to is named by the ending of its new name; each ending belongs to one kind. */
export const CONVERT_FORMATS = {
  video: ["mp4", "mkv", "mov", "webm"],
  audio: ["mp3", "m4a", "flac", "opus", "ogg", "wav"],
  image: ["jpg", "png", "webp", "avif", "gif"]
} as const;

export type ConvertKind = keyof typeof CONVERT_FORMATS;
type VideoFormat = (typeof CONVERT_FORMATS.video)[number];
type AudioFormat = (typeof CONVERT_FORMATS.audio)[number];
type ImageFormat = (typeof CONVERT_FORMATS.image)[number];

/**
 * The encoders a video can be asked for by name: the codec, then how deep its picture is where that is more than
 * eight bits, made on the CPU or (`-hw`) on the GPU.
 */
export const VIDEO_ENCODERS = ["av1", "av1-10", "av1-hw", "av1-hw-10", "h264", "h264-10", "h264-hw", "hevc", "hevc-10", "hevc-12", "hevc-hw", "hevc-hw-10", "mpeg4", "mpeg2", "vp9", "vp9-10"] as const;
export type VideoEncoderId = (typeof VIDEO_ENCODERS)[number];
type VideoCodec = "h264" | "hevc" | "av1" | "vp9" | "mpeg4" | "mpeg2";
type VideoEncoder = { codec: VideoCodec; depth: 8 | 10 | 12; gpu: boolean };

function encoderOf(name: VideoEncoderId): VideoEncoder {
  const [codec, ...rest] = name.split("-");
  return { codec: codec as VideoCodec, depth: rest.includes("12") ? 12 : rest.includes("10") ? 10 : 8, gpu: rest.includes("hw") };
}

const allFormats = [...CONVERT_FORMATS.video, ...CONVERT_FORMATS.audio, ...CONVERT_FORMATS.image] as [string, ...string[]];

/**
 * What to make of a file. Only `format` has to be said: the rest keeps what the file has where the new
 * container can hold it, and otherwise picks what plays in the most places.
 */
export const convertSpecSchema = z.object({
  format: z.enum(allFormats),
  /** The tallest a video may come out, or the longest side of a picture. A smaller one is never enlarged. */
  height: z.number().int().min(16).max(8640).nullable().default(null),
  videoCodec: z.enum(["auto", "copy", ...VIDEO_ENCODERS]).default("auto"),
  /** The encoder's constant quality: lower is better and larger. Its scale is the encoder's own. */
  crf: z.number().int().min(0).max(63).nullable().default(null),
  fps: z.number().min(1).max(240).nullable().default(null),
  audioCodec: z.enum(["auto", "copy", "aac", "opus", "mp3", "flac", "ac3"]).default("auto"),
  /** Kilobits a second for each sound track that is encoded. */
  audioBitrate: z.number().int().min(32).max(640).nullable().default(null),
  /** For a picture format that loses detail, from 1 to 100. */
  quality: z.number().int().min(1).max(100).nullable().default(null),
  /** Whether a video is decoded on the GPU where the server has one that can, and encoded there when the encoder is left open. */
  hardware: z.boolean().default(true)
});

export type ConvertSpec = z.infer<typeof convertSpecSchema>;

export const convertKindOf = (format: string): ConvertKind =>
  (CONVERT_FORMATS.video as readonly string[]).includes(format) ? "video" : (CONVERT_FORMATS.audio as readonly string[]).includes(format) ? "audio" : "image";

const words = (list: string) => new Set(list.split(" "));
const VIDEO_NAMES = words("mp4 m4v mov mkv webm avi wmv flv mpg mpeg m2ts mts ts 3gp ogv rm rmvb vob asf divx f4v");
const AUDIO_NAMES = words("mp3 m4a aac flac wav ogg oga opus wma aif aiff ape wv tta dsf dff ac3 dts mka m4b caf");
const IMAGE_NAMES = words("jpg jpeg jpe png gif webp avif bmp tif tiff heic heif jxl tga dds exr");

/** What a file is taken for when a whole folder is gone through, by the ending of its name. */
export function mediaKindOfName(name: string): ConvertKind | null {
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (VIDEO_NAMES.has(extension)) return "video";
  if (AUDIO_NAMES.has(extension)) return "audio";
  if (IMAGE_NAMES.has(extension)) return "image";
  return null;
}

/** Whether a folder's file is one a job making `format` picks up. A GIF moves, so it can become a video. */
export function feedsFormat(name: string, format: string): boolean {
  const kind = mediaKindOfName(name);
  const target = convertKindOf(format);
  if (kind === target) return true;
  return target === "video" && /\.gif$/i.test(name);
}

/** Whether a job converts the file: by the endings it was told to, or without any by what the format is made from. */
export function jobConverts(name: string, format: string, extensions: string[] | null): boolean {
  if (!extensions) return feedsFormat(name, format);
  const dot = name.lastIndexOf(".");
  return dot > 0 && extensions.includes(name.slice(dot + 1).toLowerCase());
}

/** Subtitles kept in files of their own, as the track editor takes them. */
export const SUBTITLE_FORMATS = ["srt", "ass", "webvtt", "sup", "microdvd", "subviewer", "sami"];
/** Anything a conversion may be made from: what holds sound and picture, and still pictures. Neither list has a format that names other files. */
export const CONVERT_INPUT_FORMATS = [...new Set([...MEDIA_FORMATS, ...PICTURE_FORMATS])];

export type ProbedStream = {
  index: number;
  type: "video" | "audio" | "subtitle" | "attachment" | "other";
  codec: string;
  /** As shown, after the rotation the file asks for. */
  width: number;
  height: number;
  tenBit: boolean;
  channels: number;
  /** A picture attached to the file, such as the cover of an album, and not something to watch. */
  attachedPic: boolean;
};

export type Probe = { duration: number; streams: ProbedStream[] };

export async function probeMedia(ffprobe: string, input: string, formats = CONVERT_INPUT_FORMATS): Promise<Probe> {
  let raw: string;
  try {
    raw = (await execFileAsync(ffprobe, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", ...guardedProbe(input, formats)], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  } catch {
    throw new AppError(422, "This file can’t be read as media", "MEDIA_UNREADABLE");
  }
  const data = JSON.parse(raw) as { format?: Record<string, unknown>; streams?: Array<Record<string, any>> };
  const streams = (data.streams ?? []).map((stream): ProbedStream => {
    const rotation = Number((stream.side_data_list as Array<Record<string, unknown>> | undefined)?.find((side) => side.rotation !== undefined)?.rotation ?? 0);
    const turned = Math.abs(rotation) % 180 === 90;
    const pixFmt = String(stream.pix_fmt ?? "");
    const type = String(stream.codec_type ?? "");
    return {
      index: Number(stream.index),
      type: type === "video" || type === "audio" || type === "subtitle" || type === "attachment" ? type : "other",
      codec: String(stream.codec_name ?? ""),
      width: Number(turned ? stream.height : stream.width) || 0,
      height: Number(turned ? stream.width : stream.height) || 0,
      tenBit: Number(stream.bits_per_raw_sample) > 8 || /1[026](le|be)/.test(pixFmt),
      channels: Number(stream.channels) || 0,
      attachedPic: Boolean(stream.disposition?.attached_pic || stream.disposition?.timed_thumbnails)
    };
  });
  const duration = Number(data.format?.duration);
  return { duration: Number.isFinite(duration) && duration > 0 ? duration : 0, streams };
}

/** What each container takes as it is, without encoding again. Matroska takes anything. */
const KEPT_VIDEO: Record<VideoFormat, string[] | null> = { mp4: ["h264", "hevc", "av1", "mpeg4", "vp9"], mov: ["h264", "hevc", "mpeg4", "prores", "mjpeg"], mkv: null, webm: ["vp8", "vp9", "av1"] };
const KEPT_AUDIO: Record<VideoFormat, string[] | null> = { mp4: ["aac", "mp3", "ac3", "eac3", "alac"], mov: ["aac", "mp3", "ac3", "eac3", "alac", "pcm_s16le", "pcm_s24le"], mkv: null, webm: ["opus", "vorbis"] };
const TEXT_SUBTITLES = new Set(["ass", "ssa", "subrip", "srt", "mov_text", "webvtt", "text"]);
const MUXERS: Record<string, string> = { mp4: "mp4", mkv: "matroska", mov: "mov", webm: "webm", mp3: "mp3", m4a: "ipod", flac: "flac", opus: "opus", ogg: "ogg", wav: "wav", gif: "gif", webp: "webp", avif: "avif", jpg: "image2", png: "image2" };

const even = (value: number) => Math.max(2, Math.floor(value / 2) * 2);

/** What makes each codec on the CPU. */
const SOFTWARE_ENCODERS: Record<VideoCodec, string> = { h264: "libx264", hevc: "libx265", av1: "libsvtav1", vp9: "libvpx-vp9", mpeg4: "mpeg4", mpeg2: "mpeg2video" };
const PIXEL_FORMATS = { 8: "yuv420p", 10: "yuv420p10le", 12: "yuv420p12le" } as const;

function videoEncoder({ codec, depth }: VideoEncoder, crf: number | null, format: string): string[] {
  const head = ["-c:v", SOFTWARE_ENCODERS[codec]];
  const pixels = ["-pix_fmt", PIXEL_FORMATS[depth]];
  switch (codec) {
    case "h264":
      return [...head, "-preset", "medium", "-crf", String(Math.min(crf ?? 23, 51)), ...pixels];
    case "hevc":
      return [...head, "-preset", "medium", "-crf", String(Math.min(crf ?? 26, 51)), ...pixels, "-x265-params", "log-level=error", ...(format === "mp4" || format === "mov" ? ["-tag:v", "hvc1"] : [])];
    case "av1":
      return [...head, "-preset", "8", "-crf", String(crf ?? 32), ...pixels];
    case "vp9":
      return [...head, "-crf", String(crf ?? 32), "-b:v", "0", "-row-mt", "1", "-cpu-used", "4", ...pixels];
    // The two old ones have no constant quality of that kind: theirs is a quantizer from 1 to 31.
    case "mpeg4":
    case "mpeg2":
      return [...head, "-q:v", String(Math.min(31, Math.max(1, crf ?? 4))), ...pixels];
  }
}

const AUDIO_ENCODERS: Record<string, string> = { aac: "aac", opus: "libopus", mp3: "libmp3lame", flac: "flac", ac3: "ac3" };

/** Whether making `spec` of the file would put the GPU to work, so that a failure there is worth a second go without it. */
export function usesHardware(spec: ConvertSpec, accel: ConvertAccel | null): accel is ConvertAccel {
  if (accel === null || convertKindOf(spec.format) !== "video" || spec.videoCodec === "copy") return false;
  return spec.hardware || (spec.videoCodec !== "auto" && encoderOf(spec.videoCodec).gpu);
}

/**
 * The arguments that make `output` out of `input`. Throws when the file has nothing the format could hold.
 * With `accel` a video that is encoded again is decoded on the GPU, and encoded there when the GPU makes the codec.
 */
export function convertArgs(spec: ConvertSpec, probe: Probe, input: string, output: string, accel: ConvertAccel | null = null): string[] {
  const flags = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats"];
  const head = [...flags, ...guardedInput(input, CONVERT_INPUT_FORMATS)];
  const kind = convertKindOf(spec.format);
  const picture = probe.streams.find((stream) => stream.type === "video" && !stream.attachedPic);
  const sound = probe.streams.filter((stream) => stream.type === "audio");
  const tail = ["-f", MUXERS[spec.format]!, output];

  if (kind === "audio") {
    const [first] = sound;
    if (!first) throw new AppError(422, "This file has no sound to convert", "CONVERT_NO_AUDIO");
    const format = spec.format as AudioFormat;
    const native: Record<AudioFormat, string[]> = { mp3: ["mp3"], m4a: ["aac", "alac"], flac: ["flac"], opus: ["opus"], ogg: ["vorbis", "opus"], wav: ["pcm_s16le", "pcm_s24le"] };
    const rate = (fallback: number) => ["-b:a", `${spec.audioBitrate ?? fallback}k`];
    const encoders: Record<AudioFormat, string[]> = {
      mp3: ["-c:a", "libmp3lame", ...rate(192)],
      m4a: ["-c:a", "aac", ...rate(192)],
      flac: ["-c:a", "flac"],
      opus: ["-c:a", "libopus", ...rate(128), "-af", OPUS_LAYOUTS],
      ogg: ["-c:a", "libvorbis", ...(spec.audioBitrate ? rate(160) : ["-q:a", "5"])],
      wav: ["-c:a", "pcm_s16le"]
    };
    const kept = spec.audioBitrate === null && native[format].includes(first.codec);
    // The cover goes along where the format has a place for one.
    const cover = ["mp3", "m4a", "flac"].includes(format) ? probe.streams.find((stream) => stream.type === "video" && stream.attachedPic && ["mjpeg", "png"].includes(stream.codec)) : undefined;
    return [...head, "-map", `0:${first.index}`, ...(cover ? ["-map", `0:${cover.index}`, "-c:v", "copy", "-disposition:v:0", "attached_pic"] : ["-vn"]), ...(kept ? ["-c:a", "copy"] : encoders[format]), "-sn", "-dn", ...tail];
  }

  if (!picture) throw new AppError(422, "This file has no picture to convert", "CONVERT_NO_VIDEO");

  if (kind === "image") {
    const format = spec.format as ImageFormat;
    const side = spec.height;
    // Held to its longest side, whichever way it lies.
    const fit = side ? [`scale=w='if(gte(iw,ih),min(iw,${side}),-1)':h='if(gte(iw,ih),-1,min(ih,${side}))':flags=lanczos`] : [];
    if (format === "gif") {
      const filters = [...(spec.fps || probe.duration > 0 ? [`fps=${Math.min(spec.fps ?? 15, 50)}`] : []), ...fit, "split[a][b];[a]palettegen[p];[b][p]paletteuse"];
      // What the filters make is what gets written; nothing else of the file is asked for.
      return [...head, "-filter_complex", `[0:${picture.index}]${filters.join(",")}`, "-loop", "0", ...tail];
    }
    const quality = spec.quality ?? 85;
    const still: Record<Exclude<ImageFormat, "gif">, string[]> = {
      jpg: ["-c:v", "mjpeg", "-q:v", String(Math.min(31, Math.max(2, Math.round(((100 - quality) / 100) * 29) + 2))), "-pix_fmt", "yuvj420p", "-update", "1"],
      png: ["-c:v", "png", "-update", "1"],
      webp: ["-c:v", "libwebp", "-quality", String(quality)],
      avif: ["-c:v", "libsvtav1", "-crf", String(Math.min(63, Math.max(1, Math.round(((100 - quality) / 100) * 62)))), "-pix_fmt", "yuv420p"]
    };
    // What the AV1 encoder takes has sides of even length.
    const filters = [...fit, ...(format === "avif" ? ["scale=trunc(iw/2)*2:trunc(ih/2)*2"] : [])];
    return [...head, "-map", `0:${picture.index}`, "-frames:v", "1", ...(filters.length ? ["-vf", filters.join(",")] : []), ...still[format], "-an", "-sn", "-dn", ...tail];
  }

  const format = spec.format as VideoFormat;
  const shrink = spec.height !== null && picture.height > spec.height;
  const filtered = shrink || spec.fps !== null;
  const keepable = KEPT_VIDEO[format]?.includes(picture.codec) ?? true;
  const copy = spec.videoCodec === "copy" || (spec.videoCodec === "auto" && !filtered && spec.crf === null && keepable);
  if (copy && !keepable) throw new AppError(422, "This video can’t be kept as it is in that format", "CONVERT_COPY_UNSUPPORTED");
  // Left open, it is what plays in the most places. A picture of ten bits keeps them: it is how HDR survives being encoded again.
  const encoder: VideoEncoder | null = copy
    ? null
    : spec.videoCodec === "auto" || spec.videoCodec === "copy"
      ? format === "webm" ? { codec: "vp9", depth: 8, gpu: false } : picture.tenBit ? { codec: "hevc", depth: 10, gpu: spec.hardware } : { codec: "h264", depth: 8, gpu: spec.hardware }
      : encoderOf(spec.videoCodec);
  if (encoder && format === "webm" && encoder.codec !== "vp9" && encoder.codec !== "av1") throw new AppError(422, "WebM holds only VP9 or AV1 video", "CONVERT_CODEC_UNSUPPORTED");

  const gpu = encoder && usesHardware(spec, accel) ? accel : null;
  const args = [...flags, ...(gpu?.input ?? []), ...guardedInput(input, CONVERT_INPUT_FORMATS), "-map", `0:${picture.index}`];
  if (!encoder) args.push("-c:v", "copy", ...(picture.codec === "hevc" && (format === "mp4" || format === "mov") ? ["-tag:v", "hvc1"] : []));
  else {
    // The encoders want sides of even length, which a GIF need not have.
    const filters = [...(spec.fps !== null ? [`fps=${spec.fps}`] : []), shrink ? `scale=-2:${even(spec.height!)}` : "scale=trunc(iw/2)*2:trunc(ih/2)*2"];
    // An encoder of the GPU's that is asked for where there is none, or after it failed, is made up for by the CPU's of the same codec.
    const made = gpu && encoder.gpu && encoder.depth !== 12 ? (encoder.depth === 10 ? gpu.deep : gpu.codecs) : [];
    const onGpu = gpu && made.includes(encoder.codec as HardwareCodec) ? hardwareEncoder(gpu, encoder.codec as HardwareCodec, spec.crf, encoder.depth === 10, format) : null;
    args.push("-vf", [...filters, ...(onGpu?.filter ?? [])].join(","), ...(onGpu?.args ?? videoEncoder(encoder, spec.crf, format)));
  }

  sound.forEach((stream, position) => {
    args.push("-map", `0:${stream.index}`);
    const kept = KEPT_AUDIO[format]?.includes(stream.codec) ?? true;
    let audio = spec.audioCodec;
    if (audio === "auto") audio = kept && spec.audioBitrate === null ? "copy" : format === "webm" ? "opus" : "aac";
    if (audio === "copy") {
      if (!kept) throw new AppError(422, "This sound can’t be kept as it is in that format", "CONVERT_COPY_UNSUPPORTED");
      args.push(`-c:a:${position}`, "copy");
      return;
    }
    args.push(`-c:a:${position}`, AUDIO_ENCODERS[audio]!);
    if (audio !== "flac") args.push(`-b:a:${position}`, `${spec.audioBitrate ?? (stream.channels > 2 ? 384 : 160)}k`);
    if (audio === "opus") args.push(`-filter:a:${position}`, OPUS_LAYOUTS);
  });

  // Subtitles go along in the one form the container has for them; drawn ones only Matroska can hold.
  const subtitles = probe.streams.filter((stream) => stream.type === "subtitle" && (format === "mkv" || TEXT_SUBTITLES.has(stream.codec)));
  subtitles.forEach((stream, position) => {
    args.push("-map", `0:${stream.index}`, `-c:s:${position}`, format === "mkv" ? (stream.codec === "mov_text" ? "srt" : "copy") : format === "webm" ? "webvtt" : "mov_text");
  });
  if (format === "mkv") args.push("-map", "0:t?", "-c:t", "copy");
  if (format === "mp4" || format === "mov") args.push("-movflags", "+faststart");
  return [...args, "-dn", ...tail];
}

/** The encoder each format and codec is made with: one this build of ffmpeg lacks cannot be asked for. */
const NEEDED: { formats: Record<string, string[]>; audioCodecs: Record<string, string> } = {
  formats: { mp4: ["libx264", "aac"], mkv: ["libx264", "aac"], mov: ["libx264", "aac"], webm: ["libvpx-vp9", "libopus"], mp3: ["libmp3lame"], m4a: ["aac"], flac: ["flac"], opus: ["libopus"], ogg: ["libvorbis"], wav: [], jpg: [], png: [], webp: ["libwebp"], avif: ["libsvtav1"], gif: [] },
  audioCodecs: AUDIO_ENCODERS
};

/** `videoCodecs` names the encoders of `VIDEO_ENCODERS` that can be asked for. */
export type ConvertSupport = { available: boolean; formats: string[]; videoCodecs: string[]; audioCodecs: string[]; /** The GPU conversions can use and the codecs it encodes; null without one. */ hardware: { device: string; codecs: string[] } | null };

/** The pictures an encoder takes, as this build of ffmpeg tells them; null when it does not say. */
async function pixelFormats(ffmpeg: string, encoder: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync(ffmpeg, ["-hide_banner", "-h", `encoder=${encoder}`], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 });
    const listed = /Supported pixel formats:(.*)/.exec(stdout)?.[1];
    return listed ? words(listed.trim()) : null;
  } catch {
    return null;
  }
}

/** What this server's ffmpeg can make on the CPU. Nothing at all without one. */
export async function convertSupport(ffmpeg: string): Promise<ConvertSupport> {
  let listed: string;
  try {
    listed = (await execFileAsync(ffmpeg, ["-hide_banner", "-encoders"], { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 })).stdout;
  } catch {
    return { available: false, formats: [], videoCodecs: [], audioCodecs: [], hardware: null };
  }
  const encoders = new Set(listed.split("\n").map((line) => line.trim().split(/\s+/)[1] ?? ""));
  const has = (name: string) => encoders.has(name);
  // A deeper picture is something an encoder is built for or not.
  const software = VIDEO_ENCODERS.map(encoderOf).filter((encoder) => !encoder.gpu && has(SOFTWARE_ENCODERS[encoder.codec]));
  const deep = new Map<string, Set<string> | null>();
  for (const name of new Set(software.filter((encoder) => encoder.depth > 8).map((encoder) => SOFTWARE_ENCODERS[encoder.codec]))) deep.set(name, await pixelFormats(ffmpeg, name));
  return {
    available: true,
    hardware: null,
    formats: Object.entries(NEEDED.formats).filter(([, needed]) => needed.every(has)).map(([format]) => format),
    videoCodecs: software.filter((encoder) => encoder.depth === 8 || (deep.get(SOFTWARE_ENCODERS[encoder.codec])?.has(PIXEL_FORMATS[encoder.depth]) ?? true)).map((encoder) => (encoder.depth === 8 ? encoder.codec : `${encoder.codec}-${encoder.depth}`)),
    audioCodecs: Object.entries(NEEDED.audioCodecs).filter(([, needed]) => has(needed)).map(([codec]) => codec)
  };
}

/** libopus refuses the side-channel layouts films are mixed in; they are told apart as the nearest it takes. */
const OPUS_LAYOUTS = "aformat=channel_layouts=7.1|5.1|stereo|mono";

/** One source of a file put together again from several. `map` is ffmpeg's own way of naming streams in it. */
export type RemuxInput = { input: string; formats: string[] };
export type RemuxTrack = { input: number; map: string; codec?: string; language?: string; title?: string; default?: boolean; forced?: boolean; type: "video" | "audio" | "subtitle" };

/** The arguments that pack the given tracks into a Matroska file without encoding any of them again. */
export function remuxArgs(inputs: RemuxInput[], tracks: RemuxTrack[], options: { attachments: boolean; chapters: boolean; title?: string }, output: string): string[] {
  const args = ["-nostdin", "-hide_banner", "-loglevel", "error", "-y", "-progress", "pipe:1", "-nostats"];
  for (const { input, formats } of inputs) args.push(...guardedInput(input, formats));
  const counts = { video: 0, audio: 0, subtitle: 0 };
  const letters = { video: "v", audio: "a", subtitle: "s" } as const;
  tracks.forEach((track) => {
    const position = counts[track.type]++;
    const stream = `${letters[track.type]}:${position}`;
    args.push("-map", `${track.input}:${track.map}`, `-c:${stream}`, track.codec ?? "copy");
    if (track.language !== undefined) args.push(`-metadata:s:${stream}`, `language=${track.language || "und"}`);
    if (track.title !== undefined) args.push(`-metadata:s:${stream}`, `title=${track.title}`);
    if (track.default !== undefined || track.forced !== undefined) args.push(`-disposition:${stream}`, [track.default ? "default" : "", track.forced ? "forced" : ""].filter(Boolean).join("+") || "0");
  });
  if (options.attachments) args.push("-map", "0:t?", "-c:t", "copy");
  args.push("-map_metadata", "0", "-map_chapters", options.chapters ? "0" : "-1");
  if (options.title !== undefined) args.push("-metadata", `title=${options.title}`);
  return [...args, "-dn", "-f", "matroska", output];
}

/** Thrown out of `runFfmpeg` when `stopped` said to give up. */
export class ConvertStopped extends Error {}

/**
 * Runs ffmpeg to its end. `onSeconds` hears how far into the output it has got; `stopped` is asked now and then
 * whether to go on, and ends it when not. What ffmpeg complained of goes to the log, not to whoever asked.
 */
export function runFfmpeg(ffmpeg: string, args: string[], onSeconds: (seconds: number) => void, stopped: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"] });
    let complaint = "";
    let cancelled = false;
    let pending = "";
    const watch = setInterval(() => {
      if (!stopped()) return;
      cancelled = true;
      child.kill("SIGKILL");
    }, 300);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const match = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (match) onSeconds(Number(match[1]) / 1_000_000);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      complaint = (complaint + chunk).slice(-4000);
    });
    child.once("error", (error) => {
      clearInterval(watch);
      reject(errnoIs(error, "ENOENT") ? new AppError(501, "ffmpeg is not installed on the server", "FFMPEG_MISSING") : error);
    });
    child.once("close", (code) => {
      clearInterval(watch);
      if (cancelled) return reject(new ConvertStopped());
      if (code === 0) return resolve();
      logger.warn("ffmpeg could not convert a file", { code, complaint: complaint.trim() });
      reject(new AppError(422, "This file couldn’t be converted", "CONVERT_FAILED"));
    });
  });
}

