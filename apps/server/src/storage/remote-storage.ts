import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { nfc } from "../lib/filename.js";
import { id } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import type { RootService } from "../services/root.service.js";
import type { Root } from "../services/types.js";
import { providerOf } from "./providers.js";
import { remoteFailure, type RcloneClient, type RcloneItem, type RcloneStats } from "./rclone-client.js";

/** Where a remote location keeps what was deleted from it; never listed, never reachable by path. */
export const REMOTE_TRASH = ".kago-trash";
/** Tools that read a file from disk are given a copy of a remote one, which has to fit. */
const MAX_LOCAL_COPY_BYTES = 4 * 1024 * 1024 * 1024;
const LOCAL_COPY_MAX_AGE_MS = 12 * 60 * 60 * 1000;

export type RemoteEntry = { name: string; directory: boolean; size: number; mtimeMs: number };

export const isRemote = (root: Root) => root.provider !== "local";

/** The files of remote locations, addressed the way the rest of Kago addresses any file: a root and a logical path. */
export class RemoteStorage {
  private readonly cacheDir: string;
  private readonly copies = new Map<string, Promise<string>>();

  constructor(
    readonly client: RcloneClient,
    private readonly roots: RootService,
    private readonly env: Env
  ) {
    this.cacheDir = path.join(env.appDataDir, "temp", "remote");
  }

  /** The name rclone knows the root by, with the folder the location starts at. */
  fs(root: Root): string {
    return `${remoteName(root)}:${this.roots.remoteConfig(root).base}`;
  }

  /** A path inside the location as rclone wants it: relative, without a leading slash. */
  rel(logicalPath: string): string {
    return logicalPath.replace(/^\/+/, "");
  }

  /**
   * How many of a path's leading folders belong to the remote and not to Kago: the shares of a server
   * that was added whole. They can be opened, but not made, renamed, moved or removed.
   */
  fixedDepth(root: Root): number {
    const config = this.roots.remoteConfig(root);
    return providerOf(config.type).shares && !config.base ? 1 : 0;
  }

  /** Whether the path is the location itself or one of the remote's own folders. */
  isFixed(root: Root, logicalPath: string): boolean {
    return segmentsOf(logicalPath).length <= this.fixedDepth(root);
  }

  /** Whether the path is, or lies in, a trash folder: one sits at the top of the location, or of each share. */
  isTrash(root: Root, logicalPath: string): boolean {
    return segmentsOf(logicalPath)[this.fixedDepth(root)] === REMOTE_TRASH;
  }

  /** The trash folder that takes what is deleted at `logicalPath`: the one of the same share. */
  trashFolder(root: Root, logicalPath: string): string {
    return `/${[...segmentsOf(logicalPath).slice(0, this.fixedDepth(root)), REMOTE_TRASH].join("/")}`;
  }

  /** Whether the path is something Kago put directly inside a trash folder. */
  isTrashItem(root: Root, logicalPath: string): boolean {
    const segments = segmentsOf(logicalPath);
    const depth = this.fixedDepth(root);
    return logicalPath.startsWith("/") && segments.length === depth + 2 && segments[depth] === REMOTE_TRASH && !segments.includes("..") && !segments.includes(".");
  }

  async stat(root: Root, logicalPath: string): Promise<RemoteEntry | null> {
    const remote = this.rel(logicalPath);
    // The location itself is taken to be there; a remote that is down says so when it is listed.
    if (!remote) return { name: "", directory: true, size: 0, mtimeMs: 0 };
    try {
      // A share is not an entry of anything that can be asked about; it is found among the others.
      if (this.isFixed(root, logicalPath)) return (await this.list(root, path.posix.dirname(logicalPath))).find((entry) => entry.name === path.posix.basename(logicalPath)) ?? null;
      const item = await this.client.stat(this.fs(root), remote);
      return item ? entryOf(item) : null;
    } catch (error) {
      const failure = remoteFailure(error);
      if (failure.code === "PATH_NOT_FOUND") return null;
      throw failure;
    }
  }

