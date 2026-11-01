import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { fileTagSchema } from "../lib/file-tags.js";
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
    defaultView: viewSchema,
    /** The tags a person keeps at hand to put on files. Only they write it: nothing is added from the files they see or tag. */
    tags: z
      .array(
        // The shape a tag is drawn in is this person's own: the file has a place for a name and a colour only.
        fileTagSchema.extend({ shape: z.enum(["circle", "triangle", "diamond", "square", "pentagon", "hexagon", "star"]).optional() })
      )
      .max(100)
      .refine((tags) => new Set(tags.map((tag) => tag.name)).size === tags.length)
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

/** A folder a person keeps at hand, to reach it from any window in one step. */
export const favoriteSchema = folderViewQuerySchema;

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

/** The most folders one person can keep among their favorites. */
const MAX_FAVORITES = 200;

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
    const favorites = rows<{ root_slug: string; path: string }>(
      this.db
        .prepare(
          `SELECT roots.slug AS root_slug, favorites.path
          FROM favorites
          JOIN roots ON roots.id = favorites.root_id
          WHERE favorites.user_id = ?
          ORDER BY favorites.created_at, favorites.rowid`
        )
        .all(userId)
    ).map((favorite) => ({ rootSlug: favorite.root_slug, path: favorite.path }));
    return { settings: stored ? (JSON.parse(stored.settings_json) as Settings) : {}, folderViews, favorites };
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

  /** Puts a folder at the end of a person's favorites. One already there stays where it is. */
  addFavorite(userId: string, input: z.infer<typeof favoriteSchema>) {
    const root = this.roots.getBySlug(input.rootSlug);
    const logicalPath = this.paths.normalizeLogicalPath(input.path);
    const count = row<{ count: number }>(this.db.prepare("SELECT COUNT(*) AS count FROM favorites WHERE user_id = ?").get(userId))?.count ?? 0;
    if (count >= MAX_FAVORITES) throw new AppError(400, `At most ${MAX_FAVORITES} folders can be favorites`, "FAVORITE_LIMIT");
    this.db.prepare("INSERT OR IGNORE INTO favorites (user_id, root_id, path, created_at) VALUES (?, ?, ?, ?)").run(userId, root.id, logicalPath, now());
    this.events.publish({ type: "settings.updated", userId });
    return this.get(userId);
  }

  removeFavorite(userId: string, input: z.infer<typeof favoriteSchema>) {
    const root = this.roots.getBySlug(input.rootSlug);
    this.db.prepare("DELETE FROM favorites WHERE user_id = ? AND root_id = ? AND path = ?").run(userId, root.id, this.paths.normalizeLogicalPath(input.path));
    this.events.publish({ type: "settings.updated", userId });
    return this.get(userId);
  }

  /** Carries the views of a folder and the favorites in it, and those of everything inside it, to where Kago has just renamed or moved it. */
  moved(fromRootId: string, fromPath: string, toRootId: string, toPath: string): void {
    const within = "root_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')";
    const from = [fromRootId, fromPath, fromPath, fromPath];
    const users = rows<{ user_id: string }>(
      this.db.prepare(`SELECT user_id FROM folder_views WHERE ${within} UNION SELECT user_id FROM favorites WHERE ${within}`).all(...from, ...from)
    );
    if (users.length === 0) return;
    // Whatever was set for the place it arrives at belonged to something that is no longer there.
    this.db.prepare(`UPDATE OR REPLACE folder_views SET root_id = ?, path = ? || substr(path, length(?) + 1) WHERE ${within}`).run(toRootId, toPath, fromPath, ...from);
    // A favorite already there stays; the one that arrived is the same folder twice.
    this.db.prepare(`UPDATE OR IGNORE favorites SET root_id = ?, path = ? || substr(path, length(?) + 1) WHERE ${within}`).run(toRootId, toPath, fromPath, ...from);
    this.db.prepare(`DELETE FROM favorites WHERE ${within}`).run(...from);
    for (const user of users) this.events.publish({ type: "settings.updated", userId: user.user_id });
  }
}
