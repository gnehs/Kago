import { formatClock } from "@/lib/format";
import { t } from "@/lib/i18n";
import { languageLabel } from "@/lib/subtitles";
import type { MediaInfo, SubtitleTrack } from "@/types/kago";

/** One titled list of facts about a video: its picture, its audio tracks, its subtitles. */
export type VideoInfoGroup = { title: string; rows: Array<{ label: string; value: string }> };

// ffprobe's names, as people know them. Anything not listed is shown as ffprobe spells it, in capitals.
const VIDEO_CODEC: Record<string, string> = { h264: "H.264", hevc: "HEVC (H.265)", av1: "AV1", vp8: "VP8", vp9: "VP9", mpeg4: "MPEG-4", mpeg2video: "MPEG-2", mpeg1video: "MPEG-1", prores: "ProRes", dnxhd: "DNxHD", vc1: "VC-1", wmv3: "WMV 9", theora: "Theora", mjpeg: "Motion JPEG", rv40: "RealVideo 4", vvc: "VVC (H.266)" };
const AUDIO_CODEC: Record<string, string> = { aac: "AAC", mp3: "MP3", mp2: "MP2", ac3: "Dolby Digital", eac3: "Dolby Digital Plus", truehd: "Dolby TrueHD", dts: "DTS", flac: "FLAC", alac: "ALAC", opus: "Opus", vorbis: "Vorbis", wmav2: "WMA", wmapro: "WMA Pro", cook: "RealAudio" };
const SUBTITLE_CODEC: Record<string, string> = { subrip: "SRT", srt: "SRT", ass: "ASS", ssa: "SSA", webvtt: "WebVTT", mov_text: "Timed Text", text: "Text", hdmv_pgs_subtitle: "PGS", dvd_subtitle: "VobSub", dvb_subtitle: "DVB", xsub: "XSUB", eia_608: "CEA-608" };
const TRACK_FORMAT: Record<SubtitleTrack["format"], string> = { ass: "ASS", srt: "SRT", pgs: "PGS", vobsub: "VobSub", dvb: "DVB", picture: "" };
const CONTAINER: Array<[string, string]> = [["matroska", "Matroska / WebM"], ["mp4", "MP4 / QuickTime"], ["avi", "AVI"], ["mpegts", "MPEG-TS"], ["mpeg", "MPEG-PS"], ["flv", "FLV"], ["asf", "WMV / ASF"], ["rm", "RealMedia"], ["ogg", "Ogg"]];

const codecLabel = (names: Record<string, string>, codec: string) => names[codec] ?? (codec.startsWith("pcm_") ? "PCM" : codec.toUpperCase());

