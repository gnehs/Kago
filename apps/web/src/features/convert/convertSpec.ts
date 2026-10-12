import { extensionOf, fileKind } from "@/lib/fileKind";
import type { ConvertSpec, ConvertSupport, FileItem } from "@/types/kago";
import { t } from "@/lib/i18n";

export type MediaKind = "video" | "audio" | "image";

/** The formats a file can be converted to, by the kind of thing each holds. The server knows the same lists. */
export const CONVERT_FORMATS: Record<MediaKind, string[]> = {
  video: ["mp4", "mkv", "mov", "webm"],
  audio: ["mp3", "m4a", "flac", "opus", "ogg", "wav"],
  image: ["jpg", "png", "webp", "avif", "gif"]
};

export const FORMAT_LABELS: Record<string, string> = {
  mp4: "MP4", mkv: "MKV", mov: "MOV", webm: "WebM",
  mp3: "MP3", m4a: "M4A (AAC)", flac: "FLAC", opus: "Opus", ogg: "Ogg Vorbis", wav: "WAV",
  jpg: "JPEG", png: "PNG", webp: "WebP", avif: "AVIF", gif: "GIF"
};

/** The endings an auto-convert takes for each kind until it is told others. */
export const DEFAULT_EXTENSIONS: Record<MediaKind, string[]> = {
  video: ["mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg", "m2ts", "mts", "ts", "3gp", "rmvb"],
  audio: ["mp3", "m4a", "aac", "flac", "wav", "ogg", "opus", "wma", "aiff", "ape"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "bmp", "tiff", "heic"]
};

/** What was typed as a list of endings, however they were set apart: `.MKV, *.mp4 avi` is three. */
export function parseExtensions(text: string): string[] {
  return [...new Set(text.split(/[\s,;、，]+/).map((word) => word.replace(/^\*?\./, "").toLowerCase()).filter((word) => /^[a-z0-9]{1,16}$/.test(word)))];
}

export const kindOfFormat = (format: string): MediaKind => (CONVERT_FORMATS.video.includes(format) ? "video" : CONVERT_FORMATS.audio.includes(format) ? "audio" : "image");

export const kindLabels: Record<MediaKind, string> = { video: t("Video"), audio: t("Audio"), image: t("Image") };

/** What kind of media a file is, when it is one that can be converted. */
export function mediaKindOf(item: Pick<FileItem, "kind" | "type" | "name">): MediaKind | null {
  const kind = fileKind(item);
  return kind === "video" || kind === "audio" || kind === "image" ? kind : null;
}

/** What files of a kind can become: a video can give up its sound or be looped as a GIF, and a GIF can become a video. */
export function targetFormats(kind: MediaKind, names: string[] = []): Record<MediaKind, string[]> {
  if (kind === "video") return { video: CONVERT_FORMATS.video, audio: CONVERT_FORMATS.audio, image: ["gif", "jpg", "png"] };
  if (kind === "audio") return { video: [], audio: CONVERT_FORMATS.audio, image: [] };
  return { video: names.length > 0 && names.every((name) => extensionOf(name) === "gif") ? CONVERT_FORMATS.video : [], audio: [], image: CONVERT_FORMATS.image };
}

/** The same lists without what this server's ffmpeg cannot make. */
export function supportedFormats(formats: Record<MediaKind, string[]>, support: ConvertSupport | undefined): Record<MediaKind, string[]> {
  if (!support) return formats;
  const kept = (list: string[]) => list.filter((format) => support.formats.includes(format));
  return { video: kept(formats.video), audio: kept(formats.audio), image: kept(formats.image) };
}

export const specFor = (format: string): ConvertSpec => ({ format, height: null, videoCodec: "auto", crf: null, fps: null, audioCodec: "auto", audioBitrate: null, quality: null, hardware: true });

/** A spec moved to another format: what the new one has no use for is let go. */
export function withFormat(spec: ConvertSpec, format: string): ConvertSpec {
  if (kindOfFormat(format) === kindOfFormat(spec.format) && format !== "gif" && spec.format !== "gif") {
    // WebM holds only VP9 and AV1, and the sound that goes with them.
    return format === "webm" ? { ...spec, format, videoCodec: ["auto", "copy", "vp9", "av1"].includes(codecOf(spec.videoCodec)) ? spec.videoCodec : "auto", audioCodec: ["auto", "copy", "opus"].includes(spec.audioCodec) ? spec.audioCodec : "auto" } : { ...spec, format };
  }
  return specFor(format);
}

