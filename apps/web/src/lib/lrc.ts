/** A line of lyrics and the second it is sung at. A translation timed to the same moment is a second line of the same text. */
export type LyricLine = { time: number; text: string };

const TIME_TAG = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;
const WORD_TAG = /<\d+:\d+(?:[.:]\d+)?>/g;

/**
 * Reads LRC lyrics. A line may carry several times, for a chorus that comes back, and a file may shift
 * all of them with `[offset:±ms]`. Word-by-word timings of the enhanced format are read as plain lines.
 */
export function parseLrc(text: string): LyricLine[] {
  const byTime = new Map<number, string[]>();
  let offset = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const shift = /^\[offset:\s*([+-]?\d+)\s*\]/i.exec(line);
    if (shift) {
      // A positive offset brings the lyrics forward.
      offset = Number(shift[1]) / 1000;
      continue;
    }
    const times: number[] = [];
    let end = 0;
    TIME_TAG.lastIndex = 0;
    for (let tag = TIME_TAG.exec(line); tag && tag.index === end; tag = TIME_TAG.exec(line)) {
      times.push(Number(tag[1]) * 60 + Number(tag[2]!.replace(":", ".")));
      end = TIME_TAG.lastIndex;
    }
    if (times.length === 0) continue;
    const words = line.slice(end).replace(WORD_TAG, "").trim();
    for (const time of times) byTime.set(time, [...(byTime.get(time) ?? []), words]);
  }

  return [...byTime]
    .map(([time, lines]) => ({ time: Math.max(0, time - offset), text: lines.filter(Boolean).join("\n") }))
    .sort((a, b) => a.time - b.time);
}

/** The line being sung at `time`: the last one that has started. -1 before the first. */
export function lyricIndexAt(lines: LyricLine[], time: number) {
  let low = 0;
  let high = lines.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (lines[middle]!.time <= time) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
}
