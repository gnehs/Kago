/**
 * How a 360° camera's recording is stitched into one equirectangular picture by ffmpeg, for a browser that cannot
 * decode and stitch the lenses itself. Cameras lay their lenses out in a few ways, each a row of `LAYOUTS`; the first
 * that fits the video streams found is the one used. The seam is the lenses' nominal optics, not a calibration: this
 * is a preview.
 */

/** A video stream as ffprobe reports it, cover pictures already left out. `stream` is its index in its file. */
export type VideoStream = { stream: number; width: number; height: number };

/** A file of the recording, the opened one first, with its name and the video streams in it. */
export type PanoramaFile = { name: string; videos: VideoStream[] };

export type PanoramaLayout = "two-tracks" | "two-files" | "side-by-side" | "one-lens";

export type PanoramaPlan = {
  layout: PanoramaLayout;
  /** Indices into the files given, in the order ffmpeg is handed them: the front lens's file first. */
  inputs: number[];
  /** The filter graph from the inputs to the stitched picture, still unlabelled at its end. */
  graph: string;
};

/** The stitched picture, twice as wide as it is tall. */
export const PANORAMA_HEIGHT = 1440;
/** Each lens's picture is scaled to this square before stitching: about what the stitched picture keeps of it. */
const LENS_SIZE = 1920;
const FOV = 195;

const isSideBySide = (video: VideoStream) => Math.abs(video.width - 2 * video.height) <= 0.05 * video.width;
const sameSize = (a: VideoStream, b: VideoStream) => a.width === b.width && a.height === b.height;
/** The square the image circle sits in, centred in a picture a little wider than tall. */
const lens = (input: number, video: VideoStream, label: string) => `[${input}:${video.stream}]crop=w='min(iw,ih)':h='min(iw,ih)',scale=${LENS_SIZE}:${LENS_SIZE}[${label}]`;
// v360 faces the right half of a dual fisheye picture; turned round, the left half, the front lens, is the middle.
const project = (input: "dfisheye" | "fisheye") => `v360=input=${input}:output=equirect:ih_fov=${FOV}:iv_fov=${FOV}:w=${PANORAMA_HEIGHT * 2}:h=${PANORAMA_HEIGHT}${input === "dfisheye" ? ":yaw=180" : ""}:interp=linear`;
const stitchTwo = (front: [number, VideoStream], back: [number, VideoStream]) => `${lens(...front, "front")};${lens(...back, "back")};[front][back]hstack=shortest=1,${project("dfisheye")}`;

type Layout = { id: PanoramaLayout; plan(files: PanoramaFile[]): Omit<PanoramaPlan, "layout"> | null };

const LAYOUTS: Layout[] = [
  {
    // DJI Osmo 360, and Insta360 models that write both lenses to one file: a stream for each lens, front first.
    id: "two-tracks",
    plan: ([opened]) => {
      const [front, back] = opened?.videos ?? [];
      if (!front || !back || !sameSize(front, back)) return null;
      return { inputs: [0], graph: stitchTwo([0, front], [0, back]) };
    }
  },
  {
    // Insta360 ONE RS 1-inch and others that write a file per lens: `_00_` is the front lens, `_10_` the back.
    id: "two-files",
    plan: (files) => {
      if (files.length !== 2 || files.some((file) => file.videos.length !== 1)) return null;
      const order = files[0]!.name.includes("_10_") ? [1, 0] : [0, 1];
      const [front, back] = order.map((index) => files[index]!.videos[0]!);
      if (!sameSize(front!, back!)) return null;
      return { inputs: order, graph: stitchTwo([0, front!], [1, back!]) };
    }
  },
  {
    // Insta360 ONE X, X2 and X3: both lenses in one picture, the front one on the left.
    id: "side-by-side",
    plan: ([opened]) => {
      const video = opened?.videos[0];
      if (!video || opened.videos.length !== 1 || !isSideBySide(video)) return null;
      return { inputs: [0], graph: `[0:${video.stream}]scale=${LENS_SIZE * 2}:${LENS_SIZE},${project("dfisheye")}` };
    }
  },
  {
    // A lens whose other half is missing shows the half of the sphere it saw.
    id: "one-lens",
    plan: ([opened]) => {
      const video = opened?.videos[0];
      return video ? { inputs: [0], graph: `${lens(0, video, "front")};[front]${project("fisheye")}` } : null;
    }
  }
];

/** How to stitch the recording's files, or null when there is no video to stitch. */
export function planPanorama(files: PanoramaFile[]): PanoramaPlan | null {
  for (const layout of LAYOUTS) {
    const found = layout.plan(files);
    if (found) return { layout: layout.id, ...found };
  }
  return null;
}

/** ffprobe's streams of a file, as the video streams a panorama can be made of. */
export function videoStreams(streams: Array<Record<string, any>>): VideoStream[] {
  return streams
    .filter((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic && !stream.disposition?.timed_thumbnails && stream.codec_name !== "mjpeg")
    .map((stream) => ({ stream: Number(stream.index), width: Number(stream.width) || 0, height: Number(stream.height) || 0 }))
    .filter((video) => Number.isSafeInteger(video.stream) && video.width > 0 && video.height > 0);
}
