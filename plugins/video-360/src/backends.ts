import type { Track } from "./mp4";

/**
 * The ways a recording can be played, best first: the lenses decoded with WebCodecs and stitched here; the lenses
 * played as videos of their own, through Media Source, and stitched here; or a panorama Kago's server stitches,
 * which the browser plays as any video. WebCodecs exist only in a secure context, so Kago opened at a plain
 * http:// address other than localhost falls to the second.
 */
export type BackendId = "decoders" | "lens-videos" | "panorama";

/** What the browser can do, as the backends ask it. Null for an API it has not. */
export type Browser = {
  decodes: ((track: Track) => Promise<boolean>) | null;
  plays: ((mime: string) => boolean) | null;
};

export const lensMime = (track: Pick<Track, "kind" | "codec">) => `${track.kind === "audio" ? "audio" : "video"}/mp4; codecs="${track.codec}"`;

type Backend = { id: BackendId; usable(browser: Browser, lenses: Track[]): boolean | Promise<boolean> };

const BACKENDS: Backend[] = [
  {
    id: "decoders",
    usable: async ({ decodes }, lenses) => decodes !== null && (await Promise.all(lenses.map(decodes))).every(Boolean)
  },
  {
    id: "lens-videos",
    usable: ({ plays }, lenses) => plays !== null && lenses.every((track) => track.codec !== null && plays(lensMime(track)))
  },
  { id: "panorama", usable: ({ plays }) => plays !== null }
];

/** The first backend that can play the lenses' tracks in this browser, or null when none can. */
export async function chooseBackend(browser: Browser, lenses: Track[]): Promise<BackendId | null> {
  for (const backend of BACKENDS) if (await backend.usable(browser, lenses)) return backend.id;
  return null;
}
