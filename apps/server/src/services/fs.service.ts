import fs, { type Stats } from "node:fs";
import fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { lookup } from "mime-types";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { assertNameAvailable, isSafeLogicalSegment, nfc, safeRelativeZipPath } from "../lib/filename.js";
import { fileTagSchema, readFileTags, writeFileTags, type FileTag } from "../lib/file-tags.js";
import { MAX_SQLITE_PAGE, sqliteOverview, sqliteRows } from "../lib/sqlite-preview.js";
import { isPictureFormat, parseSubtitleName } from "../lib/subtitles.js";
import { isSystemFile } from "../lib/system-files.js";
import { Thumbnailer, type Crop, type ThumbnailSource } from "../lib/thumbnailer.js";
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

/** The picture to make a profile picture of, and the square of it to keep: without one, the middle. */
export const searchQuerySchema = fsQuerySchema.extend({ q: z.string().trim().min(1).max(200) });

export const avatarSchema = fsQuerySchema.extend({
  crop: z
    .object({
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      // The interface zooms in five times at most; this leaves it room, and still leaves something to look at.
      size: z.number().min(0.05).max(1)
    })
    .strict()
    .optional()
});

/** Which thumbnail of a file: the one its icon shows, or the larger one a picture's viewer shows while the picture itself is on its way. */
export const thumbnailQuerySchema = fsQuerySchema.extend({ size: z.enum(["small", "medium"]).default("small") });

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

/** Several entries of one location and the name each is to have. */
export const renameManySchema = z.object({
  rootSlug: z.string().min(1),
  items: z.array(renameSchema.omit({ rootSlug: true })).min(1).max(1000)
});

export const fileTagsSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  tags: z.array(fileTagSchema).max(100)
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
/** The longer side of a medium thumbnail: sharp across a window, and a fraction of what a camera's picture weighs. */
const MEDIUM_THUMBNAIL_EDGE = 2048;
/** A desktop background fills a screen, so it is kept up to the width of a 4K one. */
const WALLPAPER_EDGE = 3840;
/** A profile picture is only ever shown small; this is sharp at the largest it is drawn, on a dense screen. */
const AVATAR_EDGE = 512;
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

/** How many files of a folder being measured are asked about at once. */
const SIZE_STAT_BATCH = 64;
/** How many entries of a folder being listed are asked about at once. */
const LIST_STAT_BATCH = 8;
/** How many entries of a folder are handed over together, and how long the first of them waits for the rest. */
const LIST_BATCH = 500;
const LIST_BATCH_MS = 200;
/** How many matches a search hands over before it stops: past that, the words asked for say too little. */
const MAX_SEARCH_RESULTS = 1000;
/** How many batches may be waiting on what was asked about their entries while the folder is read further. */
const LIST_BATCHES_AHEAD = 3;

export type ListedItem = { name: string; path: string; kind: "folder" | "file"; size: number; mtime: number; type: string; readonly: boolean; tags: FileTag[] };
type Listing = { rootSlug: string; path: string; readonly: boolean; items: ListedItem[] };

