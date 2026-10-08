import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lookup } from "mime-types";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { assertNameAvailable, nfc } from "../lib/filename.js";
import { readFinderTags, writeFinderTags } from "../lib/finder-tags.js";
import { MAX_SQLITE_PAGE, sqliteOverview, sqliteRows } from "../lib/sqlite-preview.js";
import { isPictureFormat, parseSubtitleName } from "../lib/subtitles.js";
import { Thumbnailer, type ThumbnailSource } from "../lib/thumbnailer.js";
import type { ZipEntry } from "../lib/zip-stream.js";
import type { AuditService } from "./audit.service.js";
import { renditionKind, type ImageService } from "./image.service.js";
import { sharesAreFixed, type PathService, type SafePath } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { PreferenceService } from "./preference.service.js";
import type { StorageService } from "./storage.service.js";
import type { Actor } from "./types.js";

/** Subtitles are read whole by the player; anything larger is not a text subtitle. */
const MAX_SUBTITLE_BYTES = 16 * 1024 * 1024;

export const fsQuerySchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1).default("/")
});

/** One path or several: a repeated query parameter arrives as a list, a single one as a string. */
export const zipQuerySchema = z.object({
  rootSlug: z.string().min(1),
  path: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(1000)]).transform((value) => (typeof value === "string" ? [value] : value))
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

/** A thumbnail is either a file on disk (a drawn picture, or the original) or a few bytes of text. */
export type Thumbnail = { contentType: string; path: string; size: number } | { contentType: string; data: Buffer };

