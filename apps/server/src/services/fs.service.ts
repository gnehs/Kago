import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { lookup } from "mime-types";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { assertNameAvailable, nfc } from "../lib/filename.js";
import { readFinderTags, writeFinderTags } from "../lib/finder-tags.js";
import { MAX_SQLITE_PAGE, sqliteOverview, sqliteRows } from "../lib/sqlite-preview.js";
import { parseSubtitleName } from "../lib/subtitles.js";
import type { AuditService } from "./audit.service.js";
import type { PathService } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { Actor } from "./types.js";

/** Subtitles are read whole by the player; anything larger is not a text subtitle. */
const MAX_SUBTITLE_BYTES = 16 * 1024 * 1024;

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

// Object references in the stored list are one byte, and the path limit of a name is plenty for a tag.
export const finderTagsSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  tags: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(255).refine((value) => !/[\n\r\0]/.test(value)),
        color: z.enum(["gray", "green", "purple", "blue", "yellow", "red", "orange"]).nullable()
      })
    )
    .max(100)
});

/** The editor holds a file whole in the browser, and saves it whole. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024;

export const writeTextSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  /** The mtime of the copy that was edited; the save is refused when the file has changed since. */
  mtime: z.number().optional()
});

export const sqliteRowsSchema = fsQuerySchema.extend({
  table: z.string().min(1),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_SQLITE_PAGE).default(100)
});

export const maxUploadFiles = 20;

export class FsService {
  constructor(
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly appDataDir: string
  ) {}

  async list(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    const canListCurrent = this.permissions.can(actor, "list", safe.root, safe.logicalPath).allowed;
    if (!canListCurrent && !this.permissions.canReachListableDescendant(actor, safe.root, safe.logicalPath)) {
      this.permissions.require(actor, "list", safe.root, safe.logicalPath);
    }
    const stat = await fsp.stat(safe.absolutePath);
    if (!stat.isDirectory()) throw new AppError(400, "Path is not a folder", "NOT_FOLDER");

    const entries = await fsp.readdir(safe.absolutePath, { withFileTypes: true });
    const finderTags = await readFinderTags(safe.absolutePath, entries.map((entry) => entry.name));
    const listedItems = await Promise.all(
      entries
        .filter((entry) => !entry.name.includes("\0"))
        .map(async (entry) => {
          const itemPath = path.join(safe.absolutePath, entry.name);
          const itemStat = await fsp.lstat(itemPath);
          if (itemStat.isSymbolicLink()) return null;
          const itemLogicalPath = path.posix.join(safe.logicalPath, entry.name);
          if (
            !this.permissions.can(actor, "list", safe.root, itemLogicalPath).allowed &&
            !this.permissions.canReachListableDescendant(actor, safe.root, itemLogicalPath)
          ) {
            return null;
          }
          return {
            // `path` keeps the on-disk spelling and stays the item's identity; `name` is only for display.
            name: nfc(entry.name),
            path: itemLogicalPath,
            kind: entry.isDirectory() ? "folder" : "file",
            size: itemStat.size,
            mtime: itemStat.mtimeMs,
            type: entry.isDirectory() ? "folder" : lookup(entry.name) || "application/octet-stream",
            readonly: Boolean(safe.root.readonly),
            finderTags: finderTags.get(entry.name) ?? []
          };
        })
    );
    const items = listedItems.filter((item) => item !== null);

    return { rootSlug: safe.root.slug, path: safe.logicalPath, readonly: Boolean(safe.root.readonly), items };
  }

