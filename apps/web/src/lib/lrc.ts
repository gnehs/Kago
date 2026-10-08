/** A stretch of a line with the moments it is sung between, for lyrics timed word by word. */
export type LyricWord = { text: string; start: number; end: number };

/**
 * A line of lyrics and the second it is sung at. A translation timed to the same moment is a second line of the
 * same text. A line timed word by word, as for karaoke, also has its words.
 */
export type LyricLine = { time: number; text: string; words?: LyricWord[] };

const MAX_LINES = 5000;
/** A line and its translations share a moment; nothing has more than a few. */
const MAX_LINES_AT_ONCE = 8;
/** `[mm:ss.xx]`, or the `<mm:ss.xx>` some files time their words with. */
const TIME_TAG = /\[(\d+):(\d+(?:[.:]\d+)?)\]|<(\d+):(\d+(?:[.:]\d+)?)>/g;
/** How long a word is taken to last where the file does not say: one that opens or closes a line. */
const WORD_SECONDS = { least: 0.15, usual: 0.3, most: 1.5 };

const lengthOf = (text: string) => [...text.trim()].length;

/**
 * The words of a line that has times inside it. Two ways of writing them are read. With a time first, every time
 * is when the text after it begins: `[t]never [t]gonna [t]`. With text first, every time is when the text before
 * it ends: `never[t] gonna[t]`. Either way a time between two words is the end of one and the start of the next.
 */
function wordsOf(tokens: Array<string | number>, from: number): LyricWord[] {
  const words: LyricWord[] = [];
  let cursor = from;
  let text = "";
  for (const token of tokens) {
    if (typeof token === "string") {
      text += token;
      continue;
    }
    if (text.trim()) words.push({ text, start: cursor, end: token });
    cursor = token;
    text = "";
  }
  if (text.trim()) words.push({ text, start: cursor, end: Number.NaN });
  return words;
}

/**
 * Reads LRC lyrics. A line may carry several times, for a chorus that comes back, and a file may shift
 * all of them with `[offset:±ms]`. Lines timed word by word are kept as such, however the file writes them.
 */
export function parseLrc(text: string): LyricLine[] {
  const byTime = new Map<number, string[]>();
  const sung: LyricWord[][] = [];
  let offset = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const shift = /^\[offset:\s*([+-]?\d+)\s*\]/i.exec(line);
    if (shift) {
      // A positive offset brings the lyrics forward.
      offset = Number(shift[1]) / 1000;
      continue;
    }
    const tokens: Array<string | number> = [];
    let end = 0;
    for (const tag of line.matchAll(TIME_TAG)) {
      if (tag.index > end) tokens.push(line.slice(end, tag.index));
      tokens.push(Number(tag[1] ?? tag[3]) * 60 + Number((tag[2] ?? tag[4])!.replace(":", ".")));
      end = tag.index + tag[0].length;
    }
    if (end === 0) continue;
    if (end < line.length) tokens.push(line.slice(end));

    const lead = tokens.findIndex((token) => typeof token === "string");
    const times = (lead === -1 ? tokens : tokens.slice(0, lead)) as number[];
    const rest = lead === -1 ? [] : tokens.slice(lead);
    if (rest.some((token) => typeof token === "number")) {
      const words = wordsOf(rest, times.at(-1) ?? Number.NaN);
      if (words.length > 0 && sung.length < MAX_LINES) sung.push(words);
      continue;
    }
    const words = rest.join("").trim();
    for (const time of times) {
      const lines = byTime.get(time);
      // Added to in place: a file of nothing but one timestamp would otherwise copy its lines once for each of them.
      if (!lines) byTime.set(time, [words]);
      else if (lines.length < MAX_LINES_AT_ONCE) lines.push(words);
    }
  }

  // Where a line opens with a word, nothing says when that word begins: it is given the pace of the rest of
  // its line, and never begins before the line above has ended.
  let before = 0;
  for (const words of sung) {
    const first = words[0]!;
    if (Number.isNaN(first.start)) {
      const last = words.at(-1)!;
      const others = words.slice(1).reduce((count, word) => count + lengthOf(word.text), 0);
      const pace = others > 0 && last.end > first.end ? (last.end - first.end) / others : WORD_SECONDS.usual;
      first.start = Math.max(before, first.end - Math.min(WORD_SECONDS.most, Math.max(WORD_SECONDS.least, pace * lengthOf(first.text))));
    }
    before = Number.isNaN(words.at(-1)!.end) ? before : words.at(-1)!.end;
  }

  const lines: LyricLine[] = [
    ...[...byTime].map(([time, texts]) => ({ time, text: texts.filter(Boolean).join("\n") })),
    ...sung.map((words) => ({ time: words[0]!.start, text: words.map((word) => word.text).join("").trim(), words }))
  ].sort((a, b) => a.time - b.time);

  lines.forEach((line, index) => {
    // A line that closes with a word is sung until the next one begins, or for a moment where there is none.
    const last = line.words?.at(-1);
    if (last && Number.isNaN(last.end)) last.end = Math.max(last.start, Math.min(lines[index + 1]?.time ?? Infinity, last.start + WORD_SECONDS.most));
    line.time = Math.max(0, line.time - offset);
    for (const word of line.words ?? []) {
      word.start = Math.max(0, word.start - offset);
      word.end = Math.max(0, word.end - offset);
    }
  });
  // Every line is laid out on the screen at once; no song has this many.
  return lines.slice(0, MAX_LINES);
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