  async list(root: Root, logicalPath: string): Promise<RemoteEntry[]> {
    const remote = this.rel(logicalPath);
    const items = await this.client.list(this.fs(root), remote).catch((error: unknown) => {
      throw remoteFailure(error);
    });
    const hidden = segmentsOf(logicalPath).length === this.fixedDepth(root);
    return items.map(entryOf).filter((entry) => !hidden || entry.name !== REMOTE_TRASH);
  }

  open(root: Root, logicalPath: string, range?: { start: number; end: number }): Promise<Readable> {
    // The remote is named alone and the folder goes with the path: the address rclone serves objects at
    // cannot hold a folder name with a bracket in it where the remote is named.
    const base = this.roots.remoteConfig(root).base;
    const fs = `${remoteName(root)}:${base.startsWith("/") ? "/" : ""}`;
    const remote = [base.replace(/^\/+/, ""), this.rel(logicalPath)].filter(Boolean).join("/");
    return this.client.open(fs, remote, range).catch((error: unknown) => {
      throw remoteFailure(error);
    });
  }

  /** Writes to a sibling first, keeping an old file recoverable until the replacement has landed. */
  async write(root: Root, logicalPath: string, source: Readable): Promise<void> {
    const remote = this.rel(logicalPath);
    const name = path.posix.basename(remote);
    if (!remote || !name || name === "." || name === "..") throw new AppError(400, "Invalid path", "INVALID_PATH");

    const fs = this.fs(root);
    const directory = path.posix.dirname(remote) === "." ? "" : path.posix.dirname(remote);
    const tempName = `.kago-write-${id("temp")}`;
    const backupName = `.kago-write-${id("backup")}`;
    const temp = path.posix.join(directory, tempName);
    const backup = path.posix.join(directory, backupName);
    const existing = await this.stat(root, logicalPath);
    if (existing?.directory) throw new AppError(409, "A folder already exists at the target", "TARGET_EXISTS");

    const remove = async (remotePath: string) => {
      await this.client.call("operations/deletefile", { fs, remote: remotePath }).catch(() => undefined);
    };
    const copy = (from: string, to: string) =>
      this.client.call("operations/copyfile", { srcFs: fs, srcRemote: from, dstFs: fs, dstRemote: to });
    const move = (from: string, to: string) =>
      this.client.call("operations/movefile", { srcFs: fs, srcRemote: from, dstFs: fs, dstRemote: to });

    try {
      await this.client.upload(fs, directory, tempName, source);
    } catch (error) {
      await remove(temp);
      throw remoteFailure(error);
    }

    let hasBackup = false;
    if (existing) {
      try {
        await copy(remote, backup);
        const saved = await this.client.stat(fs, backup);
        if (!saved || saved.IsDir || saved.Size !== existing.size) {
          throw new AppError(502, "Could not keep a recovery copy of the remote file", "REMOTE_BACKUP_FAILED");
        }
        hasBackup = true;
      } catch (error) {
        await remove(temp);
        await remove(backup);
        throw remoteFailure(error);
      }
    }

    try {
      await move(temp, remote);
    } catch (error) {
      await remove(temp);
      if (hasBackup) {
        try {
          // A failed move may have left a partial destination; the original is safe in `backup`.
          await remove(remote);
          await copy(backup, remote);
          await remove(backup);
        } catch (restoreError) {
          // Keep the copy when a provider cannot restore the original at its old name.
          logger.warn("remote write failed; a recovery copy remains in the remote location", {
            error: restoreError instanceof Error ? restoreError.message : String(restoreError)
          });
          throw new AppError(502, "The write failed; the original file was kept in a recovery copy on the remote location", "REMOTE_WRITE_RECOVERY_REQUIRED");
        }
      }
      throw remoteFailure(error);
    }

    if (hasBackup) {
      await this.client.call("operations/deletefile", { fs, remote: backup }).catch((error: unknown) => {
        logger.warn("remote write succeeded but its recovery copy could not be removed", error instanceof Error ? error.message : error);
      });
    }
  }

