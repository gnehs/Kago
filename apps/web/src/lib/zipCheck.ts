/**
 * Looks into a zip before it is unpacked. Office files are zips that are read whole, in memory, and a few
 * kilobytes of zip can unpack to gigabytes: opening such a file would take the tab down with it.
 *
 * What an archive says its entries unpack to is not believed, since that is the first thing a file made to do
 * harm lies about. Each entry is unpacked for real, into nothing, and counted; the count stops at the limit.
 */

/** What an archive may unpack to, in all, before it is turned away. A large spreadsheet is a tenth of this. */
export const MAX_UNPACKED_BYTES = 300 * 1024 * 1024;
/** An office file has tens of entries, a deck full of pictures a few hundred. */
const MAX_ENTRIES = 10_000;

const END = 0x06054b50;
const END64 = 0x06064b50;
const END64_LOCATOR = 0x07064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
/** The end record is the last thing in the file, save for a comment of at most 64 KB. */
const END_SEARCH_BYTES = 22 + 0xffff;
const UNSET = 0xffffffff;

/** `ok` covers a file that is not a zip at all: there is then nothing here to unpack. */
export type ZipVerdict = "ok" | "too-large" | "unreadable";

type Entry = { method: number; packed: number; declared: number; offset: number };

const big = (view: DataView, at: number) => Number(view.getBigUint64(at, true));

/** The archive's own list of what is in it: null where it cannot be made out, undefined where the file has none and so is no zip. */
function readEntries(view: DataView): Entry[] | null | undefined {
  let end = -1;
  for (let at = view.byteLength - 22; at >= Math.max(0, view.byteLength - END_SEARCH_BYTES); at -= 1) {
    if (view.getUint32(at, true) === END) {
      end = at;
      break;
    }
  }
  if (end === -1) return undefined;
  let count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  // An archive too large for these fields keeps the real figures in a second record, pointed to from just before this one.
  if (end >= 20 && view.getUint32(end - 20, true) === END64_LOCATOR) {
    const record = big(view, end - 12);
    if (record + 56 > view.byteLength || view.getUint32(record, true) !== END64) return null;
    count = big(view, record + 32);
    at = big(view, record + 48);
  }
  if (count > MAX_ENTRIES) return Array.from({ length: 1 }, () => ({ method: 0, packed: Infinity, declared: Infinity, offset: 0 }));

  const entries: Entry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > view.byteLength || view.getUint32(at, true) !== CENTRAL) return null;
    const entry = { method: view.getUint16(at + 10, true), packed: view.getUint32(at + 20, true), declared: view.getUint32(at + 24, true), offset: view.getUint32(at + 42, true) };
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const extraEnd = at + 46 + nameLength + extraLength;
    if (extraEnd > view.byteLength) return null;
    // Figures that do not fit their field are written out in full in an extra field, in this order, each only if needed.
    for (let extra = at + 46 + nameLength; extra + 4 <= extraEnd; ) {
      const id = view.getUint16(extra, true);
      const size = view.getUint16(extra + 2, true);
      if (id === 1) {
        let field = extra + 4;
        for (const key of ["declared", "packed", "offset"] as const) {
          if (entry[key] !== UNSET || field + 8 > extra + 4 + size || field + 8 > extraEnd) continue;
          entry[key] = big(view, field);
          field += 8;
        }
      }
      extra += 4 + size;
    }
    entries.push(entry);
    at = extraEnd + view.getUint16(at + 32, true);
  }
  return entries;
}

/** How much a deflated entry unpacks to, counted as it comes out and given up on once it passes `budget`. */
async function inflatedSize(packed: Uint8Array<ArrayBuffer>, budget: number): Promise<number> {
  const reader = new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > budget) {
        void reader.cancel().catch(() => {});
        break;
      }
    }
  } catch {
    // Damaged data stops unpacking wherever a reader of the archive would stop too.
  }
  return total;
}

/** Whether a file, if it is a zip, unpacks to no more than `limit` bytes. */
export async function checkZip(data: ArrayBuffer, limit = MAX_UNPACKED_BYTES): Promise<ZipVerdict> {
  const view = new DataView(data);
  const entries = readEntries(view);
  // The list at the end is what makes a zip, whatever the file begins with; one that begins as a zip and has no list is broken.
  if (entries === undefined) return view.byteLength >= 4 && view.getUint32(0, true) === LOCAL ? "unreadable" : "ok";
  // A zip whose list cannot be read is one that two readers may read differently; it is not guessed at.
  if (entries === null) return "unreadable";
  const streaming = typeof DecompressionStream === "function";
  let total = 0;
  for (const entry of entries) {
    if (entry.packed === Infinity) return "too-large";
    if (entry.offset + 30 > view.byteLength || view.getUint32(entry.offset, true) !== LOCAL) return "unreadable";
    const start = entry.offset + 30 + view.getUint16(entry.offset + 26, true) + view.getUint16(entry.offset + 28, true);
    if (start + entry.packed > view.byteLength) return "unreadable";
    // Entries are counted one by one even where several point at the same bytes, as each would be unpacked.
    if (entry.method === 8 && streaming) total += await inflatedSize(new Uint8Array(data, start, entry.packed), limit - total);
    else total += entry.method === 0 ? entry.packed : Math.max(entry.packed, entry.declared);
    if (total > limit) return "too-large";
  }
  return "ok";
}
