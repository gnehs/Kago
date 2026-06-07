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
    if (input.startsWith("/data/") || input === "/data") {
      throw new AppError(400, "Physical paths are not accepted", "PHYSICAL_PATH_REJECTED");
    }

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
    const absolutePath = await this.resolveInsideRoot(root, normalized);
    return { root, logicalPath: normalized, absolutePath };
  }

  async resolveForCreate(rootSlug: string, logicalPath: string): Promise<SafePath> {
    const root = this.roots.getBySlug(rootSlug);
    const normalized = this.normalizeLogicalPath(logicalPath);
    const absolutePath = path.join(root.base_path, normalized.slice(1));
    await this.assertParentInsideRoot(root, absolutePath);
    return { root, logicalPath: normalized, absolutePath };
  }

  async resolveRootById(rootId: string, logicalPath: string): Promise<SafePath> {
    const root = this.roots.getById(rootId);
    const normalized = this.normalizeLogicalPath(logicalPath);
    const absolutePath = await this.resolveInsideRoot(root, normalized);
    return { root, logicalPath: normalized, absolutePath };
  }

  private async resolveInsideRoot(root: Root, logicalPath: string): Promise<string> {
    const rootReal = await fs.realpath(root.base_path);
    const target = path.join(root.base_path, logicalPath.slice(1));
    const targetReal = await fs.realpath(target);
    if (!this.isInside(rootReal, targetReal)) {
      throw new AppError(403, "Path escapes root", "PATH_ESCAPES_ROOT");
    }
    return targetReal;
  }

  private async assertParentInsideRoot(root: Root, absolutePath: string): Promise<void> {
    const rootReal = await fs.realpath(root.base_path);
    const parentReal = await fs.realpath(path.dirname(absolutePath));
    if (!this.isInside(rootReal, parentReal)) {
      throw new AppError(403, "Path escapes root", "PATH_ESCAPES_ROOT");
    }
  }

  private isInside(rootReal: string, targetReal: string): boolean {
    const relative = path.relative(rootReal, targetReal);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }
}
