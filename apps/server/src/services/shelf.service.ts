import path from "node:path";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { EventHub } from "../ws/events.js";
import type { PathService } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { Actor } from "./types.js";

export class ShelfService {
  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly events: EventHub
  ) {}

  ensureDefault(ownerId: string) {
    const existing = row<{ id: string }>(this.db.prepare("SELECT id FROM shelves WHERE owner_id = ? LIMIT 1").get(ownerId));
    if (existing) return existing.id;
    const ts = now();
    const shelfId = id("shelf");
    this.db
      .prepare("INSERT INTO shelves (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(shelfId, ownerId, "Default", ts, ts);
    return shelfId;
  }

  list(actor: Actor) {
    const shelfId = this.ensureDefault(actor.id);
    const shelfRows = rows<{ id: string; owner_id: string; name: string; created_at: number; updated_at: number }>(
      this.db.prepare("SELECT * FROM shelves WHERE owner_id = ? ORDER BY created_at ASC").all(actor.id)
    );
    return shelfRows
      .map((shelf) => ({
        ...shelf,
        items: this.db
          .prepare(
            `SELECT shelf_items.*, roots.slug AS root_slug
            FROM shelf_items
            JOIN roots ON roots.id = shelf_items.root_id
            WHERE shelf_id = ?
            ORDER BY added_at DESC`
          )
          .all(shelf.id as string)
      }))
      .filter((shelf) => shelf.id || shelfId);
  }

  create(actor: Actor, name: string) {
    const ts = now();
    const shelf = { id: id("shelf"), owner_id: actor.id, name, created_at: ts, updated_at: ts };
    this.db
      .prepare("INSERT INTO shelves (id, owner_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(shelf.id, shelf.owner_id, shelf.name, shelf.created_at, shelf.updated_at);
    return shelf;
  }

  async addItem(actor: Actor, shelfId: string, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "list", safe.root, safe.logicalPath);
    const stat = await import("node:fs/promises").then((fs) => fs.stat(safe.absolutePath));
    const item = {
      id: id("shelfitem"),
      shelf_id: shelfId,
      root_id: safe.root.id,
      path: safe.logicalPath,
      kind: stat.isDirectory() ? "folder" : "file",
      name: path.basename(safe.absolutePath),
      size: stat.size,
      added_at: now()
    };
    this.db
      .prepare(
        "INSERT INTO shelf_items (id, shelf_id, root_id, path, kind, name, size, added_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(item.id, item.shelf_id, item.root_id, item.path, item.kind, item.name, item.size, item.added_at);
    this.events.publish({ type: "shelf.updated", shelfId });
    return item;
  }

  removeItem(actor: Actor, shelfId: string, itemId: string): void {
    const shelf = row<{ owner_id: string }>(this.db.prepare("SELECT owner_id FROM shelves WHERE id = ?").get(shelfId));
    if (!shelf || shelf.owner_id !== actor.id) throw new AppError(404, "Shelf not found", "SHELF_NOT_FOUND");
    this.db.prepare("DELETE FROM shelf_items WHERE shelf_id = ? AND id = ?").run(shelfId, itemId);
    this.events.publish({ type: "shelf.updated", shelfId });
  }

  itemsForTask(actor: Actor, shelfId: string) {
    const shelf = row<{ owner_id: string }>(this.db.prepare("SELECT owner_id FROM shelves WHERE id = ?").get(shelfId));
    if (!shelf || shelf.owner_id !== actor.id) throw new AppError(404, "Shelf not found", "SHELF_NOT_FOUND");
    return rows<{ root_slug: string; path: string }>(
      this.db
        .prepare(
          `SELECT roots.slug AS root_slug, shelf_items.path
          FROM shelf_items
          JOIN roots ON roots.id = shelf_items.root_id
          WHERE shelf_id = ?`
        )
        .all(shelfId)
    );
  }
}