/** Enough for the dozen or so lines that fit on an icon. */
const TEXT_EXCERPT_BYTES = 2048;
/** Pictures a browser shows by itself, which can stand in for a thumbnail that could not be drawn. */
const BROWSER_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml", "image/avif", "image/bmp", "image/apng", "image/x-icon", "image/vnd.microsoft.icon"]);
/** Documents that may carry a preview picture of their first page inside the file. */
const EMBEDDED_PREVIEW_EXTENSIONS = new Set(["docx", "docm", "xlsx", "xlsm", "pptx", "pptm", "ppsx", "odt", "ods", "odp", "pages", "numbers", "key"]);
const MAX_ORIGINAL_THUMBNAIL_BYTES = 8 * 1024 * 1024;
/** A desktop background fills a screen, so it is kept up to the width of a 4K one. */
const WALLPAPER_EDGE = 3840;
const isVideoType = (type: string) => type.startsWith("video/") || type.startsWith("application/vnd.rn-realmedia");

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
  private readonly thumbnailer: Thumbnailer;
  private keptPictureDirs?: Promise<Set<string>>;

  constructor(
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly appDataDir: string,
    private readonly preferences: PreferenceService,
    /** Absent in the task worker, which then draws no thumbnails for camera RAW. */
    private readonly images?: ImageService
  ) {
    this.thumbnailer = new Thumbnailer(path.join(appDataDir, "thumbnails"));
  }

  async list(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    const canListCurrent = this.permissions.can(actor, "view", safe.root, safe.logicalPath).allowed;
    if (!canListCurrent && !this.permissions.canReachDescendant(actor, safe.root, safe.logicalPath)) {
      this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    }
    if (this.storage.isRemote(safe)) return this.listRemote(actor, safe);
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
            !this.permissions.can(actor, "view", safe.root, itemLogicalPath).allowed &&
            !this.permissions.canReachDescendant(actor, safe.root, itemLogicalPath)
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

  private async listRemote(actor: Actor, safe: SafePath) {
    if (!(await this.storage.stat(safe)).isDirectory()) throw new AppError(400, "Path is not a folder", "NOT_FOLDER");
    // Where the folders listed are a server's shares, nothing can be added beside them or done to them.
    const readonly = Boolean(safe.root.readonly) || this.storage.remote.isFixed(safe.root, path.posix.join(safe.logicalPath, "child"));
    const items = (await this.storage.remote.list(safe.root, safe.logicalPath))
      .filter((entry) => !entry.name.includes("\0"))
      .map((entry) => {
        const itemLogicalPath = path.posix.join(safe.logicalPath, entry.name);
        if (!this.permissions.can(actor, "view", safe.root, itemLogicalPath).allowed && !this.permissions.canReachDescendant(actor, safe.root, itemLogicalPath)) return null;
        return {
          name: nfc(entry.name),
          path: itemLogicalPath,
          kind: entry.directory ? "folder" : "file",
          size: entry.size,
          mtime: entry.mtimeMs,
          type: entry.directory ? "folder" : lookup(entry.name) || "application/octet-stream",
          readonly,
          finderTags: []
        };
      })
      .filter((item) => item !== null);
    return { rootSlug: safe.root.slug, path: safe.logicalPath, readonly, items };
  }

  async meta(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    if (this.storage.isRemote(safe)) {
      const remote = await this.storage.stat(safe);
      const remoteName = this.storage.name(safe);
      return {
        rootSlug,
        path: safe.logicalPath,
        name: nfc(remoteName),
        kind: remote.isDirectory() ? "folder" : "file",
        size: remote.size,
        mtime: remote.mtimeMs,
        type: remote.isDirectory() ? "folder" : lookup(remoteName) || "application/octet-stream",
        finderTags: []
      };
    }
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
    this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
    // Finder tags are an attribute of a file on disk; a remote has nowhere to keep them.
    if (this.storage.isRemote(safe)) throw new AppError(500, "This location cannot store Finder tags", "FINDER_TAGS_UNSUPPORTED");
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
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    const stat = await this.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "download",
      rootId: safe.root.id,
      path: safe.logicalPath,
      result: "success"
    });
    return { safe, stat, name: this.storage.name(safe), source: this.storage.source(safe, stat), contentType: lookup(safe.logicalPath) || "application/octet-stream" };
  }

  /**
   * A selection as one archive, written while it is read: its address alone says what is in it, and nothing is prepared first.
   * Whatever the actor may not download, and any symlink, is left out rather than failing an archive that is already on its way.
   */
  async downloadZip(actor: Actor, rootSlug: string, logicalPaths: string[]): Promise<{ fileName: string; entries: AsyncGenerator<ZipEntry> }> {
    const resolved: SafePath[] = [];
    for (const logicalPath of logicalPaths) {
      const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
      this.permissions.require(actor, "view", safe.root, safe.logicalPath);
      resolved.push(safe);
    }
    // A folder already brings everything inside it.
    const sources = resolved.filter((safe, index) => resolved.findIndex((other) => other.logicalPath === safe.logicalPath) === index && !resolved.some((other) => safe.logicalPath.startsWith(`${other.logicalPath}/`)));
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "download_zip",
      rootId: sources[0]!.root.id,
      target: { sources: sources.map((safe) => ({ rootSlug, path: safe.logicalPath })) },
      result: "success"
    });

    const permissions = this.permissions;
    const storage = this.storage;
    async function* walkRemote(safe: SafePath, name: string): AsyncGenerator<ZipEntry> {
      const stat = await storage.stat(safe);
      const allowed = (logicalPath: string) => permissions.can(actor, "view", safe.root, logicalPath).allowed;
      if (!allowed(safe.logicalPath)) return;
      const open = (logicalPath: string) => () => storage.remote.open(safe.root, logicalPath);
      yield { name, open: open(safe.logicalPath), directory: stat.isDirectory(), size: stat.size, mtime: stat.mtime };
      if (!stat.isDirectory()) return;
      // What sits under a folder the actor may not download is left out along with it.
      const denied: string[] = [];
      for (const entry of await storage.remote.walk(safe.root, safe.logicalPath)) {
        const logicalPath = path.posix.join(safe.logicalPath, entry.path);
        if (entry.path.includes("\0") || denied.some((prefix) => logicalPath.startsWith(prefix))) continue;
        if (!allowed(logicalPath)) {
          denied.push(`${logicalPath}/`);
          continue;
        }
        yield { name: `${name}/${nfc(entry.path)}`, open: open(logicalPath), directory: entry.directory, size: entry.size, mtime: new Date(entry.mtimeMs) };
      }
    }
    async function* walk(absolutePath: string, logicalPath: string, name: string): AsyncGenerator<ZipEntry> {
      const stat = await fsp.lstat(absolutePath);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return;
      if (!permissions.can(actor, "view", sources[0]!.root, logicalPath).allowed) return;
      yield { name, open: () => fs.createReadStream(absolutePath), directory: stat.isDirectory(), size: stat.size, mtime: stat.mtime };
      if (!stat.isDirectory()) return;
      for (const child of (await fsp.readdir(absolutePath)).sort()) {
        if (child.includes("\0")) continue;
        yield* walk(path.join(absolutePath, child), path.posix.join(logicalPath, child), `${name}/${nfc(child)}`);
      }
    }
    async function* entries(): AsyncGenerator<ZipEntry> {
      // Items picked from different folders can share a name; inside the archive each needs its own.
      const taken = new Set<string>();
      for (const safe of sources) {
        const base = nfc(storage.name(safe));
        let name = base;
        for (let copy = 2; taken.has(name); copy += 1) name = `${path.parse(base).name} ${copy}${path.parse(base).ext}`;
        taken.add(name);
        if (storage.isRemote(safe)) yield* walkRemote(safe, name);
        else yield* walk(safe.absolutePath, safe.logicalPath, name);
      }
    }
    return { fileName: sources.length === 1 ? `${nfc(storage.name(sources[0]!))}.zip` : "Kago.zip", entries: entries() };
  }

  async preview(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    const stat = await this.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    return { safe, stat, name: this.storage.name(safe), source: this.storage.source(safe, stat), contentType: lookup(safe.logicalPath) || "application/octet-stream" };
  }

  /** The file where ffmpeg can read it, with what tells one version of it from the next. */
  async media(actor: Actor, rootSlug: string, logicalPath: string) {
    const file = await this.preview(actor, rootSlug, logicalPath);
    return { ...file, input: this.storage.mediaInput(file.safe) };
  }

  /** The file where a tool that reads from disk can open it; a remote one is fetched first. */
  async localFile(actor: Actor, rootSlug: string, logicalPath: string) {
    const file = await this.preview(actor, rootSlug, logicalPath);
    return { ...file, localPath: await this.storage.localFile(file.safe, file.stat) };
  }

  /** Replaces the text of an existing file with what was typed in the editor. */
  async writeText(actor: Actor, input: z.infer<typeof writeTextSchema>) {
    const safe = await this.paths.resolveExisting(input.rootSlug, input.path);
    // Saving over a file destroys what it held, so it takes the right to remove as well as the right to add.
    this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
    const stat = await this.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    if (Buffer.byteLength(input.content) > MAX_TEXT_BYTES) throw new AppError(413, "File is too large to edit", "FILE_TOO_LARGE");
    if (input.mtime !== undefined && Math.abs(stat.mtimeMs - input.mtime) >= 1) {
      throw new AppError(409, "The file was changed by someone else", "FILE_CHANGED");
    }
    // Written in place rather than swapped in: the file keeps its owner, mode, hard links and the Finder tags stored on it.
    if (this.storage.isRemote(safe)) await this.storage.remote.write(safe.root, safe.logicalPath, Readable.from([Buffer.from(input.content, "utf8")]));
    else await fsp.writeFile(safe.absolutePath, input.content, "utf8");
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
    const file = await this.localFile(actor, rootSlug, logicalPath);
    return sqliteOverview(file.localPath);
  }

  async sqliteRows(actor: Actor, input: z.infer<typeof sqliteRowsSchema>) {
    const file = await this.localFile(actor, input.rootSlug, input.path);
    return sqliteRows(file.localPath, file.stat.size, input.table, input.offset, input.limit);
  }

  /** The subtitle files lying next to a video that are named after it and that the actor may read. */
  async subtitles(actor: Actor, rootSlug: string, logicalPath: string) {
    const video = await this.preview(actor, rootSlug, logicalPath);
    if (this.storage.isRemote(video.safe)) return this.remoteSubtitles(actor, video.safe);
    const folder = path.dirname(video.safe.absolutePath);
    const videoName = path.basename(video.safe.absolutePath);
    const names = await fsp.readdir(folder);
    const found = await Promise.all(
      names.map(async (name) => {
        const parsed = parseSubtitleName(videoName, name);
        if (!parsed) return null;
        const itemLogicalPath = path.posix.join(path.posix.dirname(video.safe.logicalPath), name);
        if (!this.permissions.can(actor, "view", video.safe.root, itemLogicalPath).allowed) return null;
        const stat = await fsp.lstat(path.join(folder, name));
        if (!stat.isFile()) return null;
        const picture = isPictureFormat(parsed.format);
        // A text subtitle is sent to the browser whole; a picture one is read by ffmpeg, however large.
        if (!picture && stat.size > MAX_SUBTITLE_BYTES) return null;
        if (parsed.format === "vobsub") {
          // The index is only a table of contents: the pictures are in the `.sub` of the same name, which is read with it.
          const data = `${name.slice(0, -3)}sub`;
          if (!names.includes(data) || !this.permissions.can(actor, "view", video.safe.root, path.posix.join(path.posix.dirname(video.safe.logicalPath), data)).allowed) return null;
        }
        return { path: itemLogicalPath, name: nfc(name), ...parsed, ...(picture ? { absolutePath: path.join(folder, name), stat } : {}) };
      })
    );
    return found.filter((item) => item !== null).sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
  }

  private async remoteSubtitles(actor: Actor, video: SafePath) {
    const folderPath = path.posix.dirname(video.logicalPath);
    const videoName = path.posix.basename(video.logicalPath);
    const found = await Promise.all(
      (await this.storage.remote.list(video.root, folderPath)).map(async (entry) => {
        const parsed = parseSubtitleName(videoName, entry.name);
        if (!parsed || entry.directory) return null;
        const itemLogicalPath = path.posix.join(folderPath, entry.name);
        if (!this.permissions.can(actor, "view", video.root, itemLogicalPath).allowed) return null;
        const picture = isPictureFormat(parsed.format);
        if (!picture && entry.size > MAX_SUBTITLE_BYTES) return null;
        // A DVD index is read together with the file beside it, which a copy fetched on its own does not have.
        if (parsed.format === "vobsub") return null;
        const stat = { size: entry.size, mtimeMs: entry.mtimeMs };
        return { path: itemLogicalPath, name: nfc(entry.name), ...parsed, ...(picture ? { absolutePath: await this.storage.remote.localCopy(video.root, itemLogicalPath, stat), stat } : {}) };
      })
    );
    return found.filter((item) => item !== null).sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
  }

  async mkdir(actor: Actor, rootSlug: string, parentPath: string, name: string) {
    const parent = await this.paths.resolveExisting(rootSlug, parentPath);
    this.permissions.require(actor, "edit", parent.root, parent.logicalPath);
    const targetLogical = path.posix.join(parent.logicalPath, name);
    const target = await this.paths.resolveForCreate(rootSlug, targetLogical);
    if (this.storage.isRemote(parent)) {
      await this.storage.assertNameAvailable(parent, this.storage.name(target));
      await this.storage.remote.mkdir(target.root, target.logicalPath);
    } else {
      await assertNameAvailable(parent.absolutePath, path.basename(target.absolutePath));
      await fsp.mkdir(target.absolutePath);
    }
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
    this.permissions.require(actor, "edit", source.root, source.logicalPath);
    const targetLogical = path.posix.join(path.posix.dirname(source.logicalPath), name);
    const target = await this.paths.resolveForCreate(rootSlug, targetLogical);
    const rebaseRenameState = () => this.permissions.rebasePathRules(
      source.root.id,
      source.logicalPath,
      target.root.id,
      target.logicalPath,
      () => {
        this.preferences.moved(source.root.id, source.logicalPath, target.root.id, target.logicalPath);
        this.audit.write({
          actorType: "user",
          actorId: actor.id,
          action: "rename",
          rootId: source.root.id,
          path: source.logicalPath,
          target: { to: target.logicalPath },
          result: "success"
        });
      }
    );
    const renameResult = async () => {
      // A rename grant can be independent from read. Avoid reporting a failure after the rename
      // has committed just because the moved path remains unreadable under its preserved ACL.
      if (this.permissions.can(actor, "view", target.root, target.logicalPath).allowed) {
        return this.meta(actor, rootSlug, target.logicalPath);
      }
      return { rootSlug, path: target.logicalPath, name: nfc(path.posix.basename(target.logicalPath)) };
    };
    if (this.storage.isRemote(source)) {
      if (source.logicalPath === "/") throw new AppError(400, "Invalid path", "INVALID_PATH");
      if (this.storage.remote.isFixed(source.root, source.logicalPath)) throw sharesAreFixed();
      const parent = await this.paths.resolveExisting(rootSlug, path.posix.dirname(source.logicalPath));
      // Unlike on disk, a remote is not asked to tell a name from its own other spelling: a rename to the name it has is refused.
      await this.storage.assertNameAvailable(parent, this.storage.name(target), target.logicalPath === source.logicalPath ? undefined : this.storage.name(source));
      if (target.logicalPath !== source.logicalPath && (await this.storage.remote.stat(target.root, target.logicalPath))) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
      const directory = (await this.storage.stat(source)).isDirectory();
      const moved = target.logicalPath !== source.logicalPath;
      if (moved) await this.storage.remote.move(source.root, source.logicalPath, target.logicalPath, directory);
      try {
        rebaseRenameState();
      } catch (error) {
        if (moved) {
          try {
            if (await this.storage.remote.stat(source.root, source.logicalPath)) {
              throw new Error("The original remote path is occupied");
            }
            await this.storage.remote.move(source.root, target.logicalPath, source.logicalPath, directory);
          } catch {
            throw new AppError(500, "Permission update failed and the remote rename could not be rolled back", "RENAME_ROLLBACK_FAILED");
          }
        }
        throw error;
      }
      return renameResult();
    }
    const sourceStat = await fsp.lstat(source.absolutePath);
    await assertNameAvailable(path.dirname(target.absolutePath), path.basename(target.absolutePath), path.basename(source.absolutePath));
    // The source may answer to the new name itself (NFD -> NFC, or a case change on a case-insensitive volume); anything else there is a clash.
    const occupant = await fsp.lstat(target.absolutePath).catch(() => null);
    if (occupant && (occupant.dev !== sourceStat.dev || occupant.ino !== sourceStat.ino)) {
      throw new AppError(409, "Target already exists", "TARGET_EXISTS");
    }
    await fsp.rename(source.absolutePath, target.absolutePath);
    try {
      rebaseRenameState();
    } catch (error) {
      try {
        const movedEntry = await fsp.lstat(target.absolutePath);
        if (movedEntry.dev !== sourceStat.dev || movedEntry.ino !== sourceStat.ino) {
          throw new Error("The renamed path no longer refers to the source entry");
        }
        const sourceOccupant = await fsp.lstat(source.absolutePath).catch((sourceError: unknown) => {
          if (isMissingFsEntry(sourceError)) return null;
          throw sourceError;
        });
        if (sourceOccupant && (sourceOccupant.dev !== sourceStat.dev || sourceOccupant.ino !== sourceStat.ino)) {
          throw new Error("The original path is occupied");
        }
        await fsp.rename(target.absolutePath, source.absolutePath);
      } catch {
        throw new AppError(500, "Permission update failed and the filesystem rename could not be rolled back", "RENAME_ROLLBACK_FAILED");
      }
      throw error;
    }
    return renameResult();
  }

  async upload(actor: Actor, rootSlug: string, parentPath: string, fileName: string, stream: NodeJS.ReadableStream) {
    if (!fileName || fileName.includes("/") || fileName.includes("..") || fileName.includes("\0") || fileName.length > 255) {
      throw new AppError(400, "Invalid filename", "INVALID_FILENAME");
    }
    const parent = await this.paths.resolveExisting(rootSlug, parentPath);
    this.permissions.require(actor, "edit", parent.root, parent.logicalPath);
    const target = await this.paths.resolveForCreate(rootSlug, path.posix.join(parent.logicalPath, fileName));
    await this.writeNewFile(parent, target, stream);
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
    await this.writeNewFile(parent, target, stream);
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

  /**
   * What a file's icon shows of its contents: a small picture for images and videos, the opening lines for text.
   * Anything else has no thumbnail, and its icon is drawn by the client alone.
   */
  async thumbnail(actor: Actor, rootSlug: string, logicalPath: string): Promise<Thumbnail> {
    const thumbnail = await this.prepareThumbnail(actor, rootSlug, logicalPath);
    if (!thumbnail) throw new AppError(404, "No thumbnail for this file", "NO_THUMBNAIL");
    return thumbnail;
  }

  /**
   * Whether a file is one of Kago's own thumbnails or converted pictures, seen through a location that holds its data
   * folder. Drawing those would fill the folder with thumbnails of thumbnails for as long as someone looks at it.
   * Folders are told apart by what they are on disk, not by path: the same one may be mounted in two places.
   */
  private async isKeptPicture(absolutePath: string): Promise<boolean> {
    const kept = await (this.keptPictureDirs ??= Promise.all(["thumbnails", "previews"].map((name) => folderIdentity(path.join(this.appDataDir, name)))).then((ids) => new Set(ids.filter((id) => id !== null))));
    const folder = await folderIdentity(path.dirname(absolutePath));
    return folder !== null && kept.has(folder);
  }

  pruneThumbnails(): Promise<number> {
    return this.thumbnailer.prune();
  }

  async warmThumbnail(actor: Actor, rootSlug: string, logicalPath: string) {
    await this.prepareThumbnail(actor, rootSlug, logicalPath);
  }

  private async prepareThumbnail(actor: Actor, rootSlug: string, logicalPath: string): Promise<Thumbnail | null> {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    const stat = await this.storage.stat(safe);
    if (!stat.isFile() || stat.size === 0) return null;
    this.auditThumbnail(actor, safe.root.id, safe.logicalPath);
    const contentType = String(lookup(safe.logicalPath) || "application/octet-stream");
    const extension = path.extname(safe.logicalPath).slice(1).toLowerCase();
    const remote = this.storage.isRemote(safe);
    // ffmpeg reads a remote picture or video over the wire; everything else that draws needs the file on disk.
    const onDisk = () => this.storage.localFile(safe, stat).catch(() => undefined);
    // HEIF and camera RAW are drawn from the JPEG made of them: a HEIF is a grid of tiles, a RAW holds its picture inside.
    const rendition = renditionKind(safe.logicalPath);
    const source: ThumbnailSource | null = rendition || contentType.startsWith("image/")
      ? "image"
      : isVideoType(contentType)
        ? "video"
        : contentType === "application/pdf"
          ? "pdf"
          : EMBEDDED_PREVIEW_EXTENSIONS.has(extension)
            ? "embedded"
            : null;

    if (source) {
      const key = createHash("sha256").update(`${safe.root.id}:${safe.logicalPath}:${stat.mtimeMs}:${stat.size}`).digest("hex");
      let picture: string | undefined;
      if (rendition) {
        const file = await onDisk();
        picture = file ? await this.images?.rendition(file, stat).catch(() => undefined) : undefined;
      } else if (!remote) picture = (await this.isKeptPicture(safe.absolutePath)) ? undefined : safe.absolutePath;
      else picture = source === "image" || source === "video" ? this.storage.mediaInput(safe) : await onDisk();
      const drawn = picture ? await this.thumbnailer.render(picture, key, source) : null;
      if (drawn) return { contentType: "image/avif", path: drawn, size: (await fsp.stat(drawn)).size };
      // Without ffmpeg, or for a picture it cannot read, the browser is handed the original when it can show it.
      if (BROWSER_IMAGE_TYPES.has(contentType) && stat.size <= MAX_ORIGINAL_THUMBNAIL_BYTES) {
        const original = await onDisk();
        if (original) return { contentType, path: original, size: stat.size };
      }
      if (source !== "video") return null;
    }

    // The type registry reads `.ts` as a video; what ffmpeg could not draw may still be text.
    const excerpt = remote ? await readTextExcerptFrom(await this.storage.remote.open(safe.root, safe.logicalPath, { start: 0, end: Math.min(stat.size, TEXT_EXCERPT_BYTES) - 1 })) : await readTextExcerpt(safe.absolutePath);
    return excerpt === null ? null : { contentType: "text/plain; charset=utf-8", data: Buffer.from(excerpt, "utf8") };
  }

  /**
   * Keeps a picture as the desktop background of whoever asks: one AVIF each under `app-data/wallpapers`,
   * so a new one takes the place of the last.
   */
  async setWallpaper(actor: Actor, rootSlug: string, logicalPath: string): Promise<void> {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    const stat = await this.storage.stat(safe);
    const rendition = renditionKind(safe.logicalPath);
    if (!stat.isFile() || !(rendition || String(lookup(safe.logicalPath)).startsWith("image/"))) throw new AppError(422, "Only a picture can be the desktop background", "NOT_A_PICTURE");
    let picture: string | undefined;
    if (rendition) {
      const file = await this.storage.localFile(safe, stat);
      picture = await this.images?.rendition(file, stat);
    } else picture = this.storage.isRemote(safe) ? this.storage.mediaInput(safe) : safe.absolutePath;
    if (!picture || !(await this.thumbnailer.convert(picture, this.wallpaperPath(actor.id), WALLPAPER_EDGE))) throw new AppError(422, "The picture could not be converted", "WALLPAPER_FAILED");
    this.audit.write({ actorType: "user", actorId: actor.id, action: "set_wallpaper", rootId: safe.root.id, path: safe.logicalPath, result: "success" });
  }

  async clearWallpaper(actor: Actor): Promise<void> {
    await fsp.rm(this.wallpaperPath(actor.id), { force: true });
  }

  /** Where a person's desktop background is kept. Ids are generated here, so they are safe as file names. */
  wallpaperPath(userId: string): string {
    return path.join(this.appDataDir, "wallpapers", `${userId}.avif`);
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

  /** Stores an uploaded stream as a file that was not there before. */
  private async writeNewFile(parent: SafePath, target: SafePath, stream: NodeJS.ReadableStream): Promise<void> {
    if (this.storage.isRemote(parent)) {
      await this.storage.assertNameAvailable(parent, this.storage.name(target));
      await this.storage.remote.write(target.root, target.logicalPath, Readable.from(stream));
      return;
    }
    await assertNameAvailable(parent.absolutePath, path.basename(target.absolutePath));
    const writeStream = fs.createWriteStream(target.absolutePath, { flags: "wx", mode: 0o666 });
    await this.writeUploadStream(stream, writeStream, target.absolutePath);
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

const folderIdentity = (dir: string) =>
  fsp.stat(dir, { bigint: true }).then(
    (stat) => `${stat.dev}:${stat.ino}`,
    () => null
  );

function isMissingFsEntry(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

async function readTextExcerptFrom(stream: Readable): Promise<string | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return decodeExcerpt(Buffer.concat(chunks).subarray(0, TEXT_EXCERPT_BYTES));
}

/** The start of a file as text, or null when it does not read as UTF-8 text. */
async function readTextExcerpt(absolutePath: string): Promise<string | null> {
  const handle = await fsp.open(absolutePath, "r");
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(TEXT_EXCERPT_BYTES), 0, TEXT_EXCERPT_BYTES, 0);
    return decodeExcerpt(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

function decodeExcerpt(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  // The excerpt may end in the middle of a character; up to three bytes are dropped to find a clean end.
  for (let cut = 0; cut <= 3 && cut <= bytes.length; cut += 1) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - cut));
    } catch {
      if (bytes.length < TEXT_EXCERPT_BYTES) return null;
    }
  }
  return null;
}
