import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { now } from "../lib/ids.js";
import type { EventPublisher } from "../ws/events.js";
import type { PathService } from "./path.service.js";
import type { RootService } from "./root.service.js";

const viewMode = z.enum(["list", "grid", "columns"]);

/** How a folder is shown. Every part is optional: what is left out is taken from further up. */
const viewSchema = z
  .object({
    viewMode,
    iconSize: z.enum(["large", "medium", "small"]),
    sortBy: z.enum(["name", "size", "mtime", "type"]),
    sortDirection: z.enum(["asc", "desc"])
  })
  .partial()
  .strict();

/** What a person has set for themselves, wherever they sign in. A request names only what it changes. */
export const settingsSchema = z
  .object({
    theme: z.enum(["system", "light", "dark"]),
    // The interface knows which languages it is written in; the server only keeps the choice.
    locale: z.string().min(1).max(35),
    motion: z.enum(["on", "off"]),
    windowControls: z.enum(["left", "right"]),
    /** Whether a folder of pictures and videos opens as icons before anyone has said how to show it. */
    smartView: z.boolean(),
    /** How folders are shown where nothing else says. */
    defaultView: viewSchema
  })
  .partial()
  .strict();

export const folderViewSchema = z.object({
  rootSlug: z.string().regex(/^[a-z0-9_-]+$/),
  path: z.string().min(1),
  view: viewSchema
    .extend({
      /** Whether the folders inside are shown the same way. */
      recursive: z.boolean().optional(),
      /** What the folder's contents suggested the first time it was opened. It is kept so the view does not change as files come and go. */
      autoMode: viewMode.optional()
    })
    .strict()
});

export const folderViewQuerySchema = folderViewSchema.pick({ rootSlug: true, path: true });

/** A request cannot name the desktop background: it is set by handing over a picture, and only its time is kept here. */
type Settings = z.infer<typeof settingsSchema> & { wallpaper?: number | null };

type FolderViewRow = {
  root_slug: string;
  path: string;
  view_mode: string | null;
  auto_mode: string | null;
  icon_size: string | null;
  sort_by: string | null;
  sort_direction: string | null;
  recursive: number;
};

/** The most folders one person's views are kept for; the ones untouched longest make room. */
const MAX_FOLDER_VIEWS = 5000;

export class PreferenceService {
  constructor(
    private readonly db: Db,
    private readonly roots: RootService,
    private readonly paths: PathService,
    private readonly events: EventPublisher
  ) {}

  get(userId: string) {
    const stored = row<{ settings_json: string }>(this.db.prepare("SELECT settings_json FROM user_settings WHERE user_id = ?").get(userId));
    const folderViews = rows<FolderViewRow>(
      this.db
        .prepare(
          `SELECT roots.slug AS root_slug, folder_views.*
          FROM folder_views
          JOIN roots ON roots.id = folder_views.root_id
          WHERE folder_views.user_id = ?`
        )
        .all(userId)
    ).map((view) => ({
      rootSlug: view.root_slug,
      path: view.path,
      viewMode: view.view_mode ?? undefined,
      autoMode: view.auto_mode ?? undefined,
      iconSize: view.icon_size ?? undefined,
      sortBy: view.sort_by ?? undefined,
      sortDirection: view.sort_direction ?? undefined,
      recursive: view.recursive === 1
    }));
    return { settings: stored ? (JSON.parse(stored.settings_json) as Settings) : {}, folderViews };
  }

  /** Notes that the desktop background was set just now, or that there is none any more. */
  setWallpaper(userId: string, present: boolean) {
    return this.patchSettings(userId, { wallpaper: present ? Date.now() : null });
  }

  patchSettings(userId: string, patch: Settings) {
    const current = this.get(userId).settings;
    const next = { ...current, ...patch, ...(patch.defaultView ? { defaultView: { ...current.defaultView, ...patch.defaultView } } : {}) };
    this.db
      .prepare(
        `INSERT INTO user_settings (user_id, settings_json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET settings_json = excluded.settings_json, updated_at = excluded.updated_at`
      )
      .run(userId, JSON.stringify(next), now());
    this.events.publish({ type: "settings.updated", userId });
    return this.get(userId);
  }

  /** Sets the parts of a folder's view that are named, and leaves the rest as they were. */
  setFolderView(userId: string, input: z.infer<typeof folderViewSchema>) {
    const root = this.roots.getBySlug(input.rootSlug);
    const logicalPath = this.paths.normalizeLogicalPath(input.path);
    const { view } = input;
    const recursive = view.recursive === undefined ? null : Number(view.recursive);
    this.db
      .prepare(
        `INSERT INTO folder_views (user_id, root_id, path, view_mode, auto_mode, icon_size, sort_by, sort_direction, recursive, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, root_id, path) DO UPDATE SET
          view_mode = COALESCE(excluded.view_mode, view_mode),
          auto_mode = COALESCE(excluded.auto_mode, auto_mode),
          icon_size = COALESCE(excluded.icon_size, icon_size),
          sort_by = COALESCE(excluded.sort_by, sort_by),
          sort_direction = COALESCE(excluded.sort_direction, sort_direction),
          recursive = COALESCE(?, recursive),
          updated_at = excluded.updated_at`
      )
      .run(userId, root.id, logicalPath, view.viewMode ?? null, view.autoMode ?? null, view.iconSize ?? null, view.sortBy ?? null, view.sortDirection ?? null, recursive ?? 0, now(), recursive);
    this.db
      .prepare(
        `DELETE FROM folder_views WHERE user_id = ? AND rowid IN (
          SELECT rowid FROM folder_views WHERE user_id = ? ORDER BY updated_at DESC LIMIT -1 OFFSET ?
        )`
      )
      .run(userId, userId, MAX_FOLDER_VIEWS);
    this.events.publish({ type: "settings.updated", userId });
    return this.get(userId);
  }

  /** Forgets everything set for a folder, so it is shown the way the folders around it are. */
  resetFolderView(userId: string, input: z.infer<typeof folderViewQuerySchema>) {
    const root = this.roots.getBySlug(input.rootSlug);
    this.db.prepare("DELETE FROM folder_views WHERE user_id = ? AND root_id = ? AND path = ?").run(userId, root.id, this.paths.normalizeLogicalPath(input.path));
    this.events.publish({ type: "settings.updated", userId });
    return this.get(userId);
  }

  /** Carries the views of a folder, and of everything inside it, to where Kago has just renamed or moved it. */
  moved(fromRootId: string, fromPath: string, toRootId: string, toPath: string): void {
    const within = "root_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')";
    const from = [fromRootId, fromPath, fromPath, fromPath];
    const users = rows<{ user_id: string }>(this.db.prepare(`SELECT DISTINCT user_id FROM folder_views WHERE ${within}`).all(...from));
    if (users.length === 0) return;
    // Whatever was set for the place it arrives at belonged to something that is no longer there.
    this.db.prepare(`UPDATE OR REPLACE folder_views SET root_id = ?, path = ? || substr(path, length(?) + 1) WHERE ${within}`).run(toRootId, toPath, fromPath, ...from);
    for (const user of users) this.events.publish({ type: "settings.updated", userId: user.user_id });
  }
}
