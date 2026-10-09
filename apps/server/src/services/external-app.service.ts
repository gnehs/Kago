import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { ICON_MAX_BYTES, ICON_TYPES, readIcon, type IconImage, type IconType } from "../lib/icon-image.js";
import { id, now } from "../lib/ids.js";
import type { EventPublisher } from "../ws/events.js";
import type { AuditService } from "./audit.service.js";
import type { IconLibraryService } from "./icon-library.service.js";
import type { Actor } from "./types.js";

/** How many shortcuts one person, or everyone together, may have. Each can hold an icon, and a desktop holds only so many. */
const MAX_APPS = 100;
/** An icon written this recently may belong to a shortcut that is still being saved. */
const UNCLAIMED_ICON_MS = 60 * 60 * 1000;

export const externalAppSchema = z.object({
  name: z.string().trim().min(1).max(80),
  url: z.string().trim().min(1).max(2048),
  /** On everyone's desktop, and an administrator's to change. Left out, a shortcut stays whose it was. */
  shared: z.boolean().optional(),
  /** Left out, the icon stays as it is. */
  icon: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }),
      z.object({ kind: z.literal("library"), source: z.string().max(40), name: z.string().max(80) }),
      // The picture itself, in base64: small enough to travel with the rest and be saved or refused as one thing.
      z.object({ kind: z.literal("upload"), data: z.string().min(1).max(Math.ceil(ICON_MAX_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/) })
    ])
    .optional()
});

type ExternalAppInput = z.infer<typeof externalAppSchema>;
type AppRow = { id: string; owner_id: string | null; name: string; url: string; icon_type: IconType | null; icon_version: number | null; created_at: number; updated_at: number };

/**
 * Where a shortcut leads, as it is kept. It becomes a link on someone's desktop, so it is a web address and
 * nothing else: an address of another kind would run as script or open a program when clicked.
 */
export function appUrl(raw: string): string {
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    // Reported below with the rest.
  }
  if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) throw new AppError(400, "Enter an address that starts with http:// or https://", "INVALID_APP_URL");
  // What is typed here is shown to everyone the shortcut is shared with.
  if (url.username || url.password) throw new AppError(400, "The address cannot contain a username or password", "INVALID_APP_URL");
  return url.href;
}

/**
 * Shortcuts on the desktop to the other services a machine runs. Each is its maker's own, seen and changed by
 * nobody else; one an administrator shares has no owner, shows on everyone's desktop and is any administrator's
 * to change. Its icon is a file Kago keeps, whichever library or upload it came from.
 */
export class ExternalAppService {
  private readonly dir: string;

  constructor(
    private readonly db: Db,
    appDataDir: string,
    private readonly library: IconLibraryService,
    private readonly events: EventPublisher,
    private readonly audit: AuditService
  ) {
    this.dir = path.join(appDataDir, "app-icons", "apps");
  }

  list(actor: Actor) {
    // Everyone's first, then one's own, each in the order they were added.
    return rows<AppRow>(this.db.prepare("SELECT * FROM external_apps WHERE owner_id IS NULL OR owner_id = ? ORDER BY owner_id IS NOT NULL, created_at ASC, id ASC").all(actor.id)).map((app) => this.publicApp(actor, app));
  }

