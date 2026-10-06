import fs from "node:fs";
import type { FastifyReply, FastifyRequest } from "fastify";

type ByteRange = { start: number; end: number };

/**
 * Streams a file, honouring a single-range `Range` header with 206 so browsers can seek
 * (and Safari can play at all) video and audio. Multi-range and malformed headers fall back to the full body.
 */
export function sendFile(request: FastifyRequest, reply: FastifyReply, absolutePath: string, stat: fs.Stats, contentType: string) {
  const size = stat.size;
  const lastModified = new Date(Math.floor(stat.mtimeMs / 1000) * 1000);
  const etag = `W/"${size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  reply.header("Content-Type", contentType);
  reply.header("Accept-Ranges", "bytes");
  reply.header("Last-Modified", lastModified.toUTCString());
  reply.header("ETag", etag);
  // A reverse proxy that buffers would pull a whole multi-gigabyte file off the disk for a player that only wants its first seconds.
  reply.header("X-Accel-Buffering", "no");

  const header = request.headers.range;
  const range = header && size > 0 && ifRangeMatches(request.headers["if-range"], lastModified) ? parseRange(header, size) : null;
  if (range === "unsatisfiable") {
    reply.code(416).header("Content-Range", `bytes */${size}`).header("Content-Length", "0");
    return reply.send();
  }
  if (!range) {
    reply.header("Content-Length", String(size));
    return reply.send(fs.createReadStream(absolutePath));
  }
  reply.code(206);
  reply.header("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
  reply.header("Content-Length", String(range.end - range.start + 1));
  return reply.send(fs.createReadStream(absolutePath, { start: range.start, end: range.end }));
}

function parseRange(header: string, size: number): ByteRange | "unsatisfiable" | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  if (match[1] === "") {
    // Suffix form: the last N bytes.
    const length = Number(match[2]);
    if (length === 0) return "unsatisfiable";
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (!Number.isSafeInteger(start) || start >= size) return "unsatisfiable";
  if (end < start) return null;
  return { start, end };
}

function ifRangeMatches(ifRange: string | string[] | undefined, lastModified: Date): boolean {
  if (!ifRange) return true;
  if (typeof ifRange !== "string") return false;
  // If-Range needs a strong validator; our ETag is weak, so only the date form can match.
  if (ifRange.startsWith('"') || ifRange.startsWith("W/")) return false;
  const date = Date.parse(ifRange);
  return !Number.isNaN(date) && date === lastModified.getTime();
}
