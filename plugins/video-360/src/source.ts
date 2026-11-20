/**
 * What a recording is made of: which video tracks, in which files, hold which lens, and how each lens's picture
 * maps onto the sphere. Cameras lay their lenses out in a few ways, each a row of `LAYOUTS`; the first that fits the
 * tracks found is the one used.
 */

export type Crop = { x: number; y: number; w: number; h: number };

/** A video track as layout detection sees it. `file` 0 is the opened file, `i` its `i - 1`th companion. */
export type VideoTrack = { file: number; trackId: number; codec: string | null; width: number; height: number };

/** One decoder's worth of video: a track in a file. Two lenses side by side in one track share one stream. */
export type StreamRef = { file: number; trackId: number };

/** A lens: the part of a stream's picture it fills. Lens 0 faces forward, lens 1 backward. */
export type LensRef = { stream: number; crop: Crop };

export type LayoutId = "two-tracks" | "side-by-side" | "two-files" | "one-lens";

export type Plan = {
  layout: LayoutId;
  streams: StreamRef[];
  lenses: LensRef[];
  /** A recording of two lenses whose second file is not there: only the first lens can be shown. */
  missingLens: boolean;
};

/** The files of a recording, opened file first, each with its name and its playable video tracks. */
export type Recording = { name: string; videos: VideoTrack[] }[];

const whole = (track: VideoTrack): Crop => ({ x: 0, y: 0, w: track.width, h: track.height });
const sameSize = (a: VideoTrack, b: VideoTrack) => a.width === b.width && a.height === b.height;
const isSideBySide = (track: VideoTrack) => Math.abs(track.width - 2 * track.height) <= 0.05 * track.width;
/** A camera that writes each lens to a file of its own writes a file name of the kind `_00_`/`_10_` tells apart. */
const isOneOfTwoFiles = (name: string) => /_[01]0_/.test(name);

type Layout = { id: LayoutId; plan(recording: Recording): Omit<Plan, "layout" | "missingLens"> | null };

const LAYOUTS: Layout[] = [
  {
    // DJI Osmo 360, and Insta360 models that write both lenses to one file: a track for each lens.
    id: "two-tracks",
    plan: ([opened]) => {
      const [front, back] = opened?.videos ?? [];
      if (!front || !back || !sameSize(front, back)) return null;
      return { streams: [front, back], lenses: [{ stream: 0, crop: whole(front) }, { stream: 1, crop: whole(back) }] };
    }
  },
  {
    // Insta360 ONE X, X2 and X3: both lenses in one picture, the front one on the left.
    id: "side-by-side",
    plan: ([opened]) => {
      const track = opened?.videos[0];
      if (!track || opened.videos.length !== 1 || !isSideBySide(track)) return null;
      const half = Math.floor(track.width / 2);
      return { streams: [track], lenses: [{ stream: 0, crop: { x: 0, y: 0, w: half, h: track.height } }, { stream: 0, crop: { x: half, y: 0, w: half, h: track.height } }] };
    }
  },
  {
    // Insta360 ONE RS 1-inch and others that write a file per lens: `_00_` is the front lens, `_10_` the back.
    id: "two-files",
    plan: (recording) => {
      const files = recording.filter((file) => file.videos.length === 1);
      if (files.length < 2 || files.length !== recording.length) return null;
      const [front, back] = [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((file) => file.videos[0]!);
      if (!sameSize(front!, back!)) return null;
      return { streams: [front!, back!], lenses: [{ stream: 0, crop: whole(front!) }, { stream: 1, crop: whole(back!) }] };
    }
  },
  {
    id: "one-lens",
    plan: ([opened]) => {
      const track = opened?.videos[0];
      return track ? { streams: [track], lenses: [{ stream: 0, crop: whole(track) }] } : null;
    }
  }
];

/** How the recording's tracks make up a sphere, or null when it has no video to make one of. */
export function planRecording(recording: Recording): Plan | null {
  for (const layout of LAYOUTS) {
    const found = layout.plan(recording);
    if (!found) continue;
    const streams = found.streams.map(({ file, trackId }) => ({ file, trackId }));
    return { layout: layout.id, streams, lenses: found.lenses, missingLens: layout.id === "one-lens" && isOneOfTwoFiles(recording[0]!.name) };
  }
  return null;
}

/**
 * How a lens bends light onto its picture, taken as the equidistant fisheye model: a ray `theta` off the lens's axis
 * lands `theta / (fov / 2)` of the image circle's radius from its centre. These are the makers' nominal figures, not
 * a calibration of any one camera, so the seam is close rather than exact.
 */
export type Optics = {
  /** The lens's field of view, in degrees. */
  fov: number;
  /** The image circle's radius as a share of half the crop's shorter side. */
  radius: number;
  /** How far each lens's picture is turned about its axis, in degrees. */
  roll: [number, number];
};

const OPTICS: Record<string, Optics> = {
  osv: { fov: 195, radius: 0.985, roll: [0, 0] },
  insv: { fov: 195, radius: 1, roll: [0, 0] }
};

export const opticsFor = (extension: string): Optics => OPTICS[extension] ?? OPTICS.insv!;
