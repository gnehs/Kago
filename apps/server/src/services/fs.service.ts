import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { lookup } from "mime-types";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import type { AuditService } from "./audit.service.js";
import type { PathService } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { Actor } from "./types.js";

export const fsQuerySchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1).default("/")
});

export const mkdirSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1).max(255).refine((value) => !value.includes("/") && value !== ".." && !value.includes("\0"))
});

export class FsService {
  constructor(
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService
  ) {}

  async list(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "list", safe.root, safe.logicalPath);
    const stat = await fsp.stat(safe.absolutePath);
    if (!stat.isDirectory()) throw new AppError(400, "Path is not a folder", "NOT_FOLDER");

    const entries = await fsp.readdir(safe.absolutePath, { withFileTypes: true });
    const items = await Promise.all(
      entries
        .filter((entry) => !entry.name.includes("\0"))
        .map(async (entry) => {
          const itemPath = path.join(safe.absolutePath, entry.name);
          const itemStat = await fsp.lstat(itemPath);
          return {
            name: entry.name,
            path: path.posix.join(safe.logicalPath, entry.name),
            kind: entry.isDirectory() ? "folder" : "file",
            size: itemStat.size,
            mtime: itemStat.mtimeMs,
            type: entry.isDirectory() ? "folder" : lookup(entry.name) || "application/octet-stream",
            readonly: Boolean(safe.root.readonly)
          };
        })
    );

    return { rootSlug: safe.root.slug, path: safe.logicalPath, readonly: Boolean(safe.root.readonly), items };
  }

  async meta(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "read", safe.root, safe.logicalPath);
    const stat = await fsp.lstat(safe.absolutePath);
    return {
      rootSlug,
      path: safe.logicalPath,
      name: path.basename(safe.absolutePath),
      kind: stat.isDirectory() ? "folder" : "file",
      size: stat.size,
      mtime: stat.mtimeMs,
      type: stat.isDirectory() ? "folder" : lookup(safe.absolutePath) || "application/octet-stream"
    };
  }

  async download(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "download", safe.root, safe.logicalPath);
    const stat = await fsp.stat(safe.absolutePath);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "download",
      rootId: safe.root.id,
      path: safe.logicalPath,
      result: "success"
    });
    return { safe, stat, contentType: lookup(safe.absolutePath) || "application/octet-stream" };
  }

  async mkdir(actor: Actor, rootSlug: string, parentPath: string, name: string) {
    const parent = await this.paths.resolveExisting(rootSlug, parentPath);
    this.permissions.require(actor, "create_folder", parent.root, parent.logicalPath);
    const targetLogical = path.posix.join(parent.logicalPath, name);
    const target = await this.paths.resolveForCreate(rootSlug, targetLogical);
    await fsp.mkdir(target.absolutePath);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "mkdir",
      rootId: target.root.id,
      path: target.logicalPath,
      result: "success"
    });
    return this.meta(actor, rootSlug, targetLogical);
  }

  async upload(actor: Actor, rootSlug: string, parentPath: string, fileName: string, stream: NodeJS.ReadableStream) {
    if (!fileName || fileName.includes("/") || fileName.includes("..") || fileName.includes("\0") || fileName.length > 255) {
      throw new AppError(400, "Invalid filename", "INVALID_FILENAME");
    }
    const parent = await this.paths.resolveExisting(rootSlug, parentPath);
    this.permissions.require(actor, "upload", parent.root, parent.logicalPath);
    const target = await this.paths.resolveForCreate(rootSlug, path.posix.join(parent.logicalPath, fileName));
    const writeStream = fs.createWriteStream(target.absolutePath, { flags: "wx", mode: 0o644 });
    await pipeline(stream, writeStream);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "upload",
      rootId: target.root.id,
      path: target.logicalPath,
      result: "success"
    });
    return this.meta(actor, rootSlug, target.logicalPath);
  }
}