  async mkdir(root: Root, logicalPath: string): Promise<void> {
    await this.client.call("operations/mkdir", { fs: this.fs(root), remote: this.rel(logicalPath) }).catch((error: unknown) => {
      throw remoteFailure(error);
    });
  }

  /** Moves or renames within the one location. */
  async move(root: Root, from: string, to: string, directory: boolean): Promise<void> {
    const fs = this.fs(root);
    try {
      if (directory) {
        await this.client.call("sync/move", { srcFs: joinFs(fs, this.rel(from)), dstFs: joinFs(fs, this.rel(to)), deleteEmptySrcDirs: true });
        // A remote that takes two spellings for one name would be asked to remove the folder it has just been given.
        if (nfc(from).toLowerCase() !== nfc(to).toLowerCase()) await this.clearMoved(fs, this.rel(from));
      } else await this.client.call("operations/movefile", { srcFs: fs, srcRemote: this.rel(from), dstFs: fs, dstRemote: this.rel(to) });
    } catch (error) {
      throw remoteFailure(error);
    }
  }

  /**
   * Removes the folder a move has emptied. Moving file by file, rclone clears the folders inside its source
   * and leaves the source itself; one it could hand over whole is already gone.
   */
  async clearMoved(fs: string, remote: string): Promise<void> {
    try {
      // Asked first: rclone writes an error into the log for every folder it is told to remove and does not find.
      if (await this.client.stat(fs, remote)) await this.client.call("operations/rmdir", { fs, remote });
    } catch (error) {
      // Only an empty folder goes, and the move is done either way; what kept one there is logged, not thrown.
      remoteFailure(error);
    }
  }

  async remove(root: Root, logicalPath: string, directory: boolean): Promise<void> {
    await this.client.call(directory ? "operations/purge" : "operations/deletefile", { fs: this.fs(root), remote: this.rel(logicalPath) }).catch((error: unknown) => {
      throw remoteFailure(error);
    });
  }

  /** How much a file or a whole folder holds. */
  async size(root: Root, logicalPath: string, directory: boolean): Promise<{ bytes: number; count: number }> {
    if (!directory) return { bytes: (await this.stat(root, logicalPath))?.size ?? 0, count: 1 };
    const result = await this.client.call<{ bytes: number; count: number }>("operations/size", { fs: joinFs(this.fs(root), this.rel(logicalPath)) }).catch((error: unknown) => {
      throw remoteFailure(error);
    });
    return { bytes: Math.max(result.bytes, 0), count: result.count };
  }

  /**
   * Whether the remote cannot be told when a file was last changed (plain WebDAV, FTP): what is written there
   * is dated by its arrival, so times say only which side is newer, not whether two files are the same.
   */
  async keepsNoTimes(root: Root): Promise<boolean> {
    const info = await this.client.call<{ Precision: number }>("operations/fsinfo", { fs: this.fs(root) }).catch((error: unknown) => {
      throw remoteFailure(error);
    });
    return info.Precision > 60 * 60 * 1e9;
  }

