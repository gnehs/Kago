import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
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

export const renameSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  name: z.string().min(1).max(255).refine((value) => !value.includes("/") && value !== ".." && !value.includes("\0"))
});

export class FsService {
  constructor(
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly appDataDir: string
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

  async rename(actor: Actor, rootSlug: string, logicalPath: string, name: string) {
    const source = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "rename", source.root, source.logicalPath);
    const targetLogical = path.posix.join(path.posix.dirname(source.logicalPath), name);
    const target = await this.paths.resolveForCreate(rootSlug, targetLogical);
    try {
      await fsp.access(target.absolutePath);
      throw new AppError(409, "Target already exists", "TARGET_EXISTS");
    } catch (error) {
      if (error instanceof AppError) throw error;
    }
    await fsp.rename(source.absolutePath, target.absolutePath);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "rename",
      rootId: source.root.id,
      path: source.logicalPath,
      target: { to: target.logicalPath },
      result: "success"
    });
    return this.meta(actor, rootSlug, target.logicalPath);
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

  async publicUpload(rootSlug: string, parentPath: string, fileName: string, stream: NodeJS.ReadableStream) {
    if (!fileName || fileName.includes("/") || fileName.includes("..") || fileName.includes("\0") || fileName.length > 255) {
      throw new AppError(400, "Invalid filename", "INVALID_FILENAME");
    }
    const parent = await this.paths.resolveExisting(rootSlug, parentPath);
    const target = await this.paths.resolveForCreate(rootSlug, path.posix.join(parent.logicalPath, fileName));
    const writeStream = fs.createWriteStream(target.absolutePath, { flags: "wx", mode: 0o644 });
    await pipeline(stream, writeStream);
    this.audit.write({
      actorType: "share_link",
      action: "upload_via_share",
      rootId: target.root.id,
      path: target.logicalPath,
      result: "success"
    });
    return { rootSlug, path: target.logicalPath, name: fileName };
  }

  async thumbnail(actor: Actor, rootSlug: string, logicalPath: string) {
    return this.prepareThumbnail(actor, rootSlug, logicalPath, true);
  }

  async warmThumbnail(actor: Actor, rootSlug: string, logicalPath: string) {
    await this.prepareThumbnail(actor, rootSlug, logicalPath, false);
  }

  private async prepareThumbnail(actor: Actor, rootSlug: string, logicalPath: string, auditAccess: boolean) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "read", safe.root, safe.logicalPath);
    const stat = await fsp.lstat(safe.absolutePath);
    const contentType = stat.isDirectory() ? "inode/directory" : lookup(safe.absolutePath) || "application/octet-stream";

    if (!stat.isDirectory() && String(contentType).startsWith("image/")) {
      if (auditAccess) this.auditThumbnail(actor, safe.root.id, safe.logicalPath);
      return { path: safe.absolutePath, contentType, stat };
    }

    const thumbnailPath = this.thumbnailCachePath(safe.root.id, safe.logicalPath, stat.mtimeMs, stat.size);
    try {
      const cachedStat = await fsp.stat(thumbnailPath);
      if (auditAccess) this.auditThumbnail(actor, safe.root.id, safe.logicalPath);
      return { path: thumbnailPath, contentType: "image/svg+xml", stat: cachedStat };
    } catch {
      await fsp.mkdir(path.dirname(thumbnailPath), { recursive: true });
      const svg = renderPlaceholderThumbnail({
        name: path.basename(safe.absolutePath) || safe.root.name,
        kind: stat.isDirectory() ? "folder" : "file",
        type: String(contentType)
      });
      await fsp.writeFile(thumbnailPath, svg, "utf8");
      const cachedStat = await fsp.stat(thumbnailPath);
      if (auditAccess) this.auditThumbnail(actor, safe.root.id, safe.logicalPath);
      return { path: thumbnailPath, contentType: "image/svg+xml", stat: cachedStat };
    }
  }

  private thumbnailCachePath(rootId: string, logicalPath: string, mtimeMs: number, size: number): string {
    const key = createHash("sha256").update(`${rootId}:${logicalPath}:${mtimeMs}:${size}`).digest("hex");
    return path.join(this.appDataDir, "thumbnails", `${key}.svg`);
  }

  private auditThumbnail(actor: Actor, rootId: string, logicalPath: string): void {
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "thumbnail",
      rootId,
      path: logicalPath,
      result: "success"
    });
  }
}

function renderPlaceholderThumbnail(input: { name: string; kind: "folder" | "file"; type: string }): string {
  const label = escapeXml(input.name.length > 24 ? `${input.name.slice(0, 21)}...` : input.name);
  const badge = input.kind === "folder" ? "資料夾" : escapeXml(shortType(input.type));
  const accent = input.kind === "folder" ? "#f6b331" : "#6f8fb4";
  const accentDark = input.kind === "folder" ? "#d99016" : "#426b94";
  const iconPath =
    input.kind === "folder"
      ? `<path d="M30 52h92a8 8 0 0 1 8 8v58a10 10 0 0 1-10 10H28a10 10 0 0 1-10-10V42a8 8 0 0 1 8-8h33l10 18z" fill="${accent}"/><path d="M18 61h112v57a10 10 0 0 1-10 10H28a10 10 0 0 1-10-10z" fill="#ffd166"/>`
      : `<path d="M42 24h54l22 22v82a10 10 0 0 1-10 10H42a10 10 0 0 1-10-10V34a10 10 0 0 1 10-10z" fill="#ffffff" stroke="#c9d3df" stroke-width="3"/><path d="M95 24v23h23" fill="#e8eef5"/><rect x="48" y="78" width="52" height="8" rx="4" fill="${accent}"/><rect x="48" y="96" width="72" height="8" rx="4" fill="#d9e2ec"/>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="180" height="140" viewBox="0 0 180 140" role="img" aria-label="${label}">
  <rect width="180" height="140" rx="16" fill="#f5f8fb"/>
  <rect x="10" y="10" width="160" height="120" rx="12" fill="#ffffff" stroke="#dbe4ee"/>
  <g transform="translate(26 0)">${iconPath}</g>
  <rect x="18" y="106" width="144" height="22" rx="11" fill="${accentDark}" opacity="0.92"/>
  <text x="90" y="121" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="11" font-weight="700" fill="#ffffff">${badge}</text>
  <text x="90" y="94" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" font-size="12" font-weight="600" fill="#2f3a45">${label}</text>
</svg>`;
}

function shortType(type: string): string {
  if (type === "application/octet-stream") return "檔案";
  const [group, subtype] = type.split("/");
  if (!group || !subtype) return "檔案";
  return subtype.length > 8 ? group : subtype.toUpperCase();
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
