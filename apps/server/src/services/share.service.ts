import { z } from "zod";
import { lookup } from "mime-types";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AttemptLimiter } from "../lib/attempts.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import { isBrowserViewable } from "../lib/viewable.js";
import type { AuditService } from "./audit.service.js";
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

/** How many wrong passwords one address may try for one link, and for all links, before it is made to wait. */
const SHARE_TRIES = 5;
const SHARE_TRIES_PER_ADDRESS = 50;
/** For how long someone who was counted against a link's limit may come back to it without being counted again. */
export const SHARE_VISIT_SECONDS = 12 * 60 * 60;

/** Who is asking for a link: where from, and the cookie the link's page was given. */
export type ShareVisitor = { address: string; session?: string };

export class ShareService {
  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly storage: StorageService
  ) {}

  private readonly attempts = new AttemptLimiter();

  list(actor: Actor) {
    const items =
      actor.role === "ADMIN"
        ? rows<ResolvedShare>(this.db.prepare("SELECT * FROM share_links ORDER BY created_at DESC").all())
        : rows<ResolvedShare>(this.db.prepare("SELECT * FROM share_links WHERE created_by = ? ORDER BY created_at DESC").all(actor.id));
    return items.map((share) => this.publicShare(share));
  }

  async create(actor: Actor, input: z.infer<typeof shareSchema>) {
    const safe = await this.paths.resolveExisting(input.rootSlug, input.path);
    await this.assertModeMatchesTarget(input.mode, safe);
    if (safe.root.readonly && input.mode === "upload_only") {
      throw new AppError(403, "Readonly roots cannot accept upload-only shares", "ROOT_READONLY");
    }
    this.permissions.require(actor, shareLevel(input.mode), safe.root, safe.logicalPath);
    const token = randomToken();
    const ts = now();
    const share = {
      id: id("share"),
      token_hash: sha256(token),
      root_id: safe.root.id,
      path: safe.logicalPath,
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
        (id, token_hash, root_id, path, permission_json, expires_at, max_downloads, password_hash,
         created_by, disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        share.id,
        share.token_hash,
        share.root_id,
        share.path,
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
    return { ...this.publicShare(share), token };
  }

  async patch(actor: Actor, shareId: string, input: { disabled?: boolean }) {
    const existing = this.getForActor(actor, shareId);
    if (input.disabled === false) {
      const safe = await this.paths.resolveRootById(existing.root_id, existing.path);
      this.requireCreatorPermissions(existing, safe);
    }
    this.db
      .prepare("UPDATE share_links SET disabled = COALESCE(?, disabled), updated_at = ? WHERE id = ?")
      .run(input.disabled === undefined ? null : input.disabled ? 1 : 0, now(), shareId);
    this.audit.write({
      actorType: "user",
      actorId: actor.id,
      action: "disable_share",
      rootId: existing.root_id,
      path: existing.path,
      target: { shareId, disabled: input.disabled },
      result: "success"
    });
    this.events.publish({ type: "share.updated", userId: existing.created_by });
    return this.publicShare(this.get(shareId));
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
    throw new AppError(403, "Share access denied", "SHARE_ACCESS_DENIED");
  }

  /** `visitor` lets someone already counted against the limit go on using a link that has since reached it. */
  resolveToken(token: string, visitor?: ShareVisitor) {
    const share = row<{
      id: string;
      token_hash: string;
      root_id: string;
      path: string;
      permission_json: string;
      expires_at: number | null;
      max_downloads: number | null;
      download_count: number;
      password_hash: string | null;
      created_by: string;
      disabled: number;
      created_at: number;
      updated_at: number;
    }>(this.db.prepare("SELECT * FROM share_links WHERE token_hash = ?").get(sha256(token)));
    if (!share || share.disabled) throw new AppError(404, "Share not found", "SHARE_NOT_FOUND");
    if (share.expires_at && share.expires_at < now()) throw new AppError(410, "Share expired", "SHARE_EXPIRED");
    if (share.max_downloads && share.download_count >= share.max_downloads && !(visitor && this.counted(share.id, visitor))) {
      throw new AppError(410, "Share download limit reached", "SHARE_LIMIT_REACHED");
    }
    return share;
  }

  private counted(shareId: string, visitor: ShareVisitor): boolean {
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

  async publicInfo(token: string, accessToken?: string, visitor?: ShareVisitor) {
    const share = this.resolveToken(token, visitor);
    const authenticated = !share.password_hash || accessToken === this.accessTokenForShare(share);
    const base = {
      id: share.id,
      mode: (JSON.parse(share.permission_json) as { mode: string }).mode,
      requiresPassword: Boolean(share.password_hash),
      authenticated
    };
    if (!authenticated) return base;

    const safe = await this.paths.resolveRootById(share.root_id, share.path);
    this.requireCreatorPermissions(share, safe);
    const type = lookup(safe.logicalPath) || "";
    return {
      ...base,
      path: share.path,
      rootSlug: safe.root.slug,
      // A share of a whole location goes by the location's name, as it does everywhere else.
      rootName: safe.root.name,
      // What the page draws the file with: its kind of icon, and how much there is to download. A folder to upload into has neither.
      type,
      size: base.mode === "upload_only" ? undefined : (await this.storage.stat(safe)).size,
      // Told up front, so the page offers to show only what the preview will agree to send.
      previewable: isBrowserViewable(type)
    };
  }

  async authenticatePublicShare(token: string, password: string, address = "", visitor?: ShareVisitor): Promise<{ shareId: string; accessToken: string }> {
    const share = this.resolveToken(token, visitor);
    if (!share.password_hash) return { shareId: share.id, accessToken: this.accessTokenForShare(share) };
    // A link is handed around, so its password is the one anyone at all may guess at.
    const attempt = this.attempts.begin([
      { key: `share:${address}:${share.id}`, limit: SHARE_TRIES },
      { key: `share-from:${address}`, limit: SHARE_TRIES_PER_ADDRESS }
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
    return { shareId: share.id, accessToken: this.accessTokenForShare(share) };
  }

  assertPublicAccess(share: ResolvedShare, accessToken?: string): void {
    if (!share.password_hash) return;
    if (accessToken && accessToken === this.accessTokenForShare(share)) return;
    throw new AppError(401, "Share password required", "SHARE_PASSWORD_REQUIRED");
  }

  async publicDownload(token: string, visitor: ShareVisitor, accessToken?: string) {
    const share = this.resolveToken(token, visitor);
    this.assertPublicAccess(share, accessToken);
    const mode = (JSON.parse(share.permission_json) as { mode: string }).mode;
    if (mode !== "download") {
      throw new AppError(403, "Download is not allowed for this share", "SHARE_DOWNLOAD_FORBIDDEN");
    }
    const safe = await this.paths.resolveRootById(share.root_id, share.path);
    await this.assertModeMatchesTarget("download", safe);
    this.requireCreatorPermissions(share, safe);
    this.count(share, visitor);
    this.audit.write({
      actorType: "share_link",
      actorId: share.id,
      action: "download_via_share",
      rootId: safe.root.id,
      path: safe.logicalPath,
      result: "success"
    });
    return safe;
  }

  async publicPreview(token: string, visitor: ShareVisitor, accessToken?: string) {
    const share = this.resolveToken(token, visitor);
    this.assertPublicAccess(share, accessToken);
    const mode = (JSON.parse(share.permission_json) as { mode: string }).mode;
    if (mode !== "download" && mode !== "view_only") {
      throw new AppError(403, "Preview is not allowed for this share", "SHARE_PREVIEW_FORBIDDEN");
    }
    const safe = await this.paths.resolveRootById(share.root_id, share.path);
    await this.assertModeMatchesTarget("view_only", safe);
    this.requireCreatorPermissions(share, safe);
    // Looking at the file is being sent it, as much as downloading it is.
    this.count(share, visitor);
    return safe;
  }

  async publicUploadTarget(token: string, accessToken?: string) {
    const share = this.resolveToken(token);
    this.assertPublicAccess(share, accessToken);
    const mode = (JSON.parse(share.permission_json) as { mode: string }).mode;
    if (mode !== "upload_only") throw new AppError(403, "Upload is not allowed for this share", "SHARE_UPLOAD_FORBIDDEN");
    const safe = await this.paths.resolveRootById(share.root_id, share.path);
    await this.assertModeMatchesTarget("upload_only", safe);
    this.requireCreatorPermissions(share, safe);
    return { share, safe };
  }

  private async assertModeMatchesTarget(mode: "view_only" | "download" | "upload_only", safe: SafePath): Promise<void> {
    const stat = await this.storage.stat(safe);
    if (mode === "upload_only") {
      if (!stat.isDirectory()) throw new AppError(400, "Upload-only shares must target a folder", "SHARE_TARGET_NOT_FOLDER");
      return;
    }
    if (!stat.isFile()) throw new AppError(400, "Download and view shares must target a file", "SHARE_TARGET_NOT_FILE");
  }

  private accessTokenForShare(share: ResolvedShare): string {
    return sha256(`share-access:${share.id}:${share.password_hash ?? "none"}`);
  }

  private requireCreatorPermissions(share: ResolvedShare, safe: SafePath): void {
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

    const actor: Actor = {
      id: creator.id,
      email: creator.email,
      displayName: creator.display_name,
      role: creator.role,
      disabled: Boolean(creator.disabled)
    };
    const mode = (JSON.parse(share.permission_json) as { mode: "view_only" | "download" | "upload_only" }).mode;
    this.permissions.require(actor, shareLevel(mode), safe.root, safe.logicalPath);
  }

  private publicShare(share: ResolvedShare): PublicShareLink {
    const { token_hash: _tokenHash, password_hash, ...safeShare } = share;
    return { ...safeShare, has_password: Boolean(password_hash) };
  }
}

type ResolvedShare = {
  id: string;
  token_hash: string;
  root_id: string;
  path: string;
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

type PublicShareLink = Omit<ResolvedShare, "token_hash" | "password_hash"> & {
  has_password: boolean;
};

/** A cookie alone could be handed around, and an address alone is shared by a whole office: a visitor is the two together. */
const visitorKey = (visitor: ShareVisitor) => sha256(`share-visit:${visitor.address}:${visitor.session ?? ""}`);

/** What whoever made the link needs on its path, when making it and for as long as it is open. */
function shareLevel(mode: "view_only" | "download" | "upload_only"): Level {
  return mode === "upload_only" ? "edit" : "view";
}