export class FsService {
  private readonly thumbnailer: Thumbnailer;
  private keptPictureDirs?: Promise<Set<string>>;
  private readonly listings = new Map<string, Promise<Listing>>();

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
    const { safe, readonly } = await this.listable(actor, rootSlug, logicalPath);
    // A folder of very many files takes long to read: whoever asks meanwhile waits for the one reading, and starts no other.
    const key = `${safe.root.id}:${safe.logicalPath}`;
    let listing = this.listings.get(key);
    if (!listing) {
      listing = (async () => {
        const items: ListedItem[] = [];
        for await (const batch of this.batches(safe, readonly)) items.push(...batch);
        return { rootSlug: safe.root.slug, path: safe.logicalPath, readonly, items };
      })().finally(() => this.listings.delete(key));
      this.listings.set(key, listing);
    }
    return listing;
  }

  /**
   * A folder's listing handed over as it is read, a few entries at a time: the first of a very large folder
   * are there long before the last. `signal` is for whoever stopped waiting, and the reading stops with them.
   */
  async listStream(actor: Actor, rootSlug: string, logicalPath: string, signal?: AbortSignal) {
    const { safe, readonly } = await this.listable(actor, rootSlug, logicalPath);
    return { rootSlug: safe.root.slug, path: safe.logicalPath, readonly, batches: this.batches(safe, readonly, signal) };
  }

  private async listable(actor: Actor, rootSlug: string, logicalPath: string): Promise<{ safe: SafePath; readonly: boolean }> {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    if (!(await this.storage.stat(safe)).isDirectory()) throw new AppError(400, "Path is not a folder", "NOT_FOLDER");
    // Where the folders listed are a server's shares, nothing can be added beside them or done to them.
    const fixed = this.storage.isRemote(safe) && this.storage.remote.isFixed(safe.root, path.posix.join(safe.logicalPath, "child"));
    return { safe, readonly: Boolean(safe.root.readonly) || fixed };
  }

  private batches(safe: SafePath, readonly: boolean, signal?: AbortSignal): AsyncGenerator<ListedItem[]> {
    return this.storage.isRemote(safe) ? this.remoteBatches(safe, readonly) : this.localBatches(safe, readonly, signal);
  }

  private async *localBatches(safe: SafePath, readonly: boolean, signal?: AbortSignal): AsyncGenerator<ListedItem[]> {
    const dir = await fsp.opendir(safe.absolutePath, { bufferSize: 256 });
    try {
      // Reading goes on while the last few batches are still being asked about, and they are handed over in the order read.
      const described: Array<Promise<ListedItem[]>> = [];
      let batch: string[] = [];
      let started = 0;
      for (;;) {
        signal?.throwIfAborted();
        const entry = await dir.read();
        if (entry && !entry.name.includes("\0") && !isSystemFile(entry.name)) {
          if (batch.length === 0) started = Date.now();
          batch.push(entry.name);
        }
        const full = batch.length >= LIST_BATCH;
        // A folder slow to give up its names still shows what it has given so far.
        if (batch.length > 0 && (!entry || full || Date.now() - started >= LIST_BATCH_MS)) {
          described.push(this.describe(safe, readonly, batch));
          batch = [];
          while (described.length > (full ? LIST_BATCHES_AHEAD : 0)) yield await described.shift()!;
        }
        if (!entry) break;
      }
      while (described.length > 0) yield await described.shift()!;
    } finally {
      await dir.close().catch(() => undefined);
    }
  }

  private async describe(safe: SafePath, readonly: boolean, names: string[]): Promise<ListedItem[]> {
    const reading = readFileTags(safe.absolutePath, names);
    // Asked about a few at a time: every file operation of the server shares a handful of threads, and
    // a folder's worth of questions put to them at once keeps everything else waiting until the last is answered.
    const stats: Array<Stats | null> = [];
    for (let start = 0; start < names.length; start += LIST_STAT_BATCH) {
      stats.push(...(await Promise.all(names.slice(start, start + LIST_STAT_BATCH).map((name) => fsp.lstat(path.join(safe.absolutePath, name)).catch(() => null)))));
    }
    const tags = await reading;
    return names.flatMap((name, index) => {
      const stat = stats[index];
      // What went away while the folder was being read is not in it; a symlink is never shown.
      if (!stat || stat.isSymbolicLink()) return [];
      return {
        // `path` keeps the on-disk spelling and stays the item's identity; `name` is only for display.
        name: nfc(name),
        path: path.posix.join(safe.logicalPath, name),
        kind: stat.isDirectory() ? "folder" : "file",
        size: stat.size,
        mtime: stat.mtimeMs,
        type: stat.isDirectory() ? "folder" : lookup(name) || "application/octet-stream",
        readonly,
        tags: tags.get(name) ?? []
      };
    });
  }

  // A remote answers with the whole folder at once.
  private async *remoteBatches(safe: SafePath, readonly: boolean): AsyncGenerator<ListedItem[]> {
    const entries = (await this.storage.remote.list(safe.root, safe.logicalPath)).filter((entry) => !entry.name.includes("\0") && !isSystemFile(entry.name));
    const tags = await this.storage.remote.fileTags(safe.root, safe.logicalPath, entries.map((entry) => entry.name));
    yield entries.map((entry) => ({
      name: nfc(entry.name),
      path: path.posix.join(safe.logicalPath, entry.name),
      kind: entry.directory ? "folder" : "file",
      size: entry.size,
      mtime: entry.mtimeMs,
      type: entry.directory ? "folder" : lookup(entry.name) || "application/octet-stream",
      readonly,
      tags: tags.get(entry.name) ?? []
    }));
  }

  async meta(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    if (this.storage.isRemote(safe)) {
      const remote = await this.storage.stat(safe);
      const remoteName = this.storage.name(safe);
      const tags = await this.storage.remote.fileTags(safe.root, path.posix.dirname(safe.logicalPath), [remoteName]);
      return {
        rootSlug,
        path: safe.logicalPath,
        name: nfc(remoteName),
        kind: remote.isDirectory() ? "folder" : "file",
        size: remote.size,
        mtime: remote.mtimeMs,
        type: remote.isDirectory() ? "folder" : lookup(remoteName) || "application/octet-stream",
        tags: tags.get(remoteName) ?? []
      };
    }
    const stat = await fsp.lstat(safe.absolutePath);
    const name = path.basename(safe.absolutePath);
    const tags = await readFileTags(path.dirname(safe.absolutePath), [name]);
    return {
      rootSlug,
      path: safe.logicalPath,
      name: nfc(path.basename(safe.absolutePath)),
      kind: stat.isDirectory() ? "folder" : "file",
      size: stat.size,
      mtime: stat.mtimeMs,
      type: stat.isDirectory() ? "folder" : lookup(safe.absolutePath) || "application/octet-stream",
      tags: tags.get(name) ?? []
    };
  }

  /**
   * How much a folder holds, everything inside it counted: nothing keeps that figure, so the folder is read through
   * to tell it, which takes as long as the folder is large. `signal` is for whoever stopped waiting.
   * Counted as the folder is listed: without what the system left behind, and without following a symlink.
   */
  async size(actor: Actor, rootSlug: string, logicalPath: string, signal?: AbortSignal): Promise<{ bytes: number; count: number }> {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    if (this.storage.isRemote(safe)) return this.storage.remote.size(safe.root, safe.logicalPath, (await this.storage.stat(safe)).isDirectory(), signal);
    const stat = await fsp.lstat(safe.absolutePath);
    if (!stat.isDirectory()) return { bytes: stat.size, count: 1 };

    const total = { bytes: 0, count: 0 };
    const pending = [safe.absolutePath];
    for (let folder = pending.pop(); folder !== undefined; folder = pending.pop()) {
      signal?.throwIfAborted();
      // A folder that cannot be read, or that went away meanwhile, is counted as holding nothing.
      const entries = await fsp.readdir(folder, { withFileTypes: true }).catch(() => []);
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.name.includes("\0") || isSystemFile(entry.name)) continue;
        if (entry.isDirectory()) pending.push(path.join(folder, entry.name));
        else if (entry.isFile()) files.push(path.join(folder, entry.name));
      }
      for (let start = 0; start < files.length; start += SIZE_STAT_BATCH) {
        signal?.throwIfAborted();
        const stats = await Promise.all(files.slice(start, start + SIZE_STAT_BATCH).map((file) => fsp.lstat(file).catch(() => null)));
        for (const fileStat of stats) {
          if (!fileStat) continue;
          total.bytes += fileStat.size;
          total.count += 1;
        }
      }
    }
    return total;
  }

  /**
   * What a folder and every folder inside it hold whose name has each word of `query` in it, handed over as found:
   * the nearest first, since a folder is read through before those inside it. Nothing keeps an index of names, so
   * the folders are read as they are listed, without what the system left behind and without following a symlink.
   * Stops at `MAX_SEARCH_RESULTS`, and says so with `truncated`.
   */
  async search(actor: Actor, rootSlug: string, logicalPath: string, query: string, signal?: AbortSignal) {
    const { safe, readonly } = await this.listable(actor, rootSlug, logicalPath);
    const words = nfc(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) throw new AppError(400, "Nothing to search for", "INVALID_QUERY");
    const matches = (name: string) => {
      const folded = nfc(name).toLocaleLowerCase();
      return words.every((word) => folded.includes(word));
    };
    const state = { truncated: false };
    const batches = this.storage.isRemote(safe) ? this.remoteSearch(safe, matches, state) : this.localSearch(safe, readonly, matches, state, signal);
    return { rootSlug: safe.root.slug, path: safe.logicalPath, readonly, batches, state };
  }

  private async *localSearch(safe: SafePath, readonly: boolean, matches: (name: string) => boolean, state: { truncated: boolean }, signal?: AbortSignal): AsyncGenerator<ListedItem[]> {
    let found = 0;
    const pending = [{ absolutePath: safe.absolutePath, logicalPath: safe.logicalPath }];
    for (let index = 0; index < pending.length; index += 1) {
      signal?.throwIfAborted();
      const folder = pending[index]!;
      // A folder that cannot be read, or that went away meanwhile, holds nothing to find.
      const entries = await fsp.readdir(folder.absolutePath, { withFileTypes: true }).catch(() => []);
      const named: string[] = [];
      for (const entry of entries) {
        if (entry.name.includes("\0") || isSystemFile(entry.name)) continue;
        if (entry.isDirectory()) pending.push({ absolutePath: path.join(folder.absolutePath, entry.name), logicalPath: path.posix.join(folder.logicalPath, entry.name) });
        if (matches(entry.name)) named.push(entry.name);
      }
      if (named.length === 0) continue;
      const items = await this.describe({ ...safe, ...folder }, readonly, named.slice(0, MAX_SEARCH_RESULTS - found));
      found += items.length;
      if (items.length > 0) yield items;
      if (found >= MAX_SEARCH_RESULTS) {
        state.truncated = true;
        return;
      }
    }
  }

  // A remote is asked for everything inside the folder at once, and the names are looked through here.
  private async *remoteSearch(safe: SafePath, matches: (name: string) => boolean, state: { truncated: boolean }): AsyncGenerator<ListedItem[]> {
    const entries = (await this.storage.remote.walk(safe.root, safe.logicalPath)).filter((entry) => {
      const segments = entry.path.split("/");
      return !segments.some((segment) => segment.includes("\0") || isSystemFile(segment)) && matches(segments.at(-1)!);
    });
    if (entries.length > MAX_SEARCH_RESULTS) state.truncated = true;
    // The nearest first, as in a folder of the server's own.
    const found = entries.sort((a, b) => a.path.split("/").length - b.path.split("/").length).slice(0, MAX_SEARCH_RESULTS);
    const byFolder = new Map<string, typeof found>();
    for (const entry of found) {
      const folder = path.posix.join(safe.logicalPath, path.posix.dirname(entry.path));
      byFolder.set(folder, [...(byFolder.get(folder) ?? []), entry]);
    }
    for (const [folder, inside] of byFolder) {
      const tags = await this.storage.remote.fileTags(safe.root, folder, inside.map((entry) => entry.name)).catch(() => new Map<string, FileTag[]>());
      yield inside.map((entry) => {
        const logicalPath = path.posix.join(folder, entry.name);
        return {
          name: nfc(entry.name),
          path: logicalPath,
          kind: entry.directory ? "folder" : "file",
          size: entry.size,
          mtime: entry.mtimeMs,
          type: entry.directory ? "folder" : lookup(entry.name) || "application/octet-stream",
          readonly: Boolean(safe.root.readonly) || this.storage.remote.isFixed(safe.root, logicalPath),
          tags: tags.get(entry.name) ?? []
        };
      });
    }
  }

  async setFileTags(actor: Actor, input: z.infer<typeof fileTagsSchema>) {
    const safe = await this.paths.resolveExisting(input.rootSlug, input.path);
    this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
    const tags = input.tags.filter((tag, index) => input.tags.findIndex((other) => other.name === tag.name) === index);
    try {
      // Tags are kept on the file itself. Of the remotes, only an SMB server has a place for them.
      if (this.storage.isRemote(safe)) await this.storage.remote.setFileTags(safe.root, safe.logicalPath, tags);
      else await writeFileTags(path.dirname(safe.absolutePath), path.basename(safe.absolutePath), tags, await fsp.realpath(safe.root.base_path));
    } catch {
      throw new AppError(500, "This location cannot store tags", "TAGS_UNSUPPORTED");
    }
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "tag_update",
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

    const storage = this.storage;
    const paths = this.paths;
    async function* walkRemote(safe: SafePath, name: string): AsyncGenerator<ZipEntry> {
      const stat = await storage.stat(safe);
      const open = (logicalPath: string) => () => storage.remote.open(safe.root, logicalPath);
      yield { name, open: open(safe.logicalPath), directory: stat.isDirectory(), size: stat.size, mtime: stat.mtime };
      if (!stat.isDirectory()) return;
      for (const entry of await storage.remote.walk(safe.root, safe.logicalPath)) {
        // A name another system reads a separator in would climb out of the folder it is unpacked into.
        if (!safeRelativeZipPath(entry.path)) continue;
        const logicalPath = path.posix.join(safe.logicalPath, entry.path);
        yield { name: `${name}/${nfc(entry.path)}`, open: open(logicalPath), directory: entry.directory, size: entry.size, mtime: new Date(entry.mtimeMs) };
      }
    }
    async function* walk(root: SafePath["root"], absolutePath: string, logicalPath: string, name: string): AsyncGenerator<ZipEntry> {
      const stat = await fsp.lstat(absolutePath);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) return;
      yield { name, open: () => fs.createReadStream(absolutePath), directory: stat.isDirectory(), size: stat.size, mtime: stat.mtime };
      if (!stat.isDirectory()) return;
      for (const child of (await fsp.readdir(absolutePath)).sort()) {
        const childPath = path.posix.join(logicalPath, child);
        if (!isSafeLogicalSegment(child) || paths.isTrash(root, childPath)) continue;
        yield* walk(root, path.join(absolutePath, child), childPath, `${name}/${nfc(child)}`);
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
        else yield* walk(safe.root, safe.absolutePath, safe.logicalPath, name);
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
    // Written in place rather than swapped in: the file keeps its owner, mode, hard links and the tags stored on it.
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

  /** The subtitle files lying next to a video that are named after it. */
  async subtitles(actor: Actor, rootSlug: string, logicalPath: string) {
    const video = await this.preview(actor, rootSlug, logicalPath);
    if (this.storage.isRemote(video.safe)) return this.remoteSubtitles(video.safe);
    const folder = path.dirname(video.safe.absolutePath);
    const videoName = path.basename(video.safe.absolutePath);
    const names = await fsp.readdir(folder);
    const found = await Promise.all(
      names.map(async (name) => {
        const parsed = parseSubtitleName(videoName, name);
        if (!parsed) return null;
        const itemLogicalPath = path.posix.join(path.posix.dirname(video.safe.logicalPath), name);
        const stat = await fsp.lstat(path.join(folder, name));
        if (!stat.isFile()) return null;
        const picture = isPictureFormat(parsed.format);
        // A text subtitle is sent to the browser whole; a picture one is read by ffmpeg, however large.
        if (!picture && stat.size > MAX_SUBTITLE_BYTES) return null;
        if (parsed.format === "vobsub") {
          // The index is only a table of contents: the pictures are in the `.sub` of the same name, which is read with it.
          const data = `${name.slice(0, -3)}sub`;
          if (!names.includes(data)) return null;
        }
        return { path: itemLogicalPath, name: nfc(name), ...parsed, ...(picture ? { absolutePath: path.join(folder, name), stat } : {}) };
      })
    );
    return found.filter((item) => item !== null).sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));
  }

  private async remoteSubtitles(video: SafePath) {
    const folderPath = path.posix.dirname(video.logicalPath);
    const videoName = path.posix.basename(video.logicalPath);
    const found = await Promise.all(
      (await this.storage.remote.list(video.root, folderPath)).map(async (entry) => {
        const parsed = parseSubtitleName(videoName, entry.name);
        if (!parsed || entry.directory) return null;
        const itemLogicalPath = path.posix.join(folderPath, entry.name);
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
    const renamed = () => {
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
      return this.meta(actor, rootSlug, target.logicalPath);
    };
    if (this.storage.isRemote(source)) {
      if (source.logicalPath === "/") throw new AppError(400, "Invalid path", "INVALID_PATH");
      if (this.storage.remote.isFixed(source.root, source.logicalPath)) throw sharesAreFixed();
      const parent = await this.paths.resolveExisting(rootSlug, path.posix.dirname(source.logicalPath));
      // Unlike on disk, a remote is not asked to tell a name from its own other spelling: a rename to the name it has is refused.
      await this.storage.assertNameAvailable(parent, this.storage.name(target), target.logicalPath === source.logicalPath ? undefined : this.storage.name(source));
      if (target.logicalPath !== source.logicalPath && (await this.storage.remote.stat(target.root, target.logicalPath))) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
      const directory = (await this.storage.stat(source)).isDirectory();
      if (target.logicalPath !== source.logicalPath) await this.storage.remote.move(source.root, source.logicalPath, target.logicalPath, directory);
      return renamed();
    }
    const sourceStat = await fsp.lstat(source.absolutePath);
    await assertNameAvailable(path.dirname(target.absolutePath), path.basename(target.absolutePath), path.basename(source.absolutePath));
    // The source may answer to the new name itself (NFD -> NFC, or a case change on a case-insensitive volume); anything else there is a clash.
    const occupant = await fsp.lstat(target.absolutePath).catch(() => null);
    if (occupant && (occupant.dev !== sourceStat.dev || occupant.ino !== sourceStat.ino)) {
      throw new AppError(409, "Target already exists", "TARGET_EXISTS");
    }
    await fsp.rename(source.absolutePath, target.absolutePath);
    return renamed();
  }

  /**
   * Renames several entries of a location at once, each inside the folder it is in. Names may be handed around
   * (one takes the name another is giving up), so only what stays where it is can be in the way.
   * Either all of them are renamed or none is.
   */
  async renameMany(actor: Actor, rootSlug: string, items: Array<{ path: string; name: string }>) {
    // `id` tells an entry from the others, and `at` is where it is for now.
    type Move = { source: SafePath; target: SafePath; id: string; at: string; directory: boolean };
    const moves: Move[] = [];
    for (const item of items) {
      const source = await this.paths.resolveExisting(rootSlug, item.path);
      this.permissions.require(actor, "edit", source.root, source.logicalPath);
      if (source.logicalPath === "/") throw new AppError(400, "Invalid path", "INVALID_PATH");
      const target = await this.paths.resolveForCreate(rootSlug, path.posix.join(path.posix.dirname(source.logicalPath), item.name));
      moves.push({ source, target, id: source.logicalPath, at: source.logicalPath, directory: false });
    }
    const remote = this.storage.isRemote(moves[0]!.source);
    // On disk an entry is known by what it is rather than by its spelling, which a volume may take more than one of.
    const identity = async (absolutePath: string) => {
      const stat = await fsp.lstat(absolutePath).catch(() => null);
      return stat && `${stat.dev}:${stat.ino}`;
    };
    /** What is at a move's target now, as the `id` it would have as a source; null when the name is free. */
    const occupant = async (target: SafePath) => (remote ? ((await this.storage.remote.stat(target.root, target.logicalPath)) ? target.logicalPath : null) : identity(target.absolutePath));
    for (const move of moves) {
      if (remote) {
        if (this.storage.remote.isFixed(move.source.root, move.source.logicalPath)) throw sharesAreFixed();
        move.directory = (await this.storage.stat(move.source)).isDirectory();
      } else {
        move.id = (await identity(move.source.absolutePath)) ?? move.id;
        move.at = move.source.absolutePath;
      }
    }
    const ids = new Set(moves.map((move) => move.id));
    if (ids.size < moves.length) throw new AppError(400, "Invalid path", "INVALID_PATH");

    // Folder by folder: no two may end up with one name, and none with the name of an entry that is staying.
    const folders = new Map<string, Move[]>();
    for (const move of moves) {
      const folder = path.posix.dirname(move.source.logicalPath);
      folders.set(folder, [...(folders.get(folder) ?? []), move]);
    }
    for (const [folder, inFolder] of folders) {
      const leaving = new Set(inFolder.map((move) => this.storage.name(move.source)));
      const staying = (await this.storage.names(await this.paths.resolveExisting(rootSlug, folder))).filter((name) => !leaving.has(name));
      const taken = new Set<string>();
      for (const move of inFolder) {
        const name = nfc(this.storage.name(move.target));
        if (taken.has(name)) throw new AppError(409, "Multiple sources resolve to the same target", "TARGET_COLLISION");
        taken.add(name);
        if (staying.some((entry) => nfc(entry) === name)) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
        if (!remote) {
          const there = await occupant(move.target);
          if (there !== null && !ids.has(there)) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
        }
      }
    }

    const relocate = (move: Move, from: string, to: string) => (remote ? this.storage.remote.move(move.source.root, from, to, move.directory) : fsp.rename(from, to));
    const destination = (move: Move) => (remote ? move.target.logicalPath : move.target.absolutePath);
    const changed = moves.filter((move) => move.target.logicalPath !== move.source.logicalPath);
    const pending = new Map(changed.map((move) => [move.id, move]));
    const done: Array<{ move: Move; from: string; to: string }> = [];
    const aside = new Set<Move>();
    const step = async (move: Move, to: string) => {
      const from = move.at;
      await relocate(move, from, to);
      done.push({ move, from, to });
      move.at = to;
    };
    try {
      while (pending.size > 0) {
        let progressed = false;
        for (const move of [...pending.values()]) {
          const there = await occupant(move.target);
          if (there !== null && there !== move.id) {
            // Whoever has the name is about to give it up.
            if (pending.has(there)) continue;
            throw new AppError(409, "Target already exists", "TARGET_EXISTS");
          }
          await step(move, destination(move));
          pending.delete(move.id);
          progressed = true;
        }
        if (progressed) continue;
        // The names left go round in a ring: one entry steps aside under a name of its own, which frees the next.
        const move = [...pending.values()].find((candidate) => !aside.has(candidate))!;
        aside.add(move);
        await step(move, path.join(path.dirname(destination(move)), `.kago-rename-${randomUUID()}`));
      }
    } catch (error) {
      for (const { move, from, to } of done.reverse()) await relocate(move, to, from).catch(() => undefined);
      throw error;
    }

    for (const move of changed) {
      this.preferences.moved(move.source.root.id, move.source.logicalPath, move.target.root.id, move.target.logicalPath);
      this.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "rename",
        rootId: move.source.root.id,
        path: move.source.logicalPath,
        target: { to: move.target.logicalPath },
        result: "success"
      });
    }
    return { items: moves.map((move) => ({ from: move.source.logicalPath, path: move.target.logicalPath })) };
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
   * Anything else has no thumbnail, and its icon is drawn by the client alone. Only pictures have a medium one,
   * and only a drawn one: where the small one falls back on the file itself, the viewer is about to read that anyway.
   */
  async thumbnail(actor: Actor, rootSlug: string, logicalPath: string, medium = false): Promise<Thumbnail> {
    const thumbnail = await this.prepareThumbnail(actor, rootSlug, logicalPath, medium);
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

  private async prepareThumbnail(actor: Actor, rootSlug: string, logicalPath: string, medium = false): Promise<Thumbnail | null> {
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
    if (medium && source !== "image") return null;

    if (source) {
      // Thumbnails used to be laid on white. A picture that may be transparent is keyed apart from the one kept of it
      // then, so it is drawn again; a JPEG has nothing transparent in it, nor has the one made of a HEIF or a RAW.
      const clear = source === "image" && !rendition && contentType !== "image/jpeg";
      const key = createHash("sha256").update(`${safe.root.id}:${safe.logicalPath}:${stat.mtimeMs}:${stat.size}${medium ? ":medium" : ""}${clear ? ":clear" : ""}`).digest("hex");
      let picture: string | undefined;
      if (rendition) {
        const file = await onDisk();
        picture = file ? await this.images?.rendition(file, stat).catch(() => undefined) : undefined;
      } else if (!remote) picture = (await this.isKeptPicture(safe.absolutePath)) ? undefined : safe.absolutePath;
      else picture = source === "image" || source === "video" ? this.storage.mediaInput(safe) : await onDisk();
      const drawn = picture ? await this.thumbnailer.render(picture, key, source, medium ? MEDIUM_THUMBNAIL_EDGE : undefined) : null;
      if (drawn) return { contentType: "image/avif", path: drawn, size: (await fsp.stat(drawn)).size };
      if (medium) return null;
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
    await this.keepPicture(actor, rootSlug, logicalPath, { target: this.wallpaperPath(actor.id), edge: WALLPAPER_EDGE, action: "set_wallpaper", notPicture: new AppError(422, "Only a picture can be the desktop background", "NOT_A_PICTURE") });
  }

  async clearWallpaper(actor: Actor): Promise<void> {
    await fsp.rm(this.wallpaperPath(actor.id), { force: true });
  }

  /** Where a person's desktop background is kept. Ids are generated here, so they are safe as file names. */
  wallpaperPath(userId: string): string {
    return path.join(this.appDataDir, "wallpapers", `${userId}.avif`);
  }

  /**
   * Keeps a picture as the profile picture of whoever asks, the same way as their desktop background: one AVIF each
   * under `app-data/avatars`. It is shown in a circle, so only a square of it is kept: the one chosen, or the one
   * in its middle.
   */
  async setAvatar(actor: Actor, rootSlug: string, logicalPath: string, crop?: Crop): Promise<void> {
    await this.keepPicture(actor, rootSlug, logicalPath, { target: this.avatarPath(actor.id), edge: AVATAR_EDGE, square: crop ?? true, action: "set_avatar", notPicture: new AppError(422, "Only a picture can be a profile picture", "NOT_A_PICTURE") });
  }

  async clearAvatar(actor: Actor): Promise<void> {
    await fsp.rm(this.avatarPath(actor.id), { force: true });
  }

  /** Where a person's profile picture is kept. */
  avatarPath(userId: string): string {
    return path.join(this.appDataDir, "avatars", `${userId}.avif`);
  }

  /** Writes Kago's own copy of a picture the actor may see to `target`, so the file it came from can move or go. */
  private async keepPicture(actor: Actor, rootSlug: string, logicalPath: string, copy: { target: string; edge: number; square?: boolean | Crop; action: string; /** What to answer for a file that is not one. */ notPicture: AppError }): Promise<void> {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    const stat = await this.storage.stat(safe);
    const rendition = renditionKind(safe.logicalPath);
    if (!stat.isFile() || !(rendition || String(lookup(safe.logicalPath)).startsWith("image/"))) throw copy.notPicture;
    let picture: string | undefined;
    if (rendition) {
      const file = await this.storage.localFile(safe, stat);
      picture = await this.images?.rendition(file, stat);
    } else picture = this.storage.isRemote(safe) ? this.storage.mediaInput(safe) : safe.absolutePath;
    if (!picture || !(await this.thumbnailer.convert(picture, copy.target, copy.edge, copy.square))) throw new AppError(422, "The picture could not be converted", "PICTURE_FAILED");
    this.audit.write({ actorType: "user", actorId: actor.id, action: copy.action, rootId: safe.root.id, path: safe.logicalPath, result: "success" });
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
