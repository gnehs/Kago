/**
 * How the lens videos are fed and kept together. Each track played, a lens's video or the sound, is a lane: its
 * samples cut into fragments, each a media segment of its own, appended to its SourceBuffer a little ahead of the
 * playhead and removed a little behind it.
 */
import type { Samples } from "./mp4";

/** Samples `first` up to, not including, `end`, shown from `start` on, in seconds. */
export type Fragment = { first: number; end: number; start: number; sync: boolean };

/** How long a fragment runs at most. A camera's group of pictures can run for seconds; a fragment is a read. */
export const FRAGMENT_SECONDS = 0.5;
/**
 * How far past the playhead fragments are appended, and how much is kept behind it. A lens of a 3840² recording runs
 * at some 9 MB a second, and a browser holds some 150 MB of video per SourceBuffer.
 */
export const AHEAD = 6;
export const BEHIND = 3;

/**
 * The samples cut into fragments: a new one at every group of pictures, and whenever one has run for `maxSeconds`.
 * Only a fragment that starts at a sync sample can be played from. Sound, all sync samples, is cut by time alone.
 */
export function cutFragments(samples: Pick<Samples, "count" | "times" | "sync">, maxSeconds = FRAGMENT_SECONDS): Fragment[] {
  const fragments: Fragment[] = [];
  let current: Fragment | null = null;
  for (let index = 0; index < samples.count; index++) {
    const time = samples.times[index]!;
    const newGroup = samples.sync[index] === 1 && samples.sync[index - 1] === 0;
    if (!current || newGroup || time - current.start >= maxSeconds - 1e-6) {
      current = { first: index, end: index, start: time, sync: samples.sync[index] === 1 };
      fragments.push(current);
    }
    current.end = index + 1;
  }
  return fragments;
}

/** The fragment to play `time` from: the last that starts at a sync sample no later than it. */
export function fragmentAt(fragments: Fragment[], time: number) {
  let found = 0;
  for (let index = 0; index < fragments.length && fragments[index]!.start <= time + 1e-6; index++) if (fragments[index]!.sync) found = index;
  return found;
}

/** A lane as batching sees it: its fragments and the next of them to fetch. */
export type LaneCursor = { fragments: Fragment[]; cursor: number };

/**
 * The fragments to fetch together next, as a list per lane: those of every lane that start within `batch` seconds
 * of the earliest one due, and before `horizon`. A camera interleaves its tracks in the file, so the lanes' samples
 * of a moment lie close together and are read together. Null when none is due.
 */
export function nextBatch(lanes: LaneCursor[], horizon: number, batch = FRAGMENT_SECONDS): number[][] | null {
  const due = lanes.map((lane) => lane.fragments[lane.cursor]?.start ?? Infinity);
  const until = Math.min(horizon, Math.min(...due) + batch);
  const picks = lanes.map((lane) => {
    const picked: number[] = [];
    while (lane.cursor + picked.length < lane.fragments.length && lane.fragments[lane.cursor + picked.length]!.start < until) picked.push(lane.cursor + picked.length);
    return picked;
  });
  return picks.some((picked) => picked.length) ? picks : null;
}

/** How much a lens video may run off the first before it is set back to it outright, in seconds. */
export const JUMP_DRIFT = 0.2;
/** Drift too small to correct, in seconds: a frame of a 60 fps recording is 17 ms. */
const DEAD_ZONE = 0.008;
/** How far the playback rate may stray from 1 to win back drift. */
const MAX_NUDGE = 0.1;

/**
 * What a lens video that runs `drift` seconds ahead of the first (behind, when negative) does about it: a small
 * drift is won back over about a second by playing a little slower or faster, a large one by a jump.
 */
export function correction(drift: number): { jump: true } | { rate: number } {
  if (Math.abs(drift) > JUMP_DRIFT) return { jump: true };
  if (Math.abs(drift) < DEAD_ZONE) return { rate: 1 };
  return { rate: 1 - Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift)) };
}
