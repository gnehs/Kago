import type { MediaEncoder as Encoder, HdrTransfer as Hdr } from "@kago/contract";

/** How one encoder is driven: what goes before the input, after the scaler, and in place of libx264. */
export type Accel = {
  encoder: Encoder;
  input: string[];
  /** The part of `input` that goes before each file: a second file is decoded on the GPU too. */
  decode: string[];
  filter: string;
  codec: (maxKbps: number) => string[];
  /** The same two for HDR output, which is 10-bit HEVC. */
  hdrFilter: string;
  hevc: (maxKbps: number) => string[];
};

/** A filter chain that turns an HDR picture into BT.709 SDR. */
export type Tonemap = { name: string; filter: (hdr: Hdr) => string };

export const TRANSFER: Record<Hdr, string> = { pq: "smpte2084", hlg: "arib-std-b67" };

/**
 * Browsers show PQ with 203 nits as the white of the page; players that follow Apple's convention put 100 nits
 * there, a stop brighter. A film graded dark then looks dull next to a page. Lifting by the ratio of the two
 * makes up the difference.
 */
const LIFT_GAIN = 2.03;

/**
 * Decoding is offloaded where it can be but frames come back to system memory for scaling, so a
 * source the GPU cannot decode quietly falls back to the CPU instead of breaking the filter chain.
 */
export function accelFor(encoder: Encoder, device = ""): Accel {
  const rate = (maxKbps: number) => ["-b:v", `${Math.round(maxKbps * 0.7)}k`, "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`];
  // Segment boundaries get forced keyframes; the encoder's own cadence (as short as 12 frames by default) only costs bitrate.
  const gop = ["-g", "300"];
  switch (encoder) {
    case "nvenc":
      return {
        encoder,
        input: ["-hwaccel", "cuda"],
        decode: ["-hwaccel", "cuda"],
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
        decode: ["-hwaccel", "vaapi", "-hwaccel_device", "va"],
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
        decode: ["-hwaccel", "videotoolbox"],
        filter: "",
        codec: (maxKbps) => ["-c:v", "h264_videotoolbox", ...gop, "-b:v", `${Math.round(maxKbps * 0.7)}k`, "-pix_fmt", "yuv420p", "-profile:v", "high"],
        hdrFilter: "",
        hevc: (maxKbps) => ["-c:v", "hevc_videotoolbox", ...gop, "-b:v", `${Math.round(maxKbps * 0.7)}k`, "-pix_fmt", "p010le", "-profile:v", "main10"]
      };
    default:
      return {
        encoder: "software",
        input: [],
        decode: [],
        filter: "",
        codec: (maxKbps) => ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`, "-pix_fmt", "yuv420p", "-profile:v", "high"],
        hdrFilter: "",
        hevc: (maxKbps) => ["-c:v", "libx265", ...gop, "-preset", "superfast", "-crf", "25", "-maxrate", `${maxKbps}k`, "-bufsize", `${maxKbps * 2}k`, "-pix_fmt", "yuv420p10le", "-x265-params", "log-level=error"]
      };
  }
}

/**
 * Brightens a PQ picture in linear light: `LIFT_GAIN` times as bright in the shadows and midtones, easing off
 * towards the mastering peak, which stays where it was so the stream's metadata still describes it. A gain on
 * light is a gain on each of red, green and blue, so the three go through one lookup table.
 */
export function liftFilter(peakNits: number): string {
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
export const TONEMAPS: Tonemap[] = [
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