  async meta(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "read", safe.root, safe.logicalPath);
    const stat = await fsp.lstat(safe.absolutePath);
    const name = path.basename(safe.absolutePath);
    const finderTags = await readFinderTags(path.dirname(safe.absolutePath), [name]);
    return {
      rootSlug,
      path: safe.logicalPath,
      name: nfc(path.basename(safe.absolutePath)),
      kind: stat.isDirectory() ? "folder" : "file",
      size: stat.size,
      mtime: stat.mtimeMs,
      type: stat.isDirectory() ? "folder" : lookup(safe.absolutePath) || "application/octet-stream",
      finderTags: finderTags.get(name) ?? []
    };
  }

  async setFinderTags(actor: Actor, input: z.infer<typeof finderTagsSchema>) {
    const safe = await this.paths.resolveExisting(input.rootSlug, input.path);
    this.permissions.require(actor, "manage_tags", safe.root, safe.logicalPath);
    const tags = input.tags.filter((tag, index) => input.tags.findIndex((other) => other.name === tag.name) === index);
    try {
      await writeFinderTags(path.dirname(safe.absolutePath), path.basename(safe.absolutePath), tags);
    } catch {
      throw new AppError(500, "This location cannot store Finder tags", "FINDER_TAGS_UNSUPPORTED");
    }
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "finder_tag_update",
      rootId: safe.root.id,
      path: safe.logicalPath,
      target: { tags: tags.map((tag) => tag.name) },
      result: "success"
    });
    return this.meta(actor, input.rootSlug, safe.logicalPath);
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

  async preview(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "read", safe.root, safe.logicalPath);
    const stat = await fsp.stat(safe.absolutePath);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    return { safe, stat, contentType: lookup(safe.absolutePath) || "application/octet-stream" };
  }

  /** Replaces the text of an existing file with what was typed in the editor. */
  async writeText(actor: Actor, input: z.infer<typeof writeTextSchema>) {
    const safe = await this.paths.resolveExisting(input.rootSlug, input.path);
    // Saving over a file destroys what it held, so it takes the right to remove as well as the right to add.
    this.permissions.require(actor, "upload", safe.root, safe.logicalPath);
    this.permissions.require(actor, "delete", safe.root, safe.logicalPath);
    const stat = await fsp.stat(safe.absolutePath);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    if (Buffer.byteLength(input.content) > MAX_TEXT_BYTES) throw new AppError(413, "File is too large to edit", "FILE_TOO_LARGE");
    if (input.mtime !== undefined && Math.abs(stat.mtimeMs - input.mtime) >= 1) {
      throw new AppError(409, "The file was changed by someone else", "FILE_CHANGED");
    }
    // Written in place rather than swapped in: the file keeps its owner, mode, hard links and the Finder tags stored on it.
    await fsp.writeFile(safe.absolutePath, input.content, "utf8");
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "edit",
      rootId: safe.root.id,
      path: safe.logicalPath,
      result: "success"
    });
    return this.meta(actor, input.rootSlug, safe.logicalPath);
  }

  async sqliteOverview(actor: Actor, rootSlug: string, logicalPath: string) {
    const file = await this.preview(actor, rootSlug, logicalPath);
    return sqliteOverview(file.safe.absolutePath);
  }

  async sqliteRows(actor: Actor, input: z.infer<typeof sqliteRowsSchema>) {
    const file = await this.preview(actor, input.rootSlug, input.path);
    return sqliteRows(file.safe.absolutePath, file.stat.size, input.table, input.offset, input.limit);
  }

  /** The subtitle files lying next to a video that are named after it and that the actor may read. */
  async subtitles(actor: Actor, rootSlug: string, logicalPath: string) {
    const video = await this.preview(actor, rootSlug, logicalPath);
    const folder = path.dirname(video.safe.absolutePath);
    const videoName = path.basename(video.safe.absolutePath);
    const found = await Promise.all(
      (await fsp.readdir(folder)).map(async (name) => {
        const parsed = parseSubtitleName(videoName, name);
        if (!parsed) return null;
        const itemLogicalPath = path.posix.join(path.posix.dirname(video.safe.logicalPath), name);
        if (!this.permissions.can(actor, "read", video.safe.root, itemLogicalPath).allowed) return null;
        const stat = await fsp.lstat(path.join(folder, name));
        if (!stat.isFile() || stat.size > MAX_SUBTITLE_BYTES) return null;
        return { path: itemLogicalPath, name: nfc(name), ...parsed };
      })
    );
    return found.filter((item) => item !== null).sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
  }

  async mkdir(actor: Actor, rootSlug: string, parentPath: string, name: string) {
    const parent = await this.paths.resolveExisting(rootSlug, parentPath);
    this.permissions.require(actor, "create_folder", parent.root, parent.logicalPath);
    const targetLogical = path.posix.join(parent.logicalPath, name);
    const target = await this.paths.resolveForCreate(rootSlug, targetLogical);
    await assertNameAvailable(parent.absolutePath, path.basename(target.absolutePath));
    await fsp.mkdir(target.absolutePath);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "mkdir",
      rootId: target.root.id,
      path: target.logicalPath,
      result: "success"
    });
    return this.meta(actor, rootSlug, target.logicalPath);
  }

  async rename(actor: Actor, rootSlug: string, logicalPath: string, name: string) {
    const source = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "rename", source.root, source.logicalPath);
    const targetLogical = path.posix.join(path.posix.dirname(source.logicalPath), name);
    const target = await this.paths.resolveForCreate(rootSlug, targetLogical);
    const sourceStat = await fsp.lstat(source.absolutePath);
    await assertNameAvailable(path.dirname(target.absolutePath), path.basename(target.absolutePath), path.basename(source.absolutePath));
    // The source may answer to the new name itself (NFD -> NFC, or a case change on a case-insensitive volume); anything else there is a clash.
    const occupant = await fsp.lstat(target.absolutePath).catch(() => null);
    if (occupant && (occupant.dev !== sourceStat.dev || occupant.ino !== sourceStat.ino)) {
      throw new AppError(409, "Target already exists", "TARGET_EXISTS");
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
    await assertNameAvailable(parent.absolutePath, path.basename(target.absolutePath));
    const writeStream = fs.createWriteStream(target.absolutePath, { flags: "wx", mode: 0o666 });
    await this.writeUploadStream(stream, writeStream, target.absolutePath);
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

  async publicUpload(rootSlug: string, parentPath: string, fileName: string, stream: NodeJS.ReadableStream, shareId: string) {
    if (!fileName || fileName.includes("/") || fileName.includes("..") || fileName.includes("\0") || fileName.length > 255) {
      throw new AppError(400, "Invalid filename", "INVALID_FILENAME");
    }
    const parent = await this.paths.resolveExisting(rootSlug, parentPath);
    const target = await this.paths.resolveForCreate(rootSlug, path.posix.join(parent.logicalPath, fileName));
    await assertNameAvailable(parent.absolutePath, path.basename(target.absolutePath));
    const writeStream = fs.createWriteStream(target.absolutePath, { flags: "wx", mode: 0o666 });
    await this.writeUploadStream(stream, writeStream, target.absolutePath);
    this.audit.write({
      actorType: "share_link",
      actorId: shareId,
      action: "upload_via_share",
      rootId: target.root.id,
      path: target.logicalPath,
      result: "success"
    });
    return { rootSlug, path: target.logicalPath, name: nfc(fileName) };
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

  private async writeUploadStream(stream: NodeJS.ReadableStream, writeStream: fs.WriteStream, targetPath: string): Promise<void> {
    let opened = false;
    writeStream.on("open", () => {
      opened = true;
    });
    try {
      await pipeline(stream, writeStream);
    } catch (error) {
      if (opened) {
        try {
          await fsp.unlink(targetPath);
        } catch {
          // Best-effort cleanup for partial uploads.
        }
      }
      throw error;
    }
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
