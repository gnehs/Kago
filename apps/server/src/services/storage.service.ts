import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { AppError } from "../lib/errors.js";
import { sameName } from "../lib/filename.js";
import { isRemote, type RemoteStorage } from "../storage/remote-storage.js";
import type { SafePath } from "./path.service.js";

/** What Kago needs to know of a file wherever it is kept. Satisfied by `fs.Stats`. */
export type FileStat = { size: number; mtimeMs: number; mtime: Date; isFile(): boolean; isDirectory(): boolean };

/** A file's bytes, whole or in part, from wherever they are kept. */
export type FileSource = { size: number; mtimeMs: number; open(range?: { start: number; end: number }): Readable | Promise<Readable> };

export const localSource = (absolutePath: string, stat: { size: number; mtimeMs: number }): FileSource => ({
  size: stat.size,
  mtimeMs: stat.mtimeMs,
  open: (range) => fs.createReadStream(absolutePath, range)
});

/**
 * The few things done alike to a file on disk and to one in a remote location.
 * What only the one or the other can do stays with the service that does it.
 */
export class StorageService {
  constructor(readonly remote: RemoteStorage) {}

  isRemote(safe: SafePath): boolean {
    return isRemote(safe.root);
  }

  async stat(safe: SafePath): Promise<FileStat> {
    if (!isRemote(safe.root)) return fsp.stat(safe.absolutePath);
    const entry = safe.entry ?? (await this.remote.stat(safe.root, safe.logicalPath));
    if (!entry) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
    return { size: entry.size, mtimeMs: entry.mtimeMs, mtime: new Date(entry.mtimeMs), isFile: () => !entry.directory, isDirectory: () => entry.directory };
  }

  /** The file's own name, as it is stored. */
  name(safe: SafePath): string {
    return isRemote(safe.root) ? path.posix.basename(safe.logicalPath) : path.basename(safe.absolutePath);
  }

  source(safe: SafePath, stat: { size: number; mtimeMs: number }): FileSource {
    if (!isRemote(safe.root)) return localSource(safe.absolutePath, stat);
    return { size: stat.size, mtimeMs: stat.mtimeMs, open: (range) => this.remote.open(safe.root, safe.logicalPath, range) };
  }

  /** A path on the server's disk holding the file: its own, or that of a copy fetched from the remote. */
  async localFile(safe: SafePath, stat: { size: number; mtimeMs: number }): Promise<string> {
    return isRemote(safe.root) ? this.remote.localCopy(safe.root, safe.logicalPath, stat) : safe.absolutePath;
  }

  /** What ffmpeg is given to read the file from: its path, or an address it can fetch and seek in. */
  mediaInput(safe: SafePath): string {
    return isRemote(safe.root) ? this.remote.inputUrl(safe.root, safe.logicalPath) : safe.absolutePath;
  }

  /** The names in a folder, as they are stored. */
  async names(safe: SafePath): Promise<string[]> {
    if (!isRemote(safe.root)) return fsp.readdir(safe.absolutePath);
    return (await this.remote.list(safe.root, safe.logicalPath)).map((entry) => entry.name);
  }

  /** Refuses a new name that reads the same as one already in the folder; see `assertNameAvailable`. */
  async assertNameAvailable(folder: SafePath, name: string, ignore?: string): Promise<void> {
    if ((await this.names(folder)).some((entry) => entry !== ignore && sameName(entry, name))) {
      throw new AppError(409, "Target already exists", "TARGET_EXISTS");
    }
  }
}

