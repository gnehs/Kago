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
    // WebM holds neither H.264 nor HEVC, and the sound that goes with them.
    return format === "webm" ? { ...spec, format, videoCodec: ["h264", "hevc"].includes(spec.videoCodec) ? "auto" : spec.videoCodec, audioCodec: ["auto", "copy", "opus"].includes(spec.audioCodec) ? spec.audioCodec : "auto" } : { ...spec, format };
  }
  return specFor(format);
}

/** Whether the conversion only moves what the file holds into another container, which loses nothing and takes moments. */
export const keepsStreams = (spec: ConvertSpec) => kindOfFormat(spec.format) === "video" && spec.videoCodec === "auto" && spec.height === null && spec.crf === null && spec.fps === null;

/** A spec in a few words, for a row of a list. */
export function describeSpec(spec: ConvertSpec): string {
  const parts = [FORMAT_LABELS[spec.format] ?? spec.format];
  if (spec.height) parts.push(kindOfFormat(spec.format) === "video" ? `${spec.height}p` : `${spec.height}px`);
  if (spec.videoCodec !== "auto" && kindOfFormat(spec.format) === "video") parts.push(spec.videoCodec === "copy" ? t("no re-encoding") : VIDEO_CODEC_LABELS[spec.videoCodec]);
  if (spec.crf !== null) parts.push(`CRF ${spec.crf}`);
  if (spec.fps !== null) parts.push(`${spec.fps} fps`);
  return parts.join(" · ");
}

export const VIDEO_CODEC_LABELS: Record<Exclude<ConvertSpec["videoCodec"], "auto" | "copy">, string> = { h264: "H.264", hevc: "H.265 (HEVC)", av1: "AV1", vp9: "VP9" };
export const AUDIO_CODEC_LABELS: Record<Exclude<ConvertSpec["audioCodec"], "auto" | "copy">, string> = { aac: "AAC", opus: "Opus", mp3: "MP3", flac: "FLAC", ac3: "Dolby Digital (AC-3)" };
/** The GPUs a server may convert on, by the names their makers gave the way in. */
export const HARDWARE_LABELS: Record<string, string> = { nvenc: "NVIDIA NVENC", vaapi: "VAAPI (Intel / AMD)", videotoolbox: "Apple VideoToolbox" };

/** What each encoder settles on when no quality is asked for. */
export const DEFAULT_CRF: Record<string, number> = { auto: 23, h264: 23, hevc: 26, av1: 32, vp9: 32 };
