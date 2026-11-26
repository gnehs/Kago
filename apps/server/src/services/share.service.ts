import { createHmac, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { lookup } from "mime-types";
import type { FileItem, PublicShareInfo, ShareFolderPage, ShareItem, ShareKind, ShareLink, ShareMode, ShareSortBy } from "@kago/contract";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AttemptLimiter, guesserOf } from "../lib/attempts.js";
import type { SecretBox } from "../lib/secret-box.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { nfc } from "../lib/filename.js";
import { id, now } from "../lib/ids.js";
import { isSystemFile } from "../lib/system-files.js";
import { isBrowserViewable } from "../lib/viewable.js";
import type { ZipEntry } from "../lib/zip-stream.js";
import type { AuditService } from "./audit.service.js";
import type { FsService, Thumbnail } from "./fs.service.js";
import type { PathService, SafePath } from "./path.service.js";
import type { StorageService } from "./storage.service.js";
import type { Level, PermissionService } from "./permission.service.js";
import type { Actor } from "./types.js";
import type { EventPublisher } from "../ws/events.js";

export const shareSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  mode: z.enum(["view_only", "download", "upload_only"]),
  password: z.string().min(8).max(1024).optional(),
  expiresAt: z.number().int().optional(),
  maxDownloads: z.number().int().positive().optional()
});

/** One page of a shared folder, sorted as the file browser sorts it. */
export const shareListQuerySchema = z.object({
  path: z.string().min(1).default("/"),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  sortBy: z.enum(["name", "size", "mtime", "type"]).default("name"),
  direction: z.enum(["asc", "desc"]).default("asc")
});

/** A link fixed in place: null takes its expiry or its limit away. */
export const sharePatchSchema = z.object({
  disabled: z.boolean().optional(),
  expiresAt: shareSchema.shape.expiresAt.unwrap().nullable().optional(),
  maxDownloads: shareSchema.shape.maxDownloads.unwrap().nullable().optional()
});

/** How many wrong passwords one address may try for one link, and for all links, before it is made to wait. */
const SHARE_TRIES = 5;
const SHARE_TRIES_PER_ADDRESS = 50;
/** For how long someone who was counted against a link's limit may come back to it without being counted again. */
export const SHARE_VISIT_SECONDS = 12 * 60 * 60;
/** For how long the right password, once given, opens a link: the cookie that carries it lasts as long. */
export const SHARE_ACCESS_SECONDS = 12 * 60 * 60;

/** Who is asking for a link: where from, and the cookie the link's page was given. */
export type ShareVisitor = { address: string; session?: string };

/** What a visitor asks a link for. */
type ShareUse = "list" | "download" | "preview" | "thumbnail" | "zip" | "upload";

/** What each mode lets a visitor do, and what a link of it may be made to. */
const SHARE_MODES: Record<ShareMode, { uses: ReadonlySet<ShareUse>; kinds: ReadonlySet<ShareKind> }> = {
  download: { uses: new Set(["list", "download", "preview", "thumbnail", "zip"]), kinds: new Set(["file", "folder"]) },
  view_only: { uses: new Set(["list", "preview", "thumbnail"]), kinds: new Set(["file", "folder"]) },
  upload_only: { uses: new Set(["upload"]), kinds: new Set(["folder"]) }
};

/** What a visitor is told when the link's mode leaves something out. An archive is a download, and a thumbnail a look. */
const FORBIDDEN: Record<ShareUse, () => AppError> = {
  list: () => new AppError(403, "This share's folder cannot be listed", "SHARE_LIST_FORBIDDEN"),
  download: () => new AppError(403, "Download is not allowed for this share", "SHARE_DOWNLOAD_FORBIDDEN"),
  zip: () => new AppError(403, "Download is not allowed for this share", "SHARE_DOWNLOAD_FORBIDDEN"),
  preview: () => new AppError(403, "Preview is not allowed for this share", "SHARE_PREVIEW_FORBIDDEN"),
  thumbnail: () => new AppError(403, "Preview is not allowed for this share", "SHARE_PREVIEW_FORBIDDEN"),
  upload: () => new AppError(403, "Upload is not allowed for this share", "SHARE_UPLOAD_FORBIDDEN")
};

