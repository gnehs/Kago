/** A run of bytes wanted from one of the recording's files. */
export type Span = { file: number; offset: number; size: number };

/** One read that covers some of the spans: `spans` are their indices in the list planned from. */
export type PlannedRead = { file: number; start: number; end: number; spans: number[] };

/**
 * The fewest reads that fetch every span, each no longer than `maxBytes` unless one span alone is. A camera
 * interleaves its lenses' samples with audio and metadata, so spans close together are read as one, gap and all:
 * a few hundred kilobytes of metadata cost less than another round trip through Kago.
 */
export function planReads(spans: Span[], maxBytes: number, maxGap: number): PlannedRead[] {
  const order = spans.map((_, index) => index).sort((a, b) => spans[a]!.file - spans[b]!.file || spans[a]!.offset - spans[b]!.offset);
  const reads: PlannedRead[] = [];
  let current: PlannedRead | null = null;
  for (const index of order) {
    const span = spans[index]!;
    const end = span.offset + span.size;
    if (current && current.file === span.file && span.offset - current.end <= maxGap && Math.max(current.end, end) - current.start <= maxBytes) {
      current.end = Math.max(current.end, end);
      current.spans.push(index);
      continue;
    }
    current = { file: span.file, start: span.offset, end, spans: [index] };
    reads.push(current);
  }
  return reads;
}
