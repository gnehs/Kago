import crypto from "node:crypto";
import { pipeline, Readable } from "node:stream";
import zlib from "node:zlib";
import type yauzl from "yauzl";

/** The two ways a zip is locked that are met in practice: WinZip's AES, and the weak original. */
export type ZipCipher =
  | { kind: "aes"; keyBytes: 16 | 24 | 32; method: number; checksummed: boolean }
  | { kind: "zipcrypto"; method: number };

/** Thrown when the data does not come out as the archive says it should, which is what a wrong password looks like. */
export class ZipPasswordError extends Error {
  constructor() {
    super("Wrong archive password");
  }
}

const METHOD_AES = 99;
const AES_MAC_BYTES = 10;
const ZIPCRYPTO_HEAD_BYTES = 12;
const FLAG_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;

/** WinZip counts the blocks little-endian from 1, which no built-in CTR does, so the key stream is made here. */
export function aesCounterStream(key: Buffer): (chunk: Buffer) => Buffer {
  const block = crypto.createCipheriv(`aes-${key.length * 8}-ecb`, key, null).setAutoPadding(false);
  let counter = 1;
  let pad: Buffer = Buffer.alloc(0);
  return (chunk) => {
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
    return out;
  };
}

/** The key, the key the data is vouched for with, and the two bytes a reader checks the password by. */
export function aesKeys(password: Buffer, salt: Buffer, keyBytes: number): { key: Buffer; macKey: Buffer; check: Buffer } {
  const keys = crypto.pbkdf2Sync(password, salt, 1000, keyBytes * 2 + 2, "sha1");
  return { key: keys.subarray(0, keyBytes), macKey: keys.subarray(keyBytes, keyBytes * 2), check: keys.subarray(keyBytes * 2) };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
  return value >>> 0;
});

