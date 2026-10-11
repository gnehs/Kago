import type { MediaInfo } from "@/types/kago";

type CanPlayType = (type: string) => string;

const HEVC_MAIN10_HDR = "hvc1.2.4.L153.B0";

const AUDIO_CODECS: Record<string, string> = {
  aac: "mp4a.40.2",
  mp3: "mp3",
  opus: "opus",
  vorbis: "vorbis",
  flac: "flac",
  ac3: "ac-3",
  eac3: "ec-3"
};

const SIMPLE_VIDEO_CODECS: Record<string, string> = {
  vp8: "vp8",
  vp9: "vp09.00.40.08",
  av1: "av01.0.08M.08"
};

const TEN_BIT_VIDEO_CODECS: Record<string, string> = {
  vp9: "vp09.02.40.10",
  av1: "av01.0.08M.10"
};

// These are the H.264 level_idc values defined by the standard. ffprobe reports them as
// decimal values (for example, 41 is Level 4.1), while RFC 6381 codec strings use hex.
const H264_LEVELS = new Set([10, 11, 12, 13, 20, 21, 22, 30, 31, 32, 40, 41, 42, 50, 51, 52, 60, 61, 62]);

// ffprobe reports HEVC's general_level_idc directly (153 is Level 5.1).
const HEVC_LEVELS = new Set([30, 60, 63, 90, 93, 120, 123, 150, 153, 156, 180, 183, 186]);

/** The profile_idc and profile-iop bytes used in RFC 6381 AVC codec strings. */
const H264_PROFILES: Record<string, string> = {
  constrainedbaseline: "42c0",
  // ffprobe exposes the Baseline profile name, not the profile-iop constraint flags.
  baseline: "4200",
  main: "4d00",
  high: "6400"
};

function normalizedProfile(profile: unknown): string {
  return typeof profile === "string" ? profile.trim().toLowerCase().replace(/[\s_-]+/g, "") : "";
}

function h264Codec(profile: string, level: number): string | null {
  const profilePrefix = H264_PROFILES[normalizedProfile(profile)];
  if (!profilePrefix || !H264_LEVELS.has(level)) return null;
  return `avc1.${profilePrefix}${level.toString(16).padStart(2, "0")}`;
}

type HevcProfile = { profileIdc: 1 | 2; compatibility: 4 | 6 };

function hevcProfile(profile: string): HevcProfile | null {
  switch (normalizedProfile(profile)) {
    case "main":
      return { profileIdc: 1, compatibility: 6 };
    case "main10":
      return { profileIdc: 2, compatibility: 4 };
    default:
      return null;
  }
}

function hevcCodec(profile: HevcProfile, level: number): string {
  // Do not invent the optional constraint flags; MediaInfo currently does not expose them.
  return `hvc1.${profile.profileIdc}.${profile.compatibility}.L${level}`;
}

/** ffprobe pixel formats that identify common 4:2:0, 4:2:2, and 4:4:4 layouts. */
function chromaSampling(pixelFormat: string): string {
  const planar = /^yuvj?a?(4\d\d)p/.exec(pixelFormat)?.[1];
  if (planar) return [...planar].join(":");
  if (/^(nv12|nv21|p01\d)/.test(pixelFormat)) return "4:2:0";
  return "";
}

function defaultCanPlayType(type: string): string {
  if (typeof document === "undefined") return "";
  return document.createElement("video").canPlayType(type);
}

/** Whether this browser can play the file untouched, based on its container and stream metadata. */
export function canDirectPlay(info: MediaInfo, canPlayType: CanPlayType = defaultCanPlayType): boolean {
  if (!info.video) return true;

  const video = info.video;
  const audio = info.audio[0];
  const audioCodec = audio ? AUDIO_CODECS[audio.codec] : "";
  if (audioCodec === undefined || video.bitDepth > 10) return false;

  let videoCodec: string | null = null;
  if (video.codec === "h264") {
    // Chrome's common AVC decoders accept 8-bit 4:2:0. Missing/unsupported profile or level
    // data is not a reason to guess a generic High@4.0 codec string.
    if (video.bitDepth !== 8) return false;
    videoCodec = h264Codec(video.profile, video.level);
  } else if (video.codec === "hevc") {
    const profile = hevcProfile(video.profile);
    if (!profile || !HEVC_LEVELS.has(video.level)) return false;
    // Main is an 8-bit profile. Main 10 must stay a Main 10 probe even if the picture happens
    // to use only 8 bits; a missing bit-depth value is not evidence that it is Main.
    if ((profile.profileIdc === 1 && video.bitDepth !== 8) || (profile.profileIdc === 2 && video.bitDepth !== 8 && video.bitDepth !== 10)) return false;

    const mainTierType = `video/mp4; codecs="${hevcCodec(profile, video.level)}"`;
    if (canPlayType(mainTierType) === "") return false;

    // MediaInfo does not report HEVC tier, so this is a capability prediction using Main tier.
    // A source may still be High tier; playback errors and the progress watchdog handle that case.
    videoCodec = hevcCodec(profile, video.level);
  } else {
    const codecMap = video.bitDepth > 8 ? TEN_BIT_VIDEO_CODECS : SIMPLE_VIDEO_CODECS;
    videoCodec = codecMap[video.codec] ?? null;
  }

  if (!videoCodec) return false;
  // Cameras and screen recorders can keep more chroma than browsers commonly decode.
  if (!(["", "4:2:0"].includes(chromaSampling(video.pixelFormat))) || /^(rgb|bgr|gbr|gray)/.test(video.pixelFormat)) return false;

  const container = info.container.split(",");
  let mime: string;
  if (container.includes("mp4") || container.includes("mov")) {
    mime = "video/mp4";
  } else if (container.includes("matroska") || container.includes("webm")) {
    // WebM is the one kind of Matroska browsers play. Other MKV files need remuxing or transcoding.
    if (!["vp8", "vp9", "av1"].includes(video.codec) || (audio && !["opus", "vorbis"].includes(audio.codec))) return false;
    mime = "video/webm";
  } else {
    return false;
  }

  const codecs = [videoCodec, audioCodec].filter(Boolean).join(", ");
  return canPlayType(`${mime}; codecs="${codecs}"`) !== "";
}

type MediaSourceSupport = { isTypeSupported(type: string): boolean };

/** Whether the browser can take the server's 10-bit Main 10 HEVC HDR stream. */
export function canPlayHdrStream(): boolean {
  const type = `video/mp4; codecs="${HEVC_MAIN10_HDR}"`;
  const globals = globalThis as typeof globalThis & {
    ManagedMediaSource?: MediaSourceSupport;
    MediaSource?: MediaSourceSupport;
  };
  const source = globals.ManagedMediaSource ?? globals.MediaSource;
  if (source) return source.isTypeSupported(type);
  return typeof document !== "undefined" && document.createElement("video").canPlayType(type) !== "";
}