export function formatBitrate(bitsPerSecond: number): string {
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(bitsPerSecond >= 10_000_000 ? 1 : 2)} Mbps`;
  return `${Math.round(bitsPerSecond / 1000)} kbps`;
}

/** A level the way its standard writes it; each codec packs the number its own way. */
function levelLabel(codec: string, level: number): string {
  if (level <= 0) return "";
  if (codec === "h264") return (level / 10).toFixed(1);
  if (codec === "hevc") return (level / 30).toFixed(1);
  if (codec === "av1") return `${2 + (level >> 2)}.${level & 3}`;
  return "";
}

/** How much colour is kept beside brightness, read off ffmpeg's pixel format: `yuv420p10le` is 4:2:0. */
export function chromaSampling(pixelFormat: string): string {
  const planar = /^yuvj?a?(4\d\d)p/.exec(pixelFormat)?.[1];
  if (planar) return [...planar].join(":");
  if (/^(nv12|nv21|p01\d)/.test(pixelFormat)) return "4:2:0";
  return "";
}

function channelLabel(layout: string, channels: number): string {
  const name = layout.replace(/\(.*\)$/, "");
  if (name === "mono" || (!name && channels === 1)) return t("Mono");
  if (name === "stereo" || (!name && channels === 2)) return t("Stereo");
  if (/^\d+\.\d+/.test(name)) return name;
  return channels > 0 ? t("{count} channels", { count: channels }) : "";
}

function dynamicRange(video: NonNullable<MediaInfo["video"]>): string {
  const base = video.hdr === "pq" ? "HDR10" : video.hdr === "hlg" ? "HLG" : "";
  const parts = [video.dolbyVision > 0 ? t("Dolby Vision (profile {profile})", { profile: video.dolbyVision }) : "", base, video.hdr && video.peak > 0 ? t("{nits} nits", { nits: Math.round(video.peak) }) : ""];
  return parts.filter(Boolean).join(" · ") || "SDR";
}

const flags = (stream: { default: boolean; forced?: boolean; sdh?: boolean }) => [stream.default ? t("Default##track") : "", stream.forced ? t("Forced") : "", stream.sdh ? t("SDH") : ""];

/** A track's language, and its title unless that only repeats the language. */
const naming = (language: string, title: string) => {
  const name = languageLabel(language);
  return [name, title === name ? "" : title];
};

/**
 * What ffprobe found in a video, laid out for reading. `external` are subtitle files lying next to
 * the video, listed after the streams inside it.
 */
export function videoInfoGroups(media: MediaInfo, external: SubtitleTrack[] = []): VideoInfoGroup[] {
  const groups: VideoInfoGroup[] = [];
  const row = (label: string, value: string) => (value ? [{ label, value }] : []);
  const video = media.video;
  const container = media.container.split(",");

  const general = [
    ...(video
      ? [
          ...row(t("Resolution"), video.width > 0 && video.height > 0 ? `${video.width} × ${video.height}` : ""),
          ...row(t("Duration"), media.duration > 0 ? formatClock(media.duration) : ""),
          ...row(t("Frame rate"), video.fps > 0 ? `${Number(video.fps.toFixed(3))} fps${video.interlaced ? t(" (interlaced)") : ""}` : ""),
          ...row(t("Codec"), [codecLabel(VIDEO_CODEC, video.codec), [video.profile, levelLabel(video.codec, video.level) && `L${levelLabel(video.codec, video.level)}`].filter(Boolean).join(" @ ")].filter(Boolean).join(" · ")),
          ...row(t("Color"), [`${video.bitDepth}-bit`, chromaSampling(video.pixelFormat)].filter(Boolean).join(" · ")),
          ...row(t("Dynamic range"), dynamicRange(video)),
          ...row(t("Video bitrate"), video.bitrate > 0 ? formatBitrate(video.bitrate) : "")
        ]
      : row(t("Duration"), media.duration > 0 ? formatClock(media.duration) : "")),
    ...row(t("Total bitrate"), media.bitrate > 0 ? formatBitrate(media.bitrate) : ""),
    ...row(t("Container"), media.container ? (CONTAINER.find(([name]) => container.includes(name))?.[1] ?? container[0]!.toUpperCase()) : "")
  ];
  if (general.length > 0) groups.push({ title: t("Video"), rows: general });

  if (media.audio.length > 0) {
    groups.push({
      title: t("Audio tracks"),
      rows: media.audio.map((track, index) => ({
        label: String(index + 1),
        value: [
          ...naming(track.language, track.title),
          // The profile tells AAC-LC from HE-AAC, and DTS from DTS-HD MA.
          track.profile && track.profile.toUpperCase().startsWith(track.codec.toUpperCase()) ? track.profile : [codecLabel(AUDIO_CODEC, track.codec), track.codec === "aac" ? track.profile : ""].filter(Boolean).join(" "),
          channelLabel(track.layout, track.channels),
          track.sampleRate > 0 ? `${Number((track.sampleRate / 1000).toFixed(1))} kHz` : "",
          track.bitrate > 0 ? formatBitrate(track.bitrate) : "",
          ...(media.audio.length > 1 ? flags(track) : [])
        ]
          .filter(Boolean)
          .join(" · ")
      }))
    });
  }

  const subtitles = [
    ...media.subtitles.map((stream) => [...naming(stream.language, stream.title), codecLabel(SUBTITLE_CODEC, stream.codec), ...flags(stream)]),
    ...external.map((track) => [...naming(track.language, track.title), TRACK_FORMAT[track.format], t("External file"), ...flags({ ...track, default: false })])
  ];
  if (subtitles.length > 0) {
    groups.push({ title: t("Subtitles"), rows: subtitles.map((parts, index) => ({ label: String(index + 1), value: parts.filter(Boolean).join(" · ") })) });
  }
  return groups;
}