  /** Every file and folder under a folder, parents before what they hold, with paths relative to it. */
  async walk(root: Root, logicalPath: string): Promise<Array<RemoteEntry & { path: string }>> {
    const result = await this.client
      .call<{ list: RcloneItem[] }>("operations/list", { fs: joinFs(this.fs(root), this.rel(logicalPath)), remote: "", opt: { recurse: true } })
      .catch((error: unknown) => {
        throw remoteFailure(error);
      });
    return result.list
      .map((item) => ({ ...entryOf(item), path: item.Path }))
      .filter((entry) => !this.isTrash(root, path.posix.join(logicalPath, entry.path)))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * A copy of a remote file on the server's own disk, for the tools that can only read one from there.
   * Copies are kept for a while under the file as it was, so a second look does not fetch it again.
   */
  async localCopy(root: Root, logicalPath: string, stat: { size: number; mtimeMs: number }): Promise<string> {
    if (stat.size > MAX_LOCAL_COPY_BYTES) throw new AppError(413, "The file is too large to be read from a remote location", "REMOTE_FILE_TOO_LARGE");
    const key = createHash("sha256").update(`${root.id}:${logicalPath}:${stat.mtimeMs}:${stat.size}`).digest("hex");
    // The name keeps its extension: several tools tell what a file is by it.
    const target = path.join(this.cacheDir, key, `file${path.extname(logicalPath).toLowerCase()}`);
    let copy = this.copies.get(target);
    if (!copy) {
      copy = (async () => {
        const existing = await fsp.stat(target).catch(() => null);
        if (existing && existing.size === stat.size) {
          await fsp.utimes(target, new Date(), new Date()).catch(() => undefined);
          return target;
        }
        await fsp.mkdir(path.dirname(target), { recursive: true });
        const partial = `${target}.${process.pid}.${Date.now()}.partial`;
        try {
          await pipeline(await this.open(root, logicalPath), createWriteStream(partial));
          await fsp.rename(partial, target);
        } finally {
          await fsp.rm(partial, { force: true });
        }
        return target;
      })().finally(() => this.copies.delete(target));
      this.copies.set(target, copy);
    }
    return copy;
  }

  async pruneLocalCopies(): Promise<void> {
    for (const name of await fsp.readdir(this.cacheDir).catch(() => [] as string[])) {
      const dir = path.join(this.cacheDir, name);
      const stats = await Promise.all((await fsp.readdir(dir).catch(() => [] as string[])).map((file) => fsp.stat(path.join(dir, file)).catch(() => null)));
      if (stats.every((stat) => !stat || Date.now() - stat.mtimeMs > LOCAL_COPY_MAX_AGE_MS)) await fsp.rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * An address ffmpeg can read a remote file at: Kago's own server, answering only itself.
   * It never changes for a file, so what is cached under it stays found.
   */
  inputUrl(root: Root, logicalPath: string): string {
    const segments = logicalPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    return `http://127.0.0.1:${this.env.port}/api/internal/blob/${root.id}/${this.signature(root.id, logicalPath)}/${segments}`;
  }

  verifyInputUrl(rootId: string, logicalPath: string, signature: string): boolean {
    const expected = Buffer.from(this.signature(rootId, logicalPath));
    const given = Buffer.from(signature);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private signature(rootId: string, logicalPath: string): string {
    return createHmac("sha256", this.env.sessionSecret).update(`internal-blob:${rootId}:${logicalPath}`).digest("hex");
  }
}

const segmentsOf = (logicalPath: string) => logicalPath.split("/").filter(Boolean);

export const remoteName = (root: Pick<Root, "id">) => `kago_${root.id}`;

/** An rclone address one folder further in. */
export function joinFs(fs: string, remote: string): string {
  if (!remote) return fs;
  return fs.endsWith(":") || fs.endsWith("/") ? `${fs}${remote}` : `${fs}/${remote}`;
}

export function transferProgress(onBytes: (bytes: number) => void, onName?: (name: string) => void): (stats: RcloneStats) => void {
  let reported = 0;
  return (stats) => {
    if (stats.bytes > reported) {
      onBytes(stats.bytes - reported);
      reported = stats.bytes;
    }
    const name = stats.transferring?.[0]?.name;
    if (name) onName?.(name);
  };
}

function entryOf(item: RcloneItem): RemoteEntry {
  const mtime = Date.parse(item.ModTime);
  return { name: item.Name, directory: item.IsDir, size: item.IsDir ? 0 : Math.max(item.Size, 0), mtimeMs: Number.isNaN(mtime) ? 0 : mtime };
}
