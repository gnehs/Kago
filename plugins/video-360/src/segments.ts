import type { PanoramaInfo } from "@kago/plugin-sdk";

/**
 * The segments of a panorama in the page's SourceBuffer: `start` up to, not including, `next`, one unbroken run of
 * them. A seek outside the run starts a new one, since the server encodes from wherever it is asked.
 */
export type Run = { start: number; next: number };

/** How far past the playhead segments are fetched, in seconds. The server stops encoding a good way past that. */
export const AHEAD = 18;
/** How much is kept behind the playhead, so a short step back plays at once. */
export const BEHIND = 12;

/** The segment that holds a moment. The last one runs to the end, however long. */
export const segmentAt = (time: number, info: PanoramaInfo) => Math.max(0, Math.min(info.segmentCount - 1, Math.floor(time / info.segmentSeconds)));

/** The segment to fetch next, or null while the run reaches far enough past the playhead, or to the end. */
export function nextSegment(run: Run, playhead: number, info: PanoramaInfo): number | null {
  return run.next < info.segmentCount && run.next * info.segmentSeconds < playhead + AHEAD ? run.next : null;
}

/** The first segment worth keeping: everything before it is long past. */
export const keepFrom = (run: Run, playhead: number, info: PanoramaInfo) => Math.min(run.next, Math.max(run.start, segmentAt(playhead - BEHIND, info)));

/**
 * The SourceBuffer's timestampOffset that puts a segment where its number says, given the time its own timeline
 * starts it at. Each run of the server's encoder counts from 0, and the server starts a new one when it is asked
 * for a segment it is not on its way to; a segment that follows on from the last keeps its offset, so a run's
 * segments join without a gap.
 */
export function placement(index: number, start: number, offset: number | null, info: PanoramaInfo): number {
  const due = index * info.segmentSeconds;
  return offset !== null && Math.abs(start + offset - due) < info.segmentSeconds / 2 ? offset : due - start;
}

/**
 * Where a seek lands: inside the run, or at the next segment it will fetch anyway, is played from what is there;
 * anywhere else is the segment a new run starts from.
 */
export function seekInto(run: Run, target: number, info: PanoramaInfo): "run" | number {
  const segment = segmentAt(target, info);
  return segment >= run.start && segment <= run.next ? "run" : segment;
}
