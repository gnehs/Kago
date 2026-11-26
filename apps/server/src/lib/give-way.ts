import { setTimeout as sleep } from "node:timers/promises";

/**
 * A disk answers one thing at a time, and a hard disk takes its time over each. A copy keeps several questions
 * before it at once, and whoever opens a folder meanwhile has every one of theirs wait behind those. So the long
 * walks of a tree stop putting new ones while a request someone is waiting on is under way, and go on when it
 * is answered.
 *
 * The count of such requests is in memory the task workers share with the main thread, which is the one to count.
 */
let underWay = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

/** How often a walk that stands aside looks whether it may go on. */
const lookEveryMs = 5;
/** The longest a walk stands aside before it does one more thing anyway, so that requests without end do not stop it for good. */
const longestWaitMs = 2000;

/** The count, to hand to a worker. */
export const requestsUnderWay = () => underWay.buffer as SharedArrayBuffer;

/** Has this thread go by the count of another, which is the main thread's. */
export function watchRequests(count: SharedArrayBuffer): void {
  underWay = new Int32Array(count);
}

/** Counts a request someone is waiting on, until the function it gives back is called. */
export function requestBegins(): () => void {
  Atomics.add(underWay, 0, 1);
  let over = false;
  return () => {
    if (over) return;
    over = true;
    Atomics.sub(underWay, 0, 1);
  };
}

/** Resolves once no request is under way, or the wait has been long enough: at once, nearly always. */
export async function giveWay(): Promise<void> {
  if (Atomics.load(underWay, 0) <= 0) return;
  const until = Date.now() + longestWaitMs;
  do await sleep(lookEveryMs);
  while (Atomics.load(underWay, 0) > 0 && Date.now() < until);
}
