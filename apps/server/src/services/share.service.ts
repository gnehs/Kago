import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { AuditService } from "./audit.service.js";
import type { PathService } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { Actor } from "./types.js";
import type { EventHub } from "../ws/events.js";

export const shareSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1),
  mode: z.enum(["view_only", "download", "upload_only"]),
  password: z.string().min(8).optional(),
  expiresAt: z.number().int().optional(),
  maxDownloads: z.number().int().positive().optional()
});

export class ShareService {
  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly events: EventHub
  ) {}

  list(actor: Actor) {
    const items =
      actor.role === "ADMIN"
        ? rows<ResolvedShare>(this.db.prepare("SELECT * FROM share_links ORDER BY created_at DESC").all())
        : rows<ResolvedShare>(this.db.prepare("SELECT * FROM share_links WHERE created_by = ? ORDER BY created_at DESC").all(actor.id));
    return items.map((share) => this.publicShare(share));
  }

  async create(actor: Actor, input: z.infer<typeof shareSchema>) {
    const safe = await this.paths.resolveExisting(input.rootSlug, input.path);
    this.permissions.require(actor, "share", safe.root, safe.logicalPath);
    if (safe.root.readonly && input.mode === "upload_only") {
      throw new AppError(403, "Readonly roots cannot accept upload-only shares", "ROOT_READONLY");
    }
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
    this.events.publish({ type: "share.updated" });
    return { ...this.publicShare(share), token };
  }

  patch(actor: Actor, shareId: string, input: { disabled?: boolean }) {
    const existing = this.getForActor(actor, shareId);
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
    this.events.publish({ type: "share.updated" });
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
    this.events.publish({ type: "share.updated" });
  }

  get(shareId: string): ResolvedShare {
    const share = row<ResolvedShare>(this.db.prepare("SELECT * FROM share_links WHERE id = ?").get(shareId));
    if (!share) throw new AppError(404, "Share not found", "SHARE_NOT_FOUND");
    return share;
  }

  getForActor(actor: Actor, shareId: string): ResolvedShare {
    const share = this.get(shareId);
    if (actor.role === "ADMIN" || share.created_by === actor.id) return share;
    throw new AppError(403, "Share access denied", "SHARE_ACCESS_DENIED");
  }

  resolveToken(token: string) {
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
    if (share.max_downloads && share.download_count >= share.max_downloads) {
      throw new AppError(410, "Share download limit reached", "SHARE_LIMIT_REACHED");
    }
    return share;
  }

  async publicInfo(token: string, accessToken?: string) {
    const share = this.resolveToken(token);
    const safe = await this.paths.resolveRootById(share.root_id, share.path);
    return {
      id: share.id,
      mode: (JSON.parse(share.permission_json) as { mode: string }).mode,
      path: share.path,
      rootSlug: safe.root.slug,
      requiresPassword: Boolean(share.password_hash),
      authenticated: !share.password_hash || accessToken === this.accessTokenForShare(share)
    };
  }

  async authenticatePublicShare(token: string, password: string): Promise<{ shareId: string; accessToken: string }> {
    const share = this.resolveToken(token);
    if (!share.password_hash) return { shareId: share.id, accessToken: this.accessTokenForShare(share) };
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
    return { shareId: share.id, accessToken: this.accessTokenForShare(share) };
  }

  assertPublicAccess(share: ResolvedShare, accessToken?: string): void {
    if (!share.password_hash) return;
    if (accessToken && accessToken === this.accessTokenForShare(share)) return;
    throw new AppError(401, "Share password required", "SHARE_PASSWORD_REQUIRED");
  }

  async publicDownload(token: string, accessToken?: string) {
    const share = this.resolveToken(token);
    this.assertPublicAccess(share, accessToken);
    const mode = (JSON.parse(share.permission_json) as { mode: string }).mode;
    if (mode !== "download") {
      throw new AppError(403, "Download is not allowed for this share", "SHARE_DOWNLOAD_FORBIDDEN");
    }
    const safe = await this.paths.resolveRootById(share.root_id, share.path);
    this.db.prepare("UPDATE share_links SET download_count = download_count + 1, updated_at = ? WHERE id = ?").run(
      now(),
      share.id
    );
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

  async publicPreview(token: string, accessToken?: string) {
    const share = this.resolveToken(token);
    this.assertPublicAccess(share, accessToken);
    const mode = (JSON.parse(share.permission_json) as { mode: string }).mode;
    if (mode !== "download" && mode !== "view_only") {
      throw new AppError(403, "Preview is not allowed for this share", "SHARE_PREVIEW_FORBIDDEN");
    }
    return this.paths.resolveRootById(share.root_id, share.path);
  }

  async publicUploadTarget(token: string, accessToken?: string) {
    const share = this.resolveToken(token);
    this.assertPublicAccess(share, accessToken);
    const mode = (JSON.parse(share.permission_json) as { mode: string }).mode;
    if (mode !== "upload_only") throw new AppError(403, "Upload is not allowed for this share", "SHARE_UPLOAD_FORBIDDEN");
    const safe = await this.paths.resolveRootById(share.root_id, share.path);
    if (safe.root.readonly) throw new AppError(403, "Root is readonly", "ROOT_READONLY");
    return { share, safe };
  }

  private accessTokenForShare(share: ResolvedShare): string {
    return sha256(`share-access:${share.id}:${share.password_hash ?? "none"}`);
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
