import crypto from "node:crypto";
import { Transform, pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";

export type ZipEntry = {
  /** Path inside the archive, `/`-separated, without a trailing slash. */
  name: string;
  /** The file's bytes; not asked of a directory. */
  open(): Readable | Promise<Readable>;
  directory: boolean;
  size: number;
  mtime: Date;
};

export type ZipEncryption = "aes256" | "zipcrypto";

export type ZipOptions = {
  /** zlib's 0–9; 0 stores the files as they are. */
  level?: number;
  /** Encrypts every file's data. Names and sizes stay readable, as the format has it. */
  password?: string;
  /** AES-256 is the one that holds; ZipCrypto is weak but opens in what ships with Windows and macOS. */
  encryption?: ZipEncryption;
};

type Written = {
  name: Buffer;
  directory: boolean;
  zip64: boolean;
  time: number;
  date: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
  /** The method the data went through, which an AES entry names in its extra field instead. */
  method: number;
  encryption: ZipEncryption | null;
};

const UINT32_MAX = 0xffffffff;
/** Deflate can grow incompressible data a little, so entries near 4 GB already take the 64-bit form. */
const ZIP64_ENTRY_SIZE = 0xf0000000;
/** UTF-8 names, and for files sizes and CRC that follow the data. */
const FLAG_UTF8 = 0x0800;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_ENCRYPTED = 0x0001;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;

/**
 * Writes a zip as it reads the files, so an archive of any size can be sent without first existing on disk or in memory.
 * Sizes and checksums follow each file's data (a data descriptor), and anything past 4 GB or 65535 entries is written as Zip64.
 */
export async function* zipStream(entries: AsyncIterable<ZipEntry>, options: ZipOptions = {}): AsyncGenerator<Buffer> {
  const written: Written[] = [];
  let offset = 0;
  const level = options.level ?? zlib.constants.Z_DEFAULT_COMPRESSION;
  const password = options.password ? Buffer.from(options.password, "utf8") : null;

  for await (const entry of entries) {
    const record: Written = {
      name: Buffer.from(entry.directory ? `${entry.name}/` : entry.name, "utf8"),
      directory: entry.directory,
      zip64: !entry.directory && entry.size >= ZIP64_ENTRY_SIZE,
      ...dosDateTime(entry.mtime),
      crc: 0,
      compressed: 0,
      size: 0,
      offset,
      method: entry.directory || level === 0 ? METHOD_STORE : METHOD_DEFLATE,
      encryption: password && !entry.directory ? (options.encryption ?? "aes256") : null
    };
    const header = localHeader(record);
    yield header;
    offset += header.length;

    if (!entry.directory) {
      // An AES entry is vouched for by its own code, and a checksum of the plain bytes would only tell on them.
      const checksummed = record.encryption !== "aes256";
      const meter = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          if (checksummed) record.crc = zlib.crc32(chunk, record.crc);
          record.size += chunk.length;
          done(null, chunk);
        }
      });
      const packed = record.method === METHOD_STORE ? meter : zlib.createDeflateRaw({ level });
      // A failed read destroys `packed`, which the loop below then throws.
      if (packed === meter) pipeline(await entry.open(), meter, () => {});
      else pipeline(await entry.open(), meter, packed, () => {});
      const cipher = !password ? null : record.encryption === "aes256" ? aesCipher(password) : zipCryptoCipher(password, record.time);
      if (cipher) {
        record.compressed += cipher.head.length;
        yield cipher.head;
      }
      for await (const chunk of packed as AsyncIterable<Buffer>) {
        record.compressed += chunk.length;
        yield cipher ? cipher.update(chunk) : chunk;
      }
      if (cipher) {
        const tail = cipher.final();
        record.compressed += tail.length;
        yield tail;
      }
      const descriptor = dataDescriptor(record);
      yield descriptor;
      offset += record.compressed + descriptor.length;
    }
    written.push(record);
  }

  const directoryOffset = offset;
  let directorySize = 0;
  for (const record of written) {
    const header = centralHeader(record);
    directorySize += header.length;
    yield header;
  }
  yield endOfDirectory(written.length, directorySize, directoryOffset);
}

