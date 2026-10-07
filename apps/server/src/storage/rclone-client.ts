import { createHash } from "node:crypto";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export type RcloneItem = { Path: string; Name: string; Size: number; ModTime: string; IsDir: boolean };
export type RcloneStats = { bytes: number; totalBytes: number; transfers: number; totalTransfers: number; errors: number; lastError?: string; transferring?: Array<{ name: string }> };
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

  async call<T = Record<string, unknown>>(command: string, body: Record<string, unknown> = {}): Promise<T> {
    const payload = Buffer.from(JSON.stringify(body));
    const response = await this.request("POST", `/${command}`, { "Content-Type": "application/json", "Content-Length": String(payload.length) }, payload);
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
  async open(fs: string, remote: string, range?: { start: number; end: number }): Promise<Readable> {
    const url = `/${encodeURIComponent(`[${fs}]`)}/${remote.split("/").map(encodeURIComponent).join("/")}`;
    const response = await this.request("GET", url, range ? { Range: `bytes=${range.start}-${range.end}` } : {});
    if (response.statusCode !== 200 && response.statusCode !== 206) throw rcloneError(response.statusCode ?? 500, await readAll(response));
    return response;
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
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 500));
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

  private request(method: string, url: string, headers: Record<string, string>, body?: Buffer): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = http.request({ socketPath: this.socketPath, method, path: url, headers }, resolve);
      request.on("error", (error) => reject(unavailable(error)));
      request.end(body);
    });
  }
}

/** rclone's own words are for the log and the administrator; everyone else is told only that the remote failed. */
export function remoteFailure(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof RcloneError) {
    if (error.status === 404 || /not found|does not exist|no such file/i.test(error.message)) return new AppError(404, "Path not found", "PATH_NOT_FOUND");
    logger.warn("remote location failed", error.message);
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

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
