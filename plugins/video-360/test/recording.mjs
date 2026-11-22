/** A recording small enough to build by hand: an HEVC lens track behind an edit list, and AAC sound. */

export const ascii = (text) => [...text].map((char) => char.charCodeAt(0));
export const u16 = (value) => [value >> 8, value & 0xff];
export const u32 = (value) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
export const u64 = (value) => [...u32(Math.floor(value / 2 ** 32)), ...u32(value % 2 ** 32)];
export const box = (type, ...body) => {
  const bytes = body.flat(Infinity);
  return [...u32(bytes.length + 8), ...ascii(type), ...bytes];
};
export const full = (type, version, ...body) => box(type, version, 0, 0, 0, ...body);
export const zeros = (count) => Array(count).fill(0);

// A 2.4 GiB file can't be built here; its offsets are 64-bit all the same.
export const FAR = 5 * 2 ** 32;

function trak({ id, handler, scale, entry, samples, edit }) {
  return box(
    "trak",
    full("tkhd", 0, zeros(8), u32(id), zeros(68)),
    edit ? box("edts", full("elst", 0, u32(edit.length), edit.map(([duration, time]) => [u32(duration), u32(time >>> 0), u16(1), u16(0)]))) : [],
    box(
      "mdia",
      full("mdhd", 0, zeros(8), u32(scale), u32(0), zeros(4)),
      full("hdlr", 0, zeros(4), ascii(handler), zeros(12), 0),
      box(
        "minf",
        box(
          "stbl",
          full("stsd", 0, u32(1), entry),
          full("stts", 0, u32(1), u32(samples.length), u32(samples.delta)),
          samples.sync ? full("stss", 0, u32(samples.sync.length), samples.sync.map(u32)) : [],
          full("stsz", 0, u32(0), u32(samples.length), samples.sizes.map(u32)),
          full("stsc", 0, u32(1), u32(1), u32(2), u32(1)),
          full("co64", 0, u32(samples.chunks.length), samples.chunks.map(u64))
        )
      )
    )
  );
}

export const hvcC = [1, 0x22, 0x20, 0, 0, 0, 0xb0, 0, 0, 0, 0, 0, 156, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0];
const hvc1 = box("hvc1", zeros(6), u16(1), zeros(16), u16(3840), u16(3840), zeros(50), box("hvcC", hvcC));
export const asc = [0x11, 0x90];
const esds = full("esds", 0, 3, 25, u16(1), 0, 4, 17, 0x40, 0x15, zeros(11), 5, 2, asc, 6, 1, 2);
const mp4a = box("mp4a", zeros(6), u16(1), zeros(8), u16(2), u16(16), zeros(4), u32(48000 * 65536), esds);

export function file() {
  const video = trak({ id: 1, handler: "vide", scale: 30000, entry: hvc1, edit: [[1000, -1], [1000, 1001]], samples: Object.assign([0, 1, 2, 3], { delta: 1001, sizes: [500, 100, 200, 300], sync: [1, 3], chunks: [FAR, FAR + 2000] }) });
  const sound = trak({ id: 2, handler: "soun", scale: 48000, entry: mp4a, samples: Object.assign([0, 1], { delta: 1024, sizes: [10, 20], chunks: [700] }) });
  const moov = box("moov", full("mvhd", 0, zeros(8), u32(1000), u32(0), zeros(80)), video, sound);
  const ftyp = box("ftyp", ascii("isom"), u32(0));
  const mdat = box("mdat", zeros(4000));
  // Insta360 writes a trailer of its own after the last box, which is no box at all.
  return new Uint8Array([...ftyp, ...mdat, ...moov, ...zeros(3), 0xff, 0xff, 0xff]);
}
