import fs from "node:fs/promises";
import path from "node:path";
import type { RootService } from "./root.service.js";
import type { Root } from "./types.js";
import { AppError } from "../lib/errors.js";

export type SafePath = {
  root: Root;
  logicalPath: string;
  absolutePath: string;
};

export class PathService {
  constructor(private readonly roots: RootService) {}

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
    const root = this.roots.getBySlug(rootSlug);
    const normalized = this.normalizeLogicalPath(logicalPath);
    await this.assertNoSymlinkSegments(root, normalized);
    const absolutePath = await this.resolveInsideRoot(root, normalized);
    return { root, logicalPath: normalized, absolutePath };
  }

  async resolveForCreate(rootSlug: string, logicalPath: string): Promise<SafePath> {
    const root = this.roots.getBySlug(rootSlug);
    const normalized = this.normalizeLogicalPath(logicalPath);
    const parentLogical = path.posix.dirname(normalized);
    await this.assertNoSymlinkSegments(root, parentLogical === "." ? "/" : parentLogical);
    const absolutePath = path.join(root.base_path, normalized.slice(1));
    await this.assertParentInsideRoot(root, absolutePath);
    return { root, logicalPath: normalized, absolutePath };
  }

  async resolveRootById(rootId: string, logicalPath: string): Promise<SafePath> {
    const root = this.roots.getById(rootId);
    const normalized = this.normalizeLogicalPath(logicalPath);
    await this.assertNoSymlinkSegments(root, normalized);
    const absolutePath = await this.resolveInsideRoot(root, normalized);
    return { root, logicalPath: normalized, absolutePath };
  }

  private async assertNoSymlinkSegments(root: Root, logicalPath: string): Promise<void> {
    const segments = logicalPath.split("/").filter(Boolean);
    let current = root.base_path;
    for (const segment of segments) {
      current = path.join(current, segment);
      const stat = await lstatExisting(current);
      if (stat.isSymbolicLink()) {
        throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
      }
    }
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

async function lstatExisting(targetPath: string) {
  try {
    return await fs.lstat(targetPath);
  } catch (error) {
    if (isMissingPathError(error)) throw new AppError(404, "Path not found", "PATH_NOT_FOUND");
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
