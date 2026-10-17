import { isIPv6 } from "node:net";
import { AppError } from "./errors.js";

/**
 * Who is guessing, going by where the tries come from. One IPv6 subscriber is handed a whole /64, and could
 * otherwise start from a fresh address for every few guesses, so an IPv6 address counts by its network.
 */
export function guesserOf(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return mapped[1]!;
  const bare = address.split("%", 1)[0]!;
  if (!isIPv6(bare)) return address;
  const [head = "", tail] = bare.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = tail === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right];
  return `${groups.slice(0, 4).map((group) => parseInt(group, 16).toString(16)).join(":")}::/64`;
}

/** How long a run of guesses is remembered for; a slower guesser than this is counted from zero. */
const WINDOW_MS = 15 * 60_000;
/** The first time a limit is reached the wait is short, and it doubles each time after, up to the whole window. */
const FIRST_BLOCK_MS = 30_000;
/** For how long having been blocked before makes the next block longer. */
const MEMORY_MS = 60 * 60_000;
/** Whoever is guessing chooses the keys, so only so many are kept. */
const MAX_TRACKED = 20_000;

type Count = { attempts: number; since: number; blockedUntil: number; blocks: number; lastBlock: number };

export type AttemptLimit = { key: string; limit: number };

/**
 * Slows down guessing at a password. Every try is counted before it is made, against each of the keys it is made
 * under (who is trying, and what at), so a thousand tries sent at once count as a thousand. A key that reaches its
 * limit is turned away for a while, longer each time; a try that succeeds is taken back off the count.
 *
 * It is kept in memory: a restart forgets it, which costs a guesser nothing they could not have had by waiting.
 */
export class AttemptLimiter {
  private readonly counts = new Map<string, Count>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Counts a try under every key, or throws when one of them is being turned away. Call `succeeded` if it was right. */
  begin(limits: AttemptLimit[]): { succeeded: () => void } {
    const now = this.now();
    const counted: Array<{ count: Count; blocked: boolean }> = [];
    const entries = limits.map(({ key, limit }) => ({ limit, key, count: this.countFor(key, now) }));
    if (entries.some(({ count }) => count.blockedUntil > now)) throw new AppError(429, "Too many attempts; try again later", "TOO_MANY_ATTEMPTS");
    for (const { limit, count } of entries) {
      count.attempts += 1;
      const blocked = count.attempts >= limit;
      if (blocked) {
        if (now - count.lastBlock > MEMORY_MS) count.blocks = 0;
        count.blockedUntil = now + Math.min(WINDOW_MS, FIRST_BLOCK_MS * 2 ** count.blocks);
        count.blocks += 1;
        count.lastBlock = now;
      }
      counted.push({ count, blocked });
    }
    return {
      succeeded: () => {
        for (const { count, blocked } of counted) {
          count.attempts = Math.max(0, count.attempts - 1);
          // The try that reached the limit was the right one: nobody is made to wait for it.
          if (blocked) {
            count.blockedUntil = 0;
            count.blocks = Math.max(0, count.blocks - 1);
          }
        }
        // Whoever got in under the first key has shown who they are; their earlier slips are forgotten.
        const own = limits[0] && this.counts.get(limits[0].key);
        if (own) own.attempts = 0;
      }
    };
  }

  private countFor(key: string, now: number): Count {
    let count = this.counts.get(key);
    if (count) {
      // Moved to the back of the line: what is being used is the last to be dropped.
      this.counts.delete(key);
      if (count.blockedUntil <= now) {
        // A block that has been sat out, or a run of tries that has gone quiet, starts over.
        if (count.blockedUntil > 0 || now - count.since > WINDOW_MS) Object.assign(count, { attempts: 0, since: now, blockedUntil: 0 });
        if (now - count.lastBlock > MEMORY_MS) count.blocks = 0;
      }
    } else {
      if (this.counts.size >= MAX_TRACKED) {
        // The longest unused go first: a flood of new keys pushes out what it wrote itself before anyone else's.
        let drop = Math.ceil(MAX_TRACKED / 10);
        for (const old of this.counts.keys()) {
          if ((drop -= 1) < 0) break;
          this.counts.delete(old);
        }
      }
      count = { attempts: 0, since: now, blockedUntil: 0, blocks: 0, lastBlock: 0 };
    }
    this.counts.set(key, count);
    return count;
  }
}

/** Part of a key that someone else chose, cut to a length that cannot be used to fill memory. */
export const attemptKeyPart = (value: string) => value.slice(0, 200);