function localHeader(record: Written): Buffer {
  const zip64 = record.zip64 ? Buffer.alloc(20) : Buffer.alloc(0);
  if (record.zip64) {
    // Both sizes are zero here; the real ones follow the data.
    zip64.writeUInt16LE(0x0001, 0);
    zip64.writeUInt16LE(16, 2);
  }
  const extra = Buffer.concat([zip64, aesExtra(record)]);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(versionNeeded(record, record.zip64), 4);
  header.writeUInt16LE(flags(record), 6);
  header.writeUInt16LE(record.encryption === "aes256" ? METHOD_AES : record.method, 8);
  header.writeUInt16LE(record.time, 10);
  header.writeUInt16LE(record.date, 12);
  header.writeUInt32LE(record.zip64 ? UINT32_MAX : 0, 18);
  header.writeUInt32LE(record.zip64 ? UINT32_MAX : 0, 22);
  header.writeUInt16LE(record.name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  return Buffer.concat([header, record.name, extra]);
}

function dataDescriptor(record: Written): Buffer {
  const descriptor = Buffer.alloc(record.zip64 ? 24 : 16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(record.crc, 4);
  if (record.zip64) {
    descriptor.writeBigUInt64LE(BigInt(record.compressed), 8);
    descriptor.writeBigUInt64LE(BigInt(record.size), 16);
  } else {
    descriptor.writeUInt32LE(record.compressed, 8);
    descriptor.writeUInt32LE(record.size, 12);
  }
  return descriptor;
}

function centralHeader(record: Written): Buffer {
  const zip64 = record.zip64 || record.offset >= UINT32_MAX;
  const sizes = zip64 ? Buffer.alloc(28) : Buffer.alloc(0);
  if (zip64) {
    sizes.writeUInt16LE(0x0001, 0);
    sizes.writeUInt16LE(24, 2);
    sizes.writeBigUInt64LE(BigInt(record.size), 4);
    sizes.writeBigUInt64LE(BigInt(record.compressed), 12);
    sizes.writeBigUInt64LE(BigInt(record.offset), 20);
  }
  const extra = Buffer.concat([sizes, aesExtra(record)]);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  // Made on Unix, so the mode in the external attributes is read.
  header.writeUInt16LE((3 << 8) | 45, 4);
  header.writeUInt16LE(versionNeeded(record, zip64), 6);
  header.writeUInt16LE(flags(record), 8);
  header.writeUInt16LE(record.encryption === "aes256" ? METHOD_AES : record.method, 10);
  header.writeUInt16LE(record.time, 12);
  header.writeUInt16LE(record.date, 14);
  header.writeUInt32LE(record.crc, 16);
  header.writeUInt32LE(zip64 ? UINT32_MAX : record.compressed, 20);
  header.writeUInt32LE(zip64 ? UINT32_MAX : record.size, 24);
  header.writeUInt16LE(record.name.length, 28);
  header.writeUInt16LE(extra.length, 30);
  header.writeUInt32LE(record.directory ? ((0o40755 << 16) | 0x10) >>> 0 : (0o100644 << 16) >>> 0, 38);
  header.writeUInt32LE(zip64 ? UINT32_MAX : record.offset, 42);
  return Buffer.concat([header, record.name, extra]);
}

function flags(record: Written): number {
  if (record.directory) return FLAG_UTF8;
  return FLAG_UTF8 | FLAG_DESCRIPTOR | (record.encryption ? FLAG_ENCRYPTED : 0);
}

function versionNeeded(record: Written, zip64: boolean): number {
  return record.encryption === "aes256" ? 51 : zip64 ? 45 : 20;
}

/** WinZip's AE-2: 256-bit key, with the real method kept here since the header says 99. */
function aesExtra(record: Written): Buffer {
  if (record.encryption !== "aes256") return Buffer.alloc(0);
  const extra = Buffer.alloc(11);
  extra.writeUInt16LE(0x9901, 0);
  extra.writeUInt16LE(7, 2);
  extra.writeUInt16LE(2, 4);
  extra.write("AE", 6, "latin1");
  extra.writeUInt8(3, 8);
  extra.writeUInt16LE(record.method, 9);
  return extra;
}

type EntryCipher = { head: Buffer; update(chunk: Buffer): Buffer; final(): Buffer };

/** A salt and a password check go before the data, AES-256 in counter mode over it, and ten bytes of HMAC-SHA1 after. */
function aesCipher(password: Buffer): EntryCipher {
  const salt = crypto.randomBytes(16);
  const keys = crypto.pbkdf2Sync(password, salt, 1000, 66, "sha1");
  // WinZip counts the blocks little-endian from 1, which no built-in CTR does, so the key stream is made here.
  const block = crypto.createCipheriv("aes-256-ecb", keys.subarray(0, 32), null).setAutoPadding(false);
  const mac = crypto.createHmac("sha1", keys.subarray(32, 64));
  let counter = 1;
  let pad: Buffer = Buffer.alloc(0);
  return {
    head: Buffer.concat([salt, keys.subarray(64, 66)]),
    update(chunk) {
      const out = Buffer.allocUnsafe(chunk.length);
      let at = 0;
      for (; at < chunk.length && at < pad.length; at += 1) out[at] = chunk[at]! ^ pad[at]!;
      pad = pad.subarray(at);
      if (at < chunk.length) {
        const counters = Buffer.alloc(Math.ceil((chunk.length - at) / 16) * 16);
        for (let offset = 0; offset < counters.length; offset += 16, counter += 1) {
          counters.writeUInt32LE(counter >>> 0, offset);
          counters.writeUInt32LE(Math.floor(counter / 0x100000000), offset + 4);
        }
        const stream = block.update(counters);
        const rest = chunk.length - at;
        for (let index = 0; index < rest; index += 1) out[at + index] = chunk[at + index]! ^ stream[index]!;
        pad = stream.subarray(rest);
      }
      mac.update(out);
      return out;
    },
    final: () => mac.digest().subarray(0, 10)
  };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

/** The original zip encryption. Its twelve-byte header ends in a byte a reader checks the password by: the time's high byte, since the CRC is not known yet. */
function zipCryptoCipher(password: Buffer, time: number): EntryCipher {
  let key0 = 0x12345678;
  let key1 = 0x23456789;
  let key2 = 0x34567890;
  const feed = (byte: number) => {
    key0 = (crcTable[(key0 ^ byte) & 0xff]! ^ (key0 >>> 8)) >>> 0;
    key1 = (Math.imul((key1 + (key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    key2 = (crcTable[(key2 ^ (key1 >>> 24)) & 0xff]! ^ (key2 >>> 8)) >>> 0;
  };
  const update = (chunk: Buffer) => {
    const out = Buffer.allocUnsafe(chunk.length);
    for (let index = 0; index < chunk.length; index += 1) {
      const mask = (key2 | 2) & 0xffff;
      out[index] = chunk[index]! ^ ((Math.imul(mask, mask ^ 1) >>> 8) & 0xff);
      feed(chunk[index]!);
    }
    return out;
  };
  for (const byte of password) feed(byte);
  const head = crypto.randomBytes(12);
  head[11] = time >>> 8;
  return { head: update(head), update, final: () => Buffer.alloc(0) };
}

function endOfDirectory(count: number, size: number, offset: number): Buffer {
  const zip64 = count >= 0xffff || size >= UINT32_MAX || offset >= UINT32_MAX;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(zip64 ? 0xffff : count, 8);
  end.writeUInt16LE(zip64 ? 0xffff : count, 10);
  end.writeUInt32LE(zip64 ? UINT32_MAX : size, 12);
  end.writeUInt32LE(zip64 ? UINT32_MAX : offset, 16);
  if (!zip64) return end;

  const record = Buffer.alloc(56);
  record.writeUInt32LE(0x06064b50, 0);
  record.writeBigUInt64LE(44n, 4);
  record.writeUInt16LE((3 << 8) | 45, 12);
  record.writeUInt16LE(45, 14);
  record.writeBigUInt64LE(BigInt(count), 24);
  record.writeBigUInt64LE(BigInt(count), 32);
  record.writeBigUInt64LE(BigInt(size), 40);
  record.writeBigUInt64LE(BigInt(offset), 48);
  const locator = Buffer.alloc(20);
  locator.writeUInt32LE(0x07064b50, 0);
  locator.writeBigUInt64LE(BigInt(offset + size), 8);
  locator.writeUInt32LE(1, 16);
  return Buffer.concat([record, locator, end]);
}

/** Zip keeps local time, to two seconds, and cannot say anything earlier than 1980. */
function dosDateTime(value: Date): { time: number; date: number } {
  const year = Math.max(1980, value.getFullYear());
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | (value.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate()
  };
}