/** The original zip encryption: three keys that every plain byte stirs. */
export function zipCryptoKeys(password: Buffer): { encrypt(chunk: Buffer): Buffer; decrypt(chunk: Buffer): Buffer } {
  let key0 = 0x12345678;
  let key1 = 0x23456789;
  let key2 = 0x34567890;
  const feed = (byte: number) => {
    key0 = (crcTable[(key0 ^ byte) & 0xff]! ^ (key0 >>> 8)) >>> 0;
    key1 = (Math.imul((key1 + (key0 & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    key2 = (crcTable[(key2 ^ (key1 >>> 24)) & 0xff]! ^ (key2 >>> 8)) >>> 0;
  };
  const mask = () => {
    const low = (key2 | 2) & 0xffff;
    return (Math.imul(low, low ^ 1) >>> 8) & 0xff;
  };
  for (const byte of password) feed(byte);
  const run = (chunk: Buffer, plainIsInput: boolean) => {
    const out = Buffer.allocUnsafe(chunk.length);
    for (let index = 0; index < chunk.length; index += 1) {
      out[index] = chunk[index]! ^ mask();
      feed(plainIsInput ? chunk[index]! : out[index]!);
    }
    return out;
  };
  return { encrypt: (chunk) => run(chunk, true), decrypt: (chunk) => run(chunk, false) };
}

/** How an entry is locked, or null when it is in a way that cannot be opened here. */
export function zipCipherOf(entry: yauzl.Entry): ZipCipher | null {
  if (entry.generalPurposeBitFlag & FLAG_STRONG_ENCRYPTION) return null;
  if (entry.compressionMethod !== METHOD_AES) {
    return entry.compressionMethod === 0 || entry.compressionMethod === 8 ? { kind: "zipcrypto", method: entry.compressionMethod } : null;
  }
  const field = entry.extraFields.find((extra) => extra.id === 0x9901)?.data;
  if (!field || field.length < 7) return null;
  const keyBytes = ({ 1: 16, 2: 24, 3: 32 } as const)[field.readUInt8(4) as 1 | 2 | 3];
  const method = field.readUInt16LE(5);
  if (!keyBytes || (method !== 0 && method !== 8)) return null;
  // AE-1 keeps the checksum of the plain bytes; AE-2 leaves it out and relies on the code after the data.
  return { kind: "aes", keyBytes, method, checksummed: field.readUInt16LE(0) === 1 };
}

const headBytes = (cipher: ZipCipher) => (cipher.kind === "aes" ? cipher.keyBytes / 2 + 2 : ZIPCRYPTO_HEAD_BYTES);
const tailBytes = (cipher: ZipCipher) => (cipher.kind === "aes" ? AES_MAC_BYTES : 0);

async function readRange(zip: yauzl.ZipFile, entry: yauzl.Entry, start: number, end: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await zip.openReadStreamPromise(entry, { decodeFileData: false, start, end })) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** What goes before an entry's data, by which a password can be turned away without reading the rest. */
export async function readZipCipherHead(zip: yauzl.ZipFile, entry: yauzl.Entry, cipher: ZipCipher): Promise<Buffer> {
  if (entry.compressedSize < headBytes(cipher) + tailBytes(cipher)) throw new ZipPasswordError();
  return readRange(zip, entry, 0, headBytes(cipher));
}

/** A quick no. A yes is only likely: one wrong password in 65536 passes for AES, one in 256 for the original. */
export function zipPasswordFits(entry: yauzl.Entry, cipher: ZipCipher, head: Buffer, password: string): boolean {
  const secret = Buffer.from(password, "utf8");
  if (cipher.kind === "aes") {
    const saltBytes = cipher.keyBytes / 2;
    return aesKeys(secret, head.subarray(0, saltBytes), cipher.keyBytes).check.equals(head.subarray(saltBytes));
  }
  // The last byte of the header repeats one the reader already has: of the time when the checksum follows the data, of the checksum otherwise.
  const expected = entry.generalPurposeBitFlag & FLAG_DESCRIPTOR ? entry.lastModFileTime >>> 8 : entry.crc32 >>> 24;
  return zipCryptoKeys(secret).decrypt(head)[ZIPCRYPTO_HEAD_BYTES - 1] === (expected & 0xff);
}

/** An encrypted entry's plain bytes. The stream fails with `ZipPasswordError` at its end if they are not what was sealed. */
export async function openEncryptedZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, cipher: ZipCipher, password: string): Promise<Readable> {
  const secret = Buffer.from(password, "utf8");
  const head = await readZipCipherHead(zip, entry, cipher);
  if (!zipPasswordFits(entry, cipher, head, password)) throw new ZipPasswordError();
  const dataEnd = entry.compressedSize - tailBytes(cipher);
  const sealed = await zip.openReadStreamPromise(entry, { decodeFileData: false, start: head.length, end: dataEnd });

  let decrypt: (chunk: Buffer) => Buffer;
  let mac: crypto.Hmac | null = null;
  if (cipher.kind === "aes") {
    const keys = aesKeys(secret, head.subarray(0, cipher.keyBytes / 2), cipher.keyBytes);
    const stream = aesCounterStream(keys.key);
    const hmac = crypto.createHmac("sha1", keys.macKey);
    mac = hmac;
    decrypt = (chunk) => {
      hmac.update(chunk);
      return stream(chunk);
    };
  } else {
    const keys = zipCryptoKeys(secret);
    keys.decrypt(head);
    decrypt = keys.decrypt;
  }
  const checksummed = cipher.kind === "zipcrypto" || cipher.checksummed;

  async function* plain(): AsyncGenerator<Buffer> {
    const inflate = cipher.method === 8 ? zlib.createInflateRaw() : null;
    let crc = 0;
    const packed = (async function* () {
      for await (const chunk of sealed) yield decrypt(chunk as Buffer);
    })();
    try {
      // A failed read destroys `inflate`, which the loop below then throws.
      if (inflate) pipeline(Readable.from(packed), inflate, () => {});
      for await (const chunk of (inflate ?? packed) as AsyncIterable<Buffer>) {
        if (checksummed) crc = zlib.crc32(chunk, crc);
        yield chunk;
      }
    } catch (error) {
      // Data unlocked with the wrong key is noise, which inflate gives up on.
      if (error instanceof Error && "code" in error && String(error.code).startsWith("Z_")) throw new ZipPasswordError();
      throw error;
    } finally {
      sealed.destroy();
    }
    if (mac && !mac.digest().subarray(0, AES_MAC_BYTES).equals(await readRange(zip, entry, dataEnd, entry.compressedSize))) throw new ZipPasswordError();
    if (checksummed && crc !== entry.crc32) throw new ZipPasswordError();
  }
  return Readable.from(plain());
}
