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

/** Reads bytes of one of the recording's files: 0 the opened one, `i` its `i - 1`th companion. */
export type FileReader = (file: number, start: number, end: number) => Promise<Uint8Array>;

/** Each span's bytes, in the order of `spans`. */
export type SampleFetch = (spans: Span[]) => Promise<Uint8Array[]>;

/**
 * Fetches samples' bytes through Kago in as few reads as they allow, `atOnce` of them at a time: Kago turns away a
 * frame that queues many more.
 */
export function sampleReader(read: FileReader, maxBytes: number, maxGap: number, atOnce: number): SampleFetch {
  let reading = 0;
  const waiting: (() => void)[] = [];
  const limited = async <T>(run: () => Promise<T>) => {
    while (reading >= atOnce) await new Promise<void>((resolve) => waiting.push(resolve));
    reading++;
    try {
      return await run();
    } finally {
      reading--;
      waiting.shift()?.();
    }
  };
  const readAll = async (file: number, start: number, end: number) => {
    const bytes = new Uint8Array(end - start);
    for (let at = start; at < end; ) {
      const chunk = await limited(() => read(file, at, end));
      if (chunk.byteLength === 0) throw new Error("the file ended early");
      bytes.set(chunk, at - start);
      at += chunk.byteLength;
    }
    return bytes;
  };
  return async (spans) => {
    const data: Uint8Array[] = [];
    await Promise.all(
      planReads(spans, maxBytes, maxGap).map(async (planned) => {
        const bytes = await readAll(planned.file, planned.start, planned.end);
        for (const index of planned.spans) {
          const at = spans[index]!.offset - planned.start;
          data[index] = bytes.subarray(at, at + spans[index]!.size);
        }
      })
    );
    return data;
  };
}