/** Whether the conversion only moves what the file holds into another container, which loses nothing and takes moments. */
export const keepsStreams = (spec: ConvertSpec) => kindOfFormat(spec.format) === "video" && spec.videoCodec === "auto" && spec.height === null && spec.crf === null && spec.fps === null;

/** A spec in a few words, for a row of a list. */
export function describeSpec(spec: ConvertSpec, device?: string): string {
  const parts = [FORMAT_LABELS[spec.format] ?? spec.format];
  if (spec.height) parts.push(kindOfFormat(spec.format) === "video" ? `${spec.height}p` : `${spec.height}px`);
  if (spec.videoCodec !== "auto" && kindOfFormat(spec.format) === "video") parts.push(spec.videoCodec === "copy" ? t("no re-encoding") : videoEncoderLabel(spec.videoCodec, device));
  if (spec.crf !== null) parts.push(`CRF ${spec.crf}`);
  if (spec.fps !== null) parts.push(`${spec.fps} fps`);
  return parts.join(" · ");
}

export type VideoEncoderId = Exclude<ConvertSpec["videoCodec"], "auto" | "copy">;
/** The encoders in the order they are offered. */
export const VIDEO_ENCODERS: VideoEncoderId[] = ["av1", "av1-10", "av1-hw", "av1-hw-10", "h264", "h264-10", "h264-hw", "hevc", "hevc-10", "hevc-12", "hevc-hw", "hevc-hw-10", "mpeg4", "mpeg2", "vp9", "vp9-10"];

/** The codec an encoder makes. */
export const codecOf = (encoder: string) => encoder.split("-")[0]!;

const CODEC_NAMES: Record<string, string> = { av1: "AV1", h264: "H.264", hevc: "H.265", mpeg4: "MPEG-4", mpeg2: "MPEG-2", vp9: "VP9" };
/** The libraries that make each codec on the CPU, where the name tells one encoder from another. */
const SOFTWARE_NAMES: Record<string, string> = { av1: "SVT", h264: "x264", hevc: "x265" };
const HARDWARE_NAMES: Record<string, string> = { nvenc: "NVEnc", vaapi: "VAAPI", videotoolbox: "VideoToolbox" };

/** An encoder as it is listed: `H.265 10-bit (x265)`. `device` is the server's GPU, which names those made on it. */
export function videoEncoderLabel(encoder: VideoEncoderId, device?: string): string {
  const [codec, ...rest] = encoder.split("-");
  const depth = rest.find((part) => part !== "hw");
  const maker = rest.includes("hw") ? (HARDWARE_NAMES[device ?? ""] ?? "GPU") : SOFTWARE_NAMES[codec!];
  return [CODEC_NAMES[codec!], depth ? `${depth}-bit` : null, maker ? `(${maker})` : null].filter(Boolean).join(" ");
}
export const AUDIO_CODEC_LABELS: Record<Exclude<ConvertSpec["audioCodec"], "auto" | "copy">, string> = { aac: "AAC", opus: "Opus", mp3: "MP3", flac: "FLAC", ac3: "Dolby Digital (AC-3)" };
/** The GPUs a server may convert on, by the names their makers gave the way in. */
export const HARDWARE_LABELS: Record<string, string> = { nvenc: "NVIDIA NVENC", vaapi: "VAAPI (Intel / AMD)", videotoolbox: "Apple VideoToolbox" };

/** What each codec's encoders settle on when no quality is asked for, and the most that can be. The two old ones count a quantizer. */
export const DEFAULT_CRF: Record<string, number> = { auto: 23, h264: 23, hevc: 26, av1: 32, vp9: 32, mpeg4: 4, mpeg2: 4 };
export const MAX_CRF: Record<string, number> = { av1: 63, vp9: 63, mpeg4: 31, mpeg2: 31 };
