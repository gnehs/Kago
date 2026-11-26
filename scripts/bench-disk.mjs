// A hard disk to measure against: an NBD server that keeps a file and answers the way one head does.
//
//   node scripts/bench-disk.mjs <image file> <port>
//
// One request is served at a time. One that does not start where the last ended costs a seek, and every one
// costs its bytes at the platter's pace. Reads go before writes, as the kernel's deadline scheduler has them, with
// a write let through now and then so none waits for ever. While a file named `<image>.fast` exists nothing
// is slowed down, for filling the disk before a measurement.
import { existsSync, openSync, readSync, writeSync, fsyncSync, fstatSync } from "node:fs";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const [image, port] = process.argv.slice(2);
const SEEK_MS = Number(process.env.DISK_SEEK_MS ?? 8);
const BYTES_PER_MS = Number(process.env.DISK_MB_PER_S ?? 150) * 1e3;
/** How far ahead of the last request one may start and still be read on in passing. */
const NEAR_BYTES = 256 * 1024;
/** How many reads may pass a waiting write. */
const READS_PER_WRITE = 32;

const fd = openSync(image, "r+");
const size = BigInt(fstatSync(fd).size);
const fast = `${image}.fast`;
let head = 0;

const READ = 0;
const WRITE = 1;
const DISCONNECT = 2;
const FLUSH = 3;

net
  .createServer((socket) => {
    socket.setNoDelay(true);
    let buffered = Buffer.alloc(0);
    let wake = null;
    socket.on("data", (chunk) => {
      buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
      wake?.();
    });
    socket.on("error", () => undefined);
    socket.on("close", () => wake?.());
    const take = async (length) => {
      while (buffered.length < length) {
        if (socket.destroyed) throw new Error("closed");
        await new Promise((resolve) => (wake = resolve));
      }
      const taken = buffered.subarray(0, length);
      buffered = buffered.subarray(length);
      return taken;
    };

    const reads = [];
    const writes = [];
    let serving = false;
    let passed = 0;
    const serve = async () => {
      if (serving) return;
      serving = true;
      for (;;) {
        const writeDue = writes.length > 0 && (reads.length === 0 || passed >= READS_PER_WRITE);
        const request = writeDue ? writes.shift() : reads.shift();
        if (!request) break;
        passed = writeDue ? 0 : passed + 1;
        const { type, handle, offset, length, data } = request;
        if (type !== FLUSH && !existsSync(fast)) {
          const ahead = offset - head;
          await sleep((ahead >= 0 && ahead <= NEAR_BYTES ? 0 : SEEK_MS) + length / BYTES_PER_MS);
        }
        const reply = Buffer.alloc(16 + (type === READ ? length : 0));
        reply.writeUInt32BE(0x67446698, 0);
        handle.copy(reply, 8);
        if (type === READ) readSync(fd, reply, 16, length, offset);
        else if (type === WRITE) writeSync(fd, data, 0, length, offset);
        else fsyncSync(fd);
        if (type !== FLUSH) head = offset + length;
        socket.write(reply);
      }
      serving = false;
    };

    (async () => {
      const hello = Buffer.alloc(18);
      hello.write("NBDMAGICIHAVEOPT", "latin1");
      hello.writeUInt16BE(1 | 2, 16);
      socket.write(hello);
      await take(4);
      // Flags of the export: it has flags, and it can be told to flush.
      const exportFlags = 1 | 4;
      for (;;) {
        const option = await take(16);
        const kind = option.readUInt32BE(8);
        await take(option.readUInt32BE(12));
        const answer = (type, payload = Buffer.alloc(0)) => {
          const head = Buffer.alloc(20);
          head.writeBigUInt64BE(0x3e889045565a9n, 0);
          head.writeUInt32BE(kind, 8);
          head.writeUInt32BE(type, 12);
          head.writeUInt32BE(payload.length, 16);
          socket.write(Buffer.concat([head, payload]));
        };
        if (kind === 1) {
          const info = Buffer.alloc(10);
          info.writeBigUInt64BE(size, 0);
          info.writeUInt16BE(exportFlags, 8);
          socket.write(info);
          break;
        }
        if (kind === 7) {
          const info = Buffer.alloc(12);
          info.writeBigUInt64BE(size, 2);
          info.writeUInt16BE(exportFlags, 10);
          answer(3, info);
          answer(1);
          break;
        }
        answer(0x80000001);
      }
      for (;;) {
        const header = await take(28);
        const type = header.readUInt16BE(6);
        if (type === DISCONNECT) break;
        const request = { type, handle: Buffer.from(header.subarray(8, 16)), offset: Number(header.readBigUInt64BE(16)), length: header.readUInt32BE(24) };
        if (type === WRITE) request.data = Buffer.from(await take(request.length));
        (type === READ ? reads : writes).push(request);
        void serve();
      }
      socket.end();
    })().catch(() => socket.destroy());
  })
  .listen(Number(port), "127.0.0.1", () => console.log(`disk of ${size} bytes on ${port}`));
