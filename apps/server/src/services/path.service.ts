import fs from "node:fs/promises";
import path from "node:path";
import type { RootService } from "./root.service.js";
import type { Root } from "./types.js";
import { AppError } from "../lib/errors.js";
import { nfc, sameName } from "../lib/filename.js";
import { isRemote, type RemoteEntry, type RemoteStorage } from "../storage/remote-storage.js";

export type SafePath = {
  root: Root;
  logicalPath: string;
  /** Where the file is on the server's disk. A path in a remote location has none, and reading this throws. */
  absolutePath: string;
  /** What a remote location said of the path when it was resolved. */
  entry?: RemoteEntry;
};

export class PathService {
  constructor(
    private readonly roots: RootService,
    private readonly remote: RemoteStorage
  ) {}

  normalizeLogicalPath(input: string): string {
    if (input.includes("\0")) throw new AppError(400, "Invalid path", "INVALID_PATH");
    if (input.includes("\\")) throw new AppError(400, "Invalid path separator", "INVALID_PATH");
    if (input.startsWith("/data/") || input === "/data") {
      throw new AppError(400, "Physical paths are not accepted", "PHYSICAL_PATH_REJECTED");
    }
    const rawSegments = input.split("/");
    if (rawSegments.includes("..")) throw new AppError(400, "Invalid path", "INVALID_PATH");

    const withSlash = input.startsWith("/") ? input : `/${input}`;
    const normalized = path.posix.normalize(withSlash);
    if (normalized.includes("\0") || normalized.split("/").includes("..")) {
      throw new AppError(400, "Invalid path", "INVALID_PATH");
    }
    return normalized === "." ? "/" : normalized;
  }

  async resolveExisting(rootSlug: string, logicalPath: string): Promise<SafePath> {
    return this.resolveExistingIn(this.roots.getBySlug(rootSlug), logicalPath);
  }

  private async resolveExistingIn(root: Root, logicalPath: string): Promise<SafePath> {
    if (isRemote(root)) return this.resolveRemote(root, this.normalizeLogicalPath(logicalPath));
    const normalized = await this.resolveSegments(root, this.normalizeLogicalPath(logicalPath));
    const absolutePath = await this.resolveInsideRoot(root, normalized);
    return { root, logicalPath: normalized, absolutePath };
  }

  async resolveForCreate(rootSlug: string, logicalPath: string): Promise<SafePath> {
    const root = this.roots.getBySlug(rootSlug);
    const requested = this.normalizeLogicalPath(logicalPath);
    if (isRemote(root)) {
      const parent = await this.resolveRemote(root, path.posix.dirname(requested));
      if (!parent.entry?.directory) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
      const logical = path.posix.join(parent.logicalPath, nfc(path.posix.basename(requested)));
      if (this.remote.isTrash(root, logical)) throw new AppError(400, "Invalid path", "INVALID_PATH");
      if (this.remote.isFixed(root, logical)) throw sharesAreFixed();
      return remotePath(root, logical);
    }
    const parentLogical = await this.resolveSegments(root, path.posix.dirname(requested));
    // Anything Kago creates is written in NFC, whatever form the client sent.
    const normalized = path.posix.join(parentLogical, nfc(path.posix.basename(requested)));
    const absolutePath = path.join(root.base_path, normalized.slice(1));
    await this.assertParentInsideRoot(root, absolutePath);
    return { root, logicalPath: normalized, absolutePath };
  }

  async resolveRootById(rootId: string, logicalPath: string): Promise<SafePath> {
    return this.resolveExistingIn(this.roots.getById(rootId), logicalPath);
  }

  /**
   * A path in a remote location, spelled the way the remote stores it. Like on disk, a name that is not there
   * byte for byte falls back to the one entry of its folder with the same NFC form.
   */
  private async resolveRemote(root: Root, logicalPath: string): Promise<SafePath> {
    if (this.remote.isTrash(root, logicalPath)) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
    const entry = await this.remote.stat(root, logicalPath);
    if (entry) return remotePath(root, logicalPath, entry);
    const parent = await this.resolveRemote(root, path.posix.dirname(logicalPath));
    if (!parent.entry?.directory) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
    const name = path.posix.basename(logicalPath);
    const matches = (await this.remote.list(root, parent.logicalPath)).filter((item) => sameName(item.name, name));
    if (matches.length !== 1) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
    return remotePath(root, path.posix.join(parent.logicalPath, matches[0]!.name), matches[0]);
  }

  /**
   * Walks the path on disk, rejecting symlinks, and returns it spelled the way the filesystem stores it.
   * A segment that is missing byte-for-byte falls back to the one entry with the same NFC form,
   * so a typed NFC path still reaches a file whose name is stored as NFD (and vice versa).
   */
  private async resolveSegments(root: Root, logicalPath: string): Promise<string> {
    const resolved: string[] = [];
    let current = root.base_path;
    for (const segment of logicalPath.split("/").filter(Boolean)) {
      let name = segment;
      let stat = await lstatIfExists(path.join(current, name));
      if (!stat) {
        const matches = (await readdirIfExists(current)).filter((entry) => sameName(entry, segment));
        if (matches.length !== 1) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
        name = matches[0]!;
        stat = await lstatExisting(path.join(current, name));
      }
      if (stat.isSymbolicLink()) {
        throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
      }
      current = path.join(current, name);
      resolved.push(name);
    }
    return `/${resolved.join("/")}`;
  }

  private async resolveInsideRoot(root: Root, logicalPath: string): Promise<string> {
    const rootReal = await resolveRealPath(root.base_path);
    const target = path.join(root.base_path, logicalPath.slice(1));
    const targetReal = await resolveRealPath(target);
    if (!this.isInside(rootReal, targetReal)) {
      throw new AppError(403, "Path escapes root", "PATH_ESCAPES_ROOT");
    }
    return targetReal;
  }

  private async assertParentInsideRoot(root: Root, absolutePath: string): Promise<void> {
    const rootReal = await resolveRealPath(root.base_path);
    const parentReal = await resolveRealPath(path.dirname(absolutePath));
    if (!this.isInside(rootReal, parentReal)) {
      throw new AppError(403, "Path escapes root", "PATH_ESCAPES_ROOT");
    }
  }

  private isInside(rootReal: string, targetReal: string): boolean {
    const relative = path.relative(rootReal, targetReal);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }
}

/** Refuses what would make, rename, move or remove one of a server's shares. */
export const sharesAreFixed = () => new AppError(403, "The shares of a server can’t be changed from here", "REMOTE_SHARES_FIXED");

function remotePath(root: Root, logicalPath: string, entry?: RemoteEntry): SafePath {
  const safe = { root, logicalPath, entry } as SafePath;
  // Not enumerable, so the path can still be copied and logged; anything that reaches for a file on disk is stopped here.
  Object.defineProperty(safe, "absolutePath", {
    get() {
      throw new AppError(501, "This is not available in a remote location", "REMOTE_UNSUPPORTED");
    }
  });
  return safe;
}

async function lstatExisting(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
    throw error;
  }
}

async function lstatIfExists(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function readdirIfExists(targetPath: string): Promise<string[]> {
  try {
    return await fs.readdir(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}

async function resolveRealPath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