  async create(actor: Actor, input: ExternalAppInput) {
    const shared = input.shared ?? false;
    if (shared) this.requireAdmin(actor);
    const url = appUrl(input.url);
    const ownerId = shared ? null : actor.id;
    const count = row<{ count: number }>(this.db.prepare("SELECT COUNT(*) AS count FROM external_apps WHERE owner_id IS ?").get(ownerId))?.count ?? 0;
    if (count >= MAX_APPS) throw new AppError(400, "There are too many apps already", "TOO_MANY_APPS");
    const icon = await this.readChoice(input.icon);
    const ts = now();
    const app: AppRow = { id: id("app"), owner_id: ownerId, name: input.name, url, icon_type: icon?.type ?? null, icon_version: icon ? Date.now() : null, created_at: ts, updated_at: ts };
    if (icon) await this.writeIcon(app.id, icon);
    this.db
      .prepare("INSERT INTO external_apps (id, owner_id, name, url, icon_type, icon_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(app.id, app.owner_id, app.name, app.url, app.icon_type, app.icon_version, app.created_at, app.updated_at);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "external_app_create", target: { appId: app.id, name: app.name, url: app.url, shared }, result: "success" });
    this.announce(app.owner_id);
    return this.publicApp(actor, app);
  }

  async update(actor: Actor, appId: string, input: ExternalAppInput) {
    const previous = this.manageable(actor, appId);
    const shared = input.shared ?? previous.owner_id === null;
    if (shared) this.requireAdmin(actor);
    const url = appUrl(input.url);
    // One taken back from everyone becomes its administrator's own.
    const ownerId = shared ? null : previous.owner_id ?? actor.id;
    const icon = await this.readChoice(input.icon);
    const app: AppRow = {
      ...previous,
      owner_id: ownerId,
      name: input.name,
      url,
      ...(icon === undefined ? {} : { icon_type: icon?.type ?? null, icon_version: icon ? Date.now() : null }),
      updated_at: now()
    };
    if (icon) await this.writeIcon(app.id, icon);
    this.db.prepare("UPDATE external_apps SET owner_id = ?, name = ?, url = ?, icon_type = ?, icon_version = ?, updated_at = ? WHERE id = ?").run(app.owner_id, app.name, app.url, app.icon_type, app.icon_version, app.updated_at, app.id);
    if (icon === null) await this.removeIcon(app.id);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "external_app_update", target: { appId: app.id, name: app.name, url: app.url, shared }, result: "success" });
    this.announce(previous.owner_id);
    if (app.owner_id !== previous.owner_id) this.announce(app.owner_id);
    return this.publicApp(actor, app);
  }

  async remove(actor: Actor, appId: string): Promise<void> {
    const app = this.manageable(actor, appId);
    this.db.prepare("DELETE FROM external_apps WHERE id = ?").run(app.id);
    await this.removeIcon(app.id);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "external_app_delete", target: { appId: app.id, name: app.name, shared: app.owner_id === null }, result: "success" });
    this.announce(app.owner_id);
  }

  /** The icon of a shortcut the caller can see, as a file and the type to send it as. */
  iconFile(actor: Actor, appId: string): { file: string; contentType: string } {
    const app = this.visible(actor, appId);
    if (!app.icon_type) throw new AppError(404, "Icon not found", "ICON_NOT_FOUND");
    return { file: this.iconPath(app.id, app.icon_type), contentType: ICON_TYPES[app.icon_type] };
  }

  /** Deletes the icons no shortcut holds any more. Returns how many went. */
  async prune(): Promise<number> {
    const kept = new Set(rows<AppRow>(this.db.prepare("SELECT * FROM external_apps WHERE icon_type IS NOT NULL").all()).map((app) => path.basename(this.iconPath(app.id, app.icon_type!))));
    let removed = 0;
    for (const name of await fsp.readdir(this.dir).catch(() => [] as string[])) {
      const file = path.join(this.dir, name);
      const stat = await fsp.stat(file).catch(() => null);
      if (kept.has(name) || !stat?.isFile() || Date.now() - stat.mtimeMs < UNCLAIMED_ICON_MS) continue;
      await fsp.rm(file, { force: true });
      removed += 1;
    }
    return removed;
  }

  private publicApp(actor: Actor, app: AppRow) {
    return {
      id: app.id,
      name: app.name,
      url: app.url,
      shared: app.owner_id === null,
      /** Whether the caller may change or remove it. */
      editable: app.owner_id === actor.id || (app.owner_id === null && actor.role === "ADMIN"),
      // The address names the icon's version, so a new one is never answered from the browser's cache.
      icon: app.icon_type ? `/api/external-apps/${app.id}/icon?v=${app.icon_version ?? 0}` : null,
      created_at: app.created_at,
      updated_at: app.updated_at
    };
  }

  /** A shortcut the caller has on their desktop. Someone else's own is not there to be found, even by an administrator. */
  private visible(actor: Actor, appId: string): AppRow {
    const app = row<AppRow>(this.db.prepare("SELECT * FROM external_apps WHERE id = ? AND (owner_id IS NULL OR owner_id = ?)").get(appId, actor.id));
    if (!app) throw new AppError(404, "App not found", "APP_NOT_FOUND");
    return app;
  }

  private manageable(actor: Actor, appId: string): AppRow {
    const app = this.visible(actor, appId);
    if (app.owner_id === null) this.requireAdmin(actor);
    return app;
  }

  private requireAdmin(actor: Actor): void {
    if (actor.role === "ADMIN") return;
    this.audit.write({ actorType: "user", actorId: actor.id, action: "permission_denied", target: { action: "shared_external_app" }, result: "denied" });
    throw new AppError(403, "Admin required", "ADMIN_REQUIRED");
  }

  /** The picture a request chose, already read and made safe; null for no icon, undefined to leave the icon alone. */
  private async readChoice(choice: ExternalAppInput["icon"]): Promise<IconImage | null | undefined> {
    if (!choice) return undefined;
    if (choice.kind === "none") return null;
    if (choice.kind === "upload") return readIcon(Buffer.from(choice.data, "base64"));
    // A copy of the library's icon is taken, so the shortcut keeps it whatever happens to the library or its cache.
    const { file } = await this.library.icon(choice.source, choice.name);
    return readIcon(await fsp.readFile(file));
  }

  private iconPath(appId: string, type: IconType): string {
    return path.join(this.dir, `${appId}.${type}`);
  }

  private async writeIcon(appId: string, icon: IconImage): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true });
    const target = this.iconPath(appId, icon.type);
    const partial = `${target}.${process.hrtime.bigint()}.partial`;
    try {
      await fsp.writeFile(partial, icon.data);
      await fsp.rename(partial, target);
    } finally {
      await fsp.rm(partial, { force: true });
    }
    await this.removeIcon(appId, icon.type);
  }

  /** Removes a shortcut's icon in every form it may have been kept in but the one named. */
  private async removeIcon(appId: string, except?: IconType): Promise<void> {
    await Promise.all((Object.keys(ICON_TYPES) as IconType[]).filter((type) => type !== except).map((type) => fsp.rm(this.iconPath(appId, type), { force: true })));
  }

  /** Tells the desktops that show a shortcut that it changed: its owner's, or everyone's. */
  private announce(ownerId: string | null): void {
    this.events.publish(ownerId === null ? { type: "apps.updated" } : { type: "apps.updated", userId: ownerId });
  }
}
