import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

type Span = { start: number; end: number };

/**
 * rclone serves an object by waiting on each small read before asking for the next, so one request over SMB or SFTP
 * moves only a few kilobytes per round trip. Several requests for consecutive pieces run at once instead, as an SMB client's read-ahead does.
 */
const READ_PIECE = 2 * 1024 * 1024;
const READS_AHEAD = 8;

export type RcloneItem = { Path: string; Name: string; Size: number; ModTime: string; IsDir: boolean };
export type RcloneStats = { bytes: number; totalBytes: number; transfers: number; totalTransfers: number; deletes?: number; deletedDirs?: number; errors: number; lastError?: string; transferring?: Array<{ name: string }> };
type JobStatus = { finished: boolean; success: boolean; error: string };

/** What rclone answered when it refused a call; `status` is the HTTP status it gave. */
export class RcloneError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

/** Thrown out of a job that was stopped because the caller said so. */
export class RcloneJobStopped extends Error {}

/**
 * Where the rclone daemon listens. A unix socket has a short limit on its path,
 * so a deep app-data directory gets a socket in the temp dir instead, named after it.
 */
export function rcloneSocketPath(appDataDir: string): string {
  const preferred = path.join(path.resolve(appDataDir), "run", "rclone.sock");
  if (Buffer.byteLength(preferred) <= 96) return preferred;
  return path.join(os.tmpdir(), `kago-${createHash("sha1").update(path.resolve(appDataDir)).digest("hex").slice(0, 12)}`, "rclone.sock");
}

/** Talks to the rclone daemon over its socket: every remote location is reached through it. */
export class RcloneClient {
  constructor(private readonly socketPath: string) {}

  /** `signal` drops the connection, and rclone stops what the call had it doing. */
  async call<T = Record<string, unknown>>(command: string, body: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const payload = Buffer.from(JSON.stringify(body));
    const response = await this.request("POST", `/${command}`, { "Content-Type": "application/json", "Content-Length": String(payload.length) }, payload, signal);
    const text = await readAll(response);
    if (response.statusCode !== 200) throw rcloneError(response.statusCode ?? 500, text);
    return JSON.parse(text.toString("utf8") || "{}") as T;
  }

  async list(fs: string, remote: string): Promise<RcloneItem[]> {
    return (await this.call<{ list: RcloneItem[] }>("operations/list", { fs, remote })).list;
  }

  async stat(fs: string, remote: string): Promise<RcloneItem | null> {
    return (await this.call<{ item: RcloneItem | null }>("operations/stat", { fs, remote })).item;
  }

  /** The bytes of one object, or of the part of it that `range` names. */
  async open(fs: string, remote: string, range?: Span): Promise<Readable> {
    const url = `/${encodeURIComponent(`[${fs}]`)}/${remote.split("/").map(encodeURIComponent).join("/")}`;
    const start = range?.start ?? 0;
    const first = await this.request("GET", url, { Range: `bytes=${start}-${Math.min(range?.end ?? Infinity, start + READ_PIECE - 1)}` });
    // An empty file has no range to give; only a request without one gets its (empty) body.
    if (first.statusCode === 416 && !range) {
      first.resume();
      const whole = await this.request("GET", url, {});
      if (whole.statusCode !== 200) throw rcloneError(whole.statusCode ?? 500, await readAll(whole));
      return whole;
    }
    if (first.statusCode === 200) return first;
    if (first.statusCode !== 206) throw rcloneError(first.statusCode ?? 500, await readAll(first));
    const answered = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(first.headers["content-range"] ?? "");
    if (!answered) return first;
    const end = Math.min(range?.end ?? Infinity, Number(answered[3]) - 1);
    const spans: Span[] = [];
    for (let from = Number(answered[2]) + 1; from <= end; from += READ_PIECE) spans.push({ start: from, end: Math.min(end, from + READ_PIECE - 1) });
    if (spans.length === 0) return first;
    return new ReadAhead(first, spans, (span, signal) => this.piece(url, span, signal));
  }

  private async piece(url: string, span: Span, signal: AbortSignal): Promise<Buffer> {
    const response = await this.request("GET", url, { Range: `bytes=${span.start}-${span.end}` }, undefined, signal);
    const body = await readAll(response);
    if (response.statusCode !== 206) throw rcloneError(response.statusCode ?? 500, body);
    // The file changed or shrank since its first piece was sent: what follows would not belong with it.
    if (body.length !== span.end - span.start + 1) throw new RcloneError(502, "The remote file changed while it was being read");
    return body;
  }