const FOLDER_USES: ReadonlySet<ShareUse> = new Set(["list", "zip", "upload"]);

/**
 * A visitor's archive is planned whole before its first byte, so it is refused up front rather than cut off partway.
 * Its files are stored, not compressed: what people hand around is mostly pictures and videos, which do not shrink,
 * and deflating them would spend a core of the server on each visitor.
 */
const SHARE_ZIP_ENTRIES = 20_000;
const SHARE_ZIP_BYTES = 32 * 1024 ** 3;
/** How many archives may be written at once through one link, and through all of them. */
const SHARE_ZIPS_PER_LINK = 2;
const SHARE_ZIPS_AT_ONCE = 4;

/** For how long a folder once read is paged through without being read again, and how many such are kept. */
const LISTING_MS = 30_000;
const LISTINGS_KEPT = 32;

const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const notFound = () => new AppError(404, "Path not found", "PATH_NOT_FOUND");

export class ShareService {
  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly storage: StorageService,
    private readonly files: FsService,
    private readonly secret: string,
    private readonly secrets: SecretBox
  ) {}

  private readonly attempts = new AttemptLimiter();
  private readonly listings = new Map<string, { at: number; items: ShareItem[] }>();
  private readonly zipping = new Map<string, number>();

  list(actor: Actor): ShareLink[] {
    const items =
      actor.role === "ADMIN"
        ? rows<ListedShare>(this.db.prepare(`${LISTED_SHARE} ORDER BY share_links.created_at DESC`).all())
        : rows<ListedShare>(this.db.prepare(`${LISTED_SHARE} WHERE share_links.created_by = ? ORDER BY share_links.created_at DESC`).all(actor.id));
    return items.map((share) => this.publicShare(share));
  }

  async create(actor: Actor, input: z.infer<typeof shareSchema>) {
    const safe = await this.paths.resolveExisting(input.rootSlug, input.path);
    const kind = await this.kindFor(input.mode, safe);
    if (safe.root.readonly && input.mode === "upload_only") {
      throw new AppError(403, "Readonly roots cannot accept upload-only shares", "ROOT_READONLY");
    }
    this.permissions.require(actor, shareLevel(input.mode), safe.root, safe.logicalPath);
    const token = randomToken();
    const ts = now();
    const share = {
      id: id("share"),
      token_hash: sha256(token),
      token_sealed: this.secrets.seal(token),
      root_id: safe.root.id,
      path: safe.logicalPath,
      kind,
      permission_json: JSON.stringify({ mode: input.mode }),
      expires_at: input.expiresAt ?? null,
      max_downloads: input.maxDownloads ?? null,
      download_count: 0,
      password_hash: input.password ? await hashPassword(input.password) : null,
      created_by: actor.id,
      disabled: 0,
      created_at: ts,
      updated_at: ts
    };
    this.db
      .prepare(
        `INSERT INTO share_links
        (id, token_hash, token_sealed, root_id, path, kind, permission_json, expires_at, max_downloads, password_hash,
         created_by, disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        share.id,
        share.token_hash,
        share.token_sealed,
        share.root_id,
        share.path,
        share.kind,
        share.permission_json,
        share.expires_at,
        share.max_downloads,
        share.password_hash,
        share.created_by,
        share.disabled,
        share.created_at,
        share.updated_at
      );
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "create_share",
      rootId: safe.root.id,
      path: safe.logicalPath,
      result: "success"
    });
    this.events.publish({ type: "share.updated", userId: actor.id });
    return this.listed(share.id);
  }

  async patch(actor: Actor, shareId: string, input: z.infer<typeof sharePatchSchema>): Promise<ShareLink> {
    const existing = this.getForActor(actor, shareId);
    const onlyDisabling = input.disabled === true && input.expiresAt === undefined && input.maxDownloads === undefined;
    // Anything but turning a link off may bring a dead one back, so it takes what making the link took.
    if (!onlyDisabling) {
      const safe = await this.paths.resolveRootById(existing.root_id, existing.path);
      this.requireCreatorPermissions(existing, safe);
    }
    this.db
      .prepare("UPDATE share_links SET disabled = ?, expires_at = ?, max_downloads = ?, updated_at = ? WHERE id = ?")
      .run(
        input.disabled === undefined ? existing.disabled : input.disabled ? 1 : 0,
        input.expiresAt === undefined ? existing.expires_at : input.expiresAt,
        input.maxDownloads === undefined ? existing.max_downloads : input.maxDownloads,
        now(),
        shareId
      );
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: input.expiresAt === undefined && input.maxDownloads === undefined ? "disable_share" : "update_share",
      rootId: existing.root_id,
      path: existing.path,
      target: { shareId, ...input },
      result: "success"
    });
    this.events.publish({ type: "share.updated", userId: existing.created_by });
    return this.listed(shareId);
  }

  /**
   * A new link for the share. A response already being sent runs to its end, but the old link answers nothing after it:
   * the visit and password cookies are kept under the old link's path, so they go with it.
   */
  rotate(actor: Actor, shareId: string): ShareLink {
    const existing = this.getForActor(actor, shareId);
    const token = randomToken();
    this.db
      .prepare("UPDATE share_links SET token_hash = ?, token_sealed = ?, updated_at = ? WHERE id = ?")
      .run(sha256(token), this.secrets.seal(token), now(), shareId);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "rotate_share",
      rootId: existing.root_id,
      path: existing.path,
      target: { shareId },
      result: "success"
    });
    this.events.publish({ type: "share.updated", userId: existing.created_by });
    return this.listed(shareId);
  }

  delete(actor: Actor, shareId: string): void {
    const existing = this.getForActor(actor, shareId);
    this.db.prepare("DELETE FROM share_links WHERE id = ?").run(shareId);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "delete_share",
      rootId: existing.root_id,
      path: existing.path,
      target: { shareId },
      result: "success"
    });
    this.events.publish({ type: "share.updated", userId: existing.created_by });
  }

  get(shareId: string): ResolvedShare {
    const share = row<ResolvedShare>(this.db.prepare("SELECT * FROM share_links WHERE id = ?").get(shareId));
    if (!share) throw new AppError(404, "Share not found", "SHARE_NOT_FOUND");
    return share;
  }

  getForActor(actor: Actor, shareId: string): ResolvedShare {
    const share = this.get(shareId);
    if (actor.role === "ADMIN" || share.created_by === actor.id) return share;
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "permission_denied",
      rootId: share.root_id,
      path: share.path,
      target: { action: "share_access", shareId },
      result: "denied"
    });
    throw new AppError(403, "Share access denied", "SHARE_ACCESS_DENIED", true);
  }

  /** `visitor` lets someone already counted against the limit go on using a link that has since reached it. */
  resolveToken(token: string, visitor?: ShareVisitor) {
    const share = row<ResolvedShare>(this.db.prepare("SELECT * FROM share_links WHERE token_hash = ?").get(sha256(token)));
    if (!share || share.disabled) throw new AppError(404, "Share not found", "SHARE_NOT_FOUND");
    if (share.expires_at && share.expires_at < now()) throw new AppError(410, "Share expired", "SHARE_EXPIRED");
    if (share.max_downloads && share.download_count >= share.max_downloads && !(visitor && this.counted(share.id, visitor))) {
      throw new AppError(410, "Share download limit reached", "SHARE_LIMIT_REACHED");
    }
    return share;
  }

  private counted(shareId: string, visitor: ShareVisitor): boolean {
    // Without the visit's own cookie, everyone behind one address would ride on the first of them to be counted.
    if (!visitor.session) return false;
    return Boolean(this.db.prepare("SELECT 1 FROM share_visits WHERE share_id = ? AND visitor = ? AND seen_at > ?").get(shareId, visitorKey(visitor), now() - SHARE_VISIT_SECONDS));
  }

  /**
   * Counts a visitor against the link's limit the first time they are sent the file, and not again for a while:
   * a player asks for a video in many pieces, and whoever looked at a file may go on to download it.
   */
  private count(share: ResolvedShare, visitor: ShareVisitor): void {
    if (this.counted(share.id, visitor)) return;
    const ts = now();
    const updated = this.db
      .prepare(
        `UPDATE share_links
        SET download_count = download_count + 1, updated_at = ?
        WHERE id = ? AND (max_downloads IS NULL OR download_count < max_downloads)`
      )
      .run(ts, share.id);
    if (updated.changes !== 1) throw new AppError(410, "Share download limit reached", "SHARE_LIMIT_REACHED");
    this.db.prepare("DELETE FROM share_visits WHERE share_id = ? AND seen_at <= ?").run(share.id, ts - SHARE_VISIT_SECONDS);
    this.db.prepare("INSERT OR REPLACE INTO share_visits (share_id, visitor, seen_at) VALUES (?, ?, ?)").run(share.id, visitorKey(visitor), ts);
  }

  async publicInfo(token: string, accessToken?: string, visitor?: ShareVisitor): Promise<PublicShareInfo> {
    const share = this.resolveToken(token, visitor);
    const mode = modeOf(share);
    const authenticated = !share.password_hash || this.opens(share, accessToken);
    const base = { id: share.id, mode, requiresPassword: Boolean(share.password_hash), authenticated };
    if (!authenticated) return base;

    const safe = await this.paths.resolveRootById(share.root_id, share.path);
    this.requireCreatorPermissions(share, safe);
    const named = { ...base, kind: share.kind, name: nameOf(safe) };
    // A folder to look through is known by its name alone: where it lies is nothing a visitor needs.
    if (share.kind === "folder" && mode !== "upload_only") return named;
    const type = lookup(safe.logicalPath) || "";
    return {
      ...named,
      path: share.path,
      rootSlug: safe.root.slug,
      // A share of a whole location goes by the location's name, as it does everywhere else.
      rootName: safe.root.name,
      // What the page draws the file with: its kind of icon, and how much there is to download. A folder to upload into has neither.
      type,
      size: mode === "upload_only" ? undefined : (await this.storage.stat(safe)).size,
      // Told up front, so the page offers to show only what the preview will agree to send.
      previewable: isBrowserViewable(type)
    };
  }

  async authenticatePublicShare(token: string, password: string, address = "", visitor?: ShareVisitor): Promise<{ shareId: string; accessToken: string }> {
    const share = this.resolveToken(token, visitor);
    if (!share.password_hash) return { shareId: share.id, accessToken: this.accessTokenForShare(share, now()) };
    // A link is handed around, so its password is the one anyone at all may guess at.
    const guesser = guesserOf(address);
    const attempt = this.attempts.begin([
      { key: `share:${guesser}:${share.id}`, limit: SHARE_TRIES },
      { key: `share-from:${guesser}`, limit: SHARE_TRIES_PER_ADDRESS }
    ]);
    if (!(await verifyPassword(password, share.password_hash))) {
      this.audit.write({
        actorType: "share_link",
        actorId: share.id,
        action: "share_auth_failed",
        rootId: share.root_id,
        path: share.path,
        result: "failure"
      });
      throw new AppError(401, "Invalid share password", "INVALID_SHARE_PASSWORD");
    }
    attempt.succeeded();
    return { shareId: share.id, accessToken: this.accessTokenForShare(share, now()) };
  }

  assertPublicAccess(share: ResolvedShare, accessToken?: string): void {
    if (!share.password_hash) return;
    if (this.opens(share, accessToken)) return;
    throw new AppError(401, "Share password required", "SHARE_PASSWORD_REQUIRED");
  }

  /** One page of a folder in a shared folder. Whoever sees any of it has been sent the folder, and is counted. */
  async publicList(token: string, visitor: ShareVisitor, accessToken: string | undefined, query: z.infer<typeof shareListQuerySchema>): Promise<ShareFolderPage> {
    const reached = await this.reach(token, "list", { visitor, accessToken, path: query.path });
    if (!(await this.storage.stat(reached.target)).isDirectory()) throw new AppError(400, "Path is not a folder", "NOT_FOLDER");
    this.count(reached.share, visitor);
    const items = await this.sortedListing(reached, query.sortBy, query.direction);
    const end = query.offset + query.limit;
    return {
      path: relativePath(reached.base, reached.target),
      name: nameOf(reached.target),
      items: items.slice(query.offset, end),
      offset: query.offset,
      total: items.length,
      hasMore: end < items.length
    };
  }

  async publicDownload(token: string, visitor: ShareVisitor, accessToken?: string, relative?: string) {
    const { share, target } = await this.reach(token, "download", { visitor, accessToken, path: relative });
    const stat = await this.storage.stat(target);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    this.count(share, visitor);
    this.audit.write({
      actorType: "share_link",
      actorId: share.id,
      action: "download_via_share",
      rootId: target.root.id,
      path: target.logicalPath,
      result: "success"
    });
    return { safe: target, stat };
  }

  /** The file itself, to be shown in the browser: only what a browser shows by itself is sent. */
  async publicPreview(token: string, visitor: ShareVisitor, accessToken?: string, relative?: string) {
    const { share, target } = await this.reach(token, "preview", { visitor, accessToken, path: relative });
    const stat = await this.storage.stat(target);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    const contentType = lookup(target.logicalPath) || "application/octet-stream";
    if (!isBrowserViewable(contentType)) throw new AppError(415, "This kind of file cannot be viewed in the browser", "PREVIEW_UNSUPPORTED");
    // Looking at the file is being sent it, as much as downloading it is.
    this.count(share, visitor);
    return { safe: target, stat, contentType };
  }

  /**
   * A file's icon. Where the link only lets files be looked at, a file the preview would not send has none either:
   * the first page of a document drawn small is still the document.
   */
  async publicThumbnail(token: string, visitor: ShareVisitor, accessToken: string | undefined, relative: string | undefined, medium: boolean): Promise<Thumbnail> {
    const { share, target, mode, creator } = await this.reach(token, "thumbnail", { visitor, accessToken, path: relative });
    const noThumbnail = () => new AppError(404, "No thumbnail for this file", "NO_THUMBNAIL");
    if (!(await this.storage.stat(target)).isFile()) throw noThumbnail();
    if (mode !== "download" && !isBrowserViewable(lookup(target.logicalPath) || "")) throw noThumbnail();
    this.count(share, visitor);
    return this.files.thumbnail(creator, target.root.slug, target.logicalPath, medium);
  }

  /**
   * A folder of a shared folder as one archive. It is read through before anything is sent, so one too large is
   * refused while the visitor can still be told; `release` is called once the archive has been sent or abandoned.
   */
  async publicZip(token: string, visitor: ShareVisitor, accessToken?: string, relative?: string): Promise<{ fileName: string; entries: ZipEntry[]; release: () => void }> {
    const { share, target } = await this.reach(token, "zip", { visitor, accessToken, path: relative });
    if (!(await this.storage.stat(target)).isDirectory()) throw new AppError(400, "Path is not a folder", "NOT_FOLDER");
    const release = this.takeZipSlot(share.id);
    try {
      const name = nameOf(target);
      const entries: ZipEntry[] = [];
      let bytes = 0;
      for await (const entry of this.files.zipEntriesOf(target, name, true)) {
        entries.push(entry);
        if (!entry.directory) bytes += entry.size;
        if (entries.length > SHARE_ZIP_ENTRIES || bytes > SHARE_ZIP_BYTES) {
          throw new AppError(413, "This folder is too large to download as one archive; download what is inside it instead", "SHARE_ZIP_TOO_LARGE");
        }
      }
      this.count(share, visitor);
      this.audit.write({
        actorType: "share_link",
        actorId: share.id,
        action: "download_zip_via_share",
        rootId: target.root.id,
        path: target.logicalPath,
        target: { files: entries.filter((entry) => !entry.directory).length, bytes },
        result: "success"
      });
      return { fileName: `${name}.zip`, entries, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  async publicUploadTarget(token: string, accessToken?: string) {
    const { share, target } = await this.reach(token, "upload", { accessToken });
    return { share, safe: target };
  }

  private takeZipSlot(shareId: string): () => void {
    const here = this.zipping.get(shareId) ?? 0;
    const everywhere = [...this.zipping.values()].reduce((sum, count) => sum + count, 0);
    if (here >= SHARE_ZIPS_PER_LINK || everywhere >= SHARE_ZIPS_AT_ONCE) {
      throw new AppError(429, "Too many archives are being downloaded through links right now; try again in a moment", "SHARE_ZIP_BUSY");
    }
    this.zipping.set(shareId, here + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.zipping.get(shareId) ?? 1) - 1;
      if (left > 0) this.zipping.set(shareId, left);
      else this.zipping.delete(shareId);
    };
  }

  /**
   * Everything a visitor's request goes through, in order: the link is alive, its password was given, its mode allows
   * what is asked, what it was made to is still that, the path asked for lies within it, and whoever made the link may
   * still see that path. Without `visitor` nobody is let past a limit already reached.
   */
  private async reach(token: string, use: ShareUse, request: { visitor?: ShareVisitor; accessToken?: string; path?: string }) {
    const share = this.resolveToken(token, request.visitor);
    this.assertPublicAccess(share, request.accessToken);
    const mode = modeOf(share);
    if (!SHARE_MODES[mode].uses.has(use)) throw FORBIDDEN[use]();
    const base = await this.paths.resolveRootById(share.root_id, share.path);
    await this.assertKind(share, base);
    if (FOLDER_USES.has(use) && share.kind !== "folder") throw new AppError(400, "This share is of a file", "SHARE_TARGET_NOT_FOLDER");
    const target = await this.within(share, base, request.path ?? "/");
    const creator = this.creatorOf(share);
    this.permissions.require(creator, shareLevel(mode), target.root, target.logicalPath);
    return { share, mode, base, target, creator };
  }

  /**
   * Where a path a visitor gave lies in what was shared. It is read as a path below the shared folder whatever it
   * starts with, and walked like any other path (no `..`, no symlinks, NFC and NFD the same); what the folder's listing
   * leaves out is not there, nor is a name a disk would trim to nothing but dots. A file share has only its file.
   * Whatever is refused is not found, so nothing can be learnt of what lies around it.
   */
  private async within(share: ResolvedShare, base: SafePath, relative: string): Promise<SafePath> {
    const segments = this.paths.normalizeLogicalPath(relative).split("/").filter(Boolean);
    if (segments.length === 0) return base;
    if (share.kind !== "folder" || segments.some((segment) => isSystemFile(nfc(segment)) || /^[. ]+$/.test(segment))) throw notFound();
    let target: SafePath;
    try {
      target = await this.paths.resolveRootById(base.root.id, path.posix.join(base.logicalPath, ...segments));
    } catch (error) {
      if (error instanceof AppError && ["SYMLINK_FORBIDDEN", "PATH_ESCAPES_ROOT"].includes(error.code)) throw notFound();
      throw error;
    }
    const prefix = base.logicalPath === "/" ? "/" : `${base.logicalPath}/`;
    if (!target.logicalPath.startsWith(prefix)) throw notFound();
    if (!this.storage.isRemote(target)) {
      const inside = path.relative(base.absolutePath, target.absolutePath);
      if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw notFound();
    }
    return target;
  }

  /** A folder's entries in the order asked for, read again only once the last reading is a little while old. */
  private async sortedListing(reached: { share: ResolvedShare; base: SafePath; target: SafePath; creator: Actor }, sortBy: ShareSortBy, direction: "asc" | "desc"): Promise<ShareItem[]> {
    const key = `${reached.share.id}\0${reached.target.logicalPath}\0${sortBy}\0${direction}`;
    const kept = this.listings.get(key);
    if (kept && Date.now() - kept.at < LISTING_MS) return kept.items;
    const listing = await this.files.list(reached.creator, reached.target.root.slug, reached.target.logicalPath);
    const items = sortShareItems(
      listing.items.map((item) => shareItem(reached.base, item)),
      sortBy,
      direction
    );
    this.listings.delete(key);
    this.listings.set(key, { at: Date.now(), items });
    for (const old of this.listings.keys()) {
      if (this.listings.size <= LISTINGS_KEPT) break;
      this.listings.delete(old);
    }
    return items;
  }

  /** What a link would be made to, refused where its mode cannot have one of those. */
  private async kindFor(mode: ShareMode, safe: SafePath): Promise<ShareKind> {
    const stat = await this.storage.stat(safe);
    const kind: ShareKind | null = stat.isDirectory() ? "folder" : stat.isFile() ? "file" : null;
    if (kind && SHARE_MODES[mode].kinds.has(kind)) return kind;
    if (mode === "upload_only") throw new AppError(400, "Upload-only shares must target a folder", "SHARE_TARGET_NOT_FOLDER");
    throw new AppError(400, "Download and view shares must target a file or a folder", "SHARE_TARGET_NOT_FILE");
  }

  /** What a link was made to may since have been replaced by something else under its name, which the link was never for. */
  private async assertKind(share: ResolvedShare, safe: SafePath): Promise<void> {
    const stat = await this.storage.stat(safe);
    if (share.kind === "folder" && !stat.isDirectory()) throw new AppError(400, "This share's folder is no longer one", "SHARE_TARGET_NOT_FOLDER");
    if (share.kind === "file" && !stat.isFile()) throw new AppError(400, "This share's file is no longer one", "SHARE_TARGET_NOT_FILE");
  }

  /**
   * Proof that the link's password was given at `issuedAt`, in seconds. It names the password's hash, so a new
   * password turns away everyone let in by the old one.
   */
  private accessTokenForShare(share: ResolvedShare, issuedAt: number): string {
    const mac = createHmac("sha256", this.secret).update(`share-access:${share.id}:${share.password_hash ?? "none"}:${issuedAt}`).digest("hex");
    return `${issuedAt}.${mac}`;
  }

  private opens(share: ResolvedShare, accessToken: string | undefined): boolean {
    const issuedAt = Number(accessToken?.split(".", 1)[0]);
    const age = now() - issuedAt;
    if (!accessToken || !Number.isSafeInteger(issuedAt) || age < 0 || age > SHARE_ACCESS_SECONDS) return false;
    const expected = Buffer.from(this.accessTokenForShare(share, issuedAt));
    const given = Buffer.from(accessToken);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private requireCreatorPermissions(share: ResolvedShare, safe: SafePath): void {
    this.permissions.require(this.creatorOf(share), shareLevel(modeOf(share)), safe.root, safe.logicalPath);
  }

  /** Whoever made the link, as they are now: what a visitor is let do, they must still be let do. */
  private creatorOf(share: ResolvedShare): Actor {
    const creator = row<{
      id: string;
      email: string;
      display_name: string;
      role: Actor["role"];
      disabled: number;
    }>(
      this.db
        .prepare("SELECT id, email, display_name, role, disabled FROM users WHERE id = ?")
        .get(share.created_by)
    );
    if (!creator) throw new AppError(403, "Share owner no longer has access", "SHARE_OWNER_ACCESS_REVOKED");
    return { id: creator.id, email: creator.email, displayName: creator.display_name, role: creator.role, disabled: Boolean(creator.disabled) };
  }

  private listed(shareId: string): ShareLink {
    const share = row<ListedShare>(this.db.prepare(`${LISTED_SHARE} WHERE share_links.id = ?`).get(shareId));
    if (!share) throw new AppError(404, "Share not found", "SHARE_NOT_FOUND");
    return this.publicShare(share);
  }

  private publicShare(share: ListedShare): ShareLink {
    const { token_hash: _tokenHash, token_sealed, password_hash, creator_email, creator_name, creator_avatar_at, ...safeShare } = share;
    return {
      ...safeShare,
      has_password: Boolean(password_hash),
      token: this.openToken(token_sealed),
      creator: { id: share.created_by, email: creator_email, display_name: creator_name, avatar_at: creator_avatar_at }
    };
  }

  /** A token sealed with a `storage.key` that has since been lost is as good as none: the link can be given a new one. */
  private openToken(sealed: string | null): string | null {
    if (!sealed) return null;
    try {
      return this.secrets.open(sealed);
    } catch {
      return null;
    }
  }
}

type ResolvedShare = {
  id: string;
  token_hash: string;
  token_sealed: string | null;
  root_id: string;
  path: string;
  kind: ShareKind;
  permission_json: string;
  expires_at: number | null;
  max_downloads: number | null;
  download_count: number;
  password_hash: string | null;
  created_by: string;
  disabled: number;
  created_at: number;
  updated_at: number;
};

type ListedShare = ResolvedShare & { creator_email: string; creator_name: string; creator_avatar_at: number | null };

const LISTED_SHARE = `SELECT share_links.*, users.email AS creator_email, users.display_name AS creator_name, users.avatar_at AS creator_avatar_at
  FROM share_links JOIN users ON users.id = share_links.created_by`;

/** A cookie alone could be handed around, and an address alone is shared by a whole office: a visitor is the two together. */
const visitorKey = (visitor: ShareVisitor) => sha256(`share-visit:${visitor.address}:${visitor.session ?? ""}`);

const modeOf = (share: ResolvedShare) => (JSON.parse(share.permission_json) as { mode: ShareMode }).mode;

/** What whoever made the link needs on its path, when making it and for as long as it is open. */
function shareLevel(mode: ShareMode): Level {
  return mode === "upload_only" ? "edit" : "view";
}

/** A file or folder by its own name; the top of a location has none of its own, and goes by the location's. */
const nameOf = (safe: SafePath) => (safe.logicalPath === "/" ? safe.root.name : nfc(path.posix.basename(safe.logicalPath)));

/** Where a path lies below the shared folder, as a visitor names it. */
const relativePath = (base: SafePath, logicalPath: SafePath | string) => {
  const full = typeof logicalPath === "string" ? logicalPath : logicalPath.logicalPath;
  return base.logicalPath === "/" ? full : full.slice(base.logicalPath.length) || "/";
};

/** An entry as the file browser lists it, told of as a visitor sees it: by where it lies in the share, with nobody's tags. */
function shareItem(base: SafePath, item: FileItem): ShareItem {
  return {
    name: item.name,
    path: relativePath(base, item.path),
    kind: item.kind,
    size: item.size,
    mtime: item.mtime,
    type: item.type,
    previewable: item.kind === "file" && isBrowserViewable(item.type)
  };
}

/** The file browser's order (`sortItems` in the web app): folders first whatever the column, ties by name. */
function sortShareItems(items: ShareItem[], sortBy: ShareSortBy, direction: "asc" | "desc"): ShareItem[] {
  const sign = direction === "asc" ? 1 : -1;
  return items.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const primary = sortBy === "size" ? a.size - b.size : sortBy === "mtime" ? a.mtime - b.mtime : sortBy === "type" ? byName.compare(a.type, b.type) : byName.compare(a.name, b.name);
    return (primary || byName.compare(a.name, b.name)) * sign;
  });
}