  /** Writes a stream of unknown length as `name` inside `directory`, replacing what is there. */
  async upload(fs: string, directory: string, name: string, source: Readable): Promise<void> {
    if (/[\r\n\0]/.test(name)) throw new AppError(400, "Invalid filename", "INVALID_FILENAME");
    const boundary = `kago${createHash("sha1").update(`${Date.now()}:${Math.random()}`).digest("hex")}`;
    const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file0"; filename="${name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\r\nContent-Type: application/octet-stream\r\n\r\n`);
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const query = new URLSearchParams({ fs, remote: directory }).toString();
    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, method: "POST", path: `/operations/uploadfile?${query}`, headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } }, resolve);
      request.on("error", (error) => {
        source.destroy();
        reject(unavailable(error));
      });
      // What stopped the source is the caller's to tell apart: a cancelled task ends its stream with its own error.
      source.on("error", (error) => {
        request.destroy();
        reject(error);
      });
      request.write(head);
      source.pipe(request, { end: false });
      source.on("end", () => request.end(tail));
    });
    const text = await readAll(response);
    if (response.statusCode !== 200) throw rcloneError(response.statusCode ?? 500, text);
  }

  /**
   * Runs a long call as a job of the daemon, reporting what it has moved so far.
   * `shouldStop` is asked between reports; once it says yes the job is stopped and `RcloneJobStopped` is thrown.
   */
  async runJob(command: string, body: Record<string, unknown>, onStats: (stats: RcloneStats) => void, shouldStop: () => boolean): Promise<void> {
    const { jobid } = await this.call<{ jobid: number }>(command, { ...body, _async: true });
    const group = `job/${jobid}`;
    // Asked soon at first, so that a job done in a moment costs a moment, and then no more often than twice a second.
    let wait = 25;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 500);
      if (shouldStop()) {
        await this.call("job/stop", { jobid }).catch(() => undefined);
        throw new RcloneJobStopped();
      }
      const status = await this.call<JobStatus>("job/status", { jobid });
      const stats = await this.call<RcloneStats>("core/stats", { group });
      onStats(stats);
      if (!status.finished) continue;
      await this.call("core/stats-delete", { group }).catch(() => undefined);
      if (!status.success) throw new RcloneError(500, status.error || stats.lastError || "rclone job failed");
      return;
    }
  }

  private request(method: string, url: string, headers: Record<string, string>, body?: Buffer, signal?: AbortSignal): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, method, path: url, headers, signal }, resolve);
      request.on("error", (error) => reject(signal?.aborted ? error : unavailable(error)));
      request.end(body);
    });
  }
}

/** How each kind of storage words a refusal for lack of permission, which rclone passes on as it got it. */
export const refusedForPermission = (message: string) => /permission denied|access[ _]denied|access is denied|operation not permitted/i.test(message);

/** rclone's own words are for the log and the administrator; everyone else is told only that the remote failed, or that it refused. */
export function remoteFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof RcloneError) {
    if (error.status === 404 || /not found|does not exist|no such file/i.test(error.message)) return new AppError(404, "Path not found", "PATH_NOT_FOUND");
    logger.warn("remote location failed", error.message);
    if (refusedForPermission(error.message)) return new AppError(502, "The remote location refused this: the account Kago signs in with has no permission there", "REMOTE_PERMISSION_DENIED");
    return new AppError(502, "The remote location could not be reached", "REMOTE_FAILED");
  }
  throw error;
}

function unavailable(error: Error): AppError {
  logger.warn("rclone is not answering", error.message);
  return new AppError(503, "Remote locations are not available", "REMOTE_UNAVAILABLE");
}

function rcloneError(status: number, body: Buffer): RcloneError {
  let message = body.toString("utf8").trim();
  try {
    message = (JSON.parse(message) as { error?: string }).error ?? message;
  } catch {
    // Served objects answer in plain text.
  }
  return new RcloneError(status, message);
}

/** The first response passed on as it arrives, then the pieces after it in order, keeping `READS_AHEAD` of them on the way. */
class ReadAhead extends Readable {
  private readonly stop = new AbortController();
  private readonly first: AsyncIterator<Buffer>;
  private firstDone = false;
  private readonly waiting: Array<Promise<Buffer>> = [];
  private reading = false;

  constructor(
    private readonly response: http.IncomingMessage,
    private readonly spans: Span[],
    private readonly fetch: (span: Span, signal: AbortSignal) => Promise<Buffer>
  ) {
    super();
    this.first = response[Symbol.asyncIterator]();
    this.fill();
  }

  private fill(): void {
    while (this.waiting.length < READS_AHEAD && this.spans.length > 0) {
      const piece = this.fetch(this.spans.shift()!, this.stop.signal);
      // Awaited in turn later; one that fails while ahead must not count as unhandled meanwhile.
      piece.catch(() => undefined);
      this.waiting.push(piece);
    }
  }

  private async next(): Promise<Buffer | null> {
    if (!this.firstDone) {
      const step = await this.first.next();
      if (!step.done) return step.value;
      this.firstDone = true;
    }
    const piece = this.waiting.shift();
    if (!piece) return null;
    this.fill();
    return piece;
  }

  override async _read(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      for (;;) {
        const chunk = await this.next();
        if (this.destroyed) return;
        if (!this.push(chunk) || chunk === null) return;
      }
    } catch (error) {
      this.destroy(error as Error);
    } finally {
      this.reading = false;
    }
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.stop.abort();
    this.response.destroy();
    callback(error);
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
