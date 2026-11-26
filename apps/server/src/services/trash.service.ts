import fsp from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError, errnoIs } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { TrashItem, TrashKind } from "@kago/contract";
import { bytesToCarry, limiter, measureTree, movePath, onAnotherDisk, removeTree, type FileHooks, type Found } from "../lib/tree-ops.js";
import { TRASH_FOLDER } from "../lib/system-files.js";
import { isRemote } from "../storage/remote-storage.js";
import type { EventPublisher } from "../ws/events.js";
import type { AuditService } from "./audit.service.js";
import type { PathService, SafePath } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { StorageService } from "./storage.service.js";
import type { Actor, Root } from "./types.js";

export type RestorableTrashItem = {
  id: string;
  original_path: string;
  trash_path: string;
  original_root_id: string;
  deleted_by: string;
};

/** What is recorded of a thing as it is thrown away. `size` and `items` are null where not known, or not yet: see `measureLater`. */
export type Measured = { kind: TrashKind; size: number | null; items: number | null };

const LISTED_ITEM = `SELECT trash_items.id, trash_items.original_root_id, trash_items.original_path, trash_items.deleted_by, trash_items.deleted_at, trash_items.restored_at,
    trash_items.kind, trash_items.size, trash_items.item_count, trash_items.deletion_id,
    users.email AS deleter_email, users.display_name AS deleter_name, users.avatar_at AS deleter_avatar_at
  FROM trash_items JOIN users ON users.id = trash_items.deleted_by`;

/** A trash item to remove for good, with where it lies: `remote` for a remote location's, `local` for the trash dir entry of a local one. */
export type EmptiableTrashItem = { item: RestorableTrashItem; remote: Root | null; local: string | null };

/** How long sizes that were filled in are gathered before the people looking at the Trash are told, so that many folders at once are one message. */
const tellAfterMs = 250;
/** How many unmeasured folders are picked up again when a worker starts. */
const leftoverLimit = 200;

/** Where thrown-away files wait, and the record of where each came from. Running the tasks that fill, restore and empty it is TaskService's. */
export class TrashService {
  /** One folder is measured at a time in a worker, however many were thrown away at once. */
  private readonly oneAtATime = limiter(1);
  private readonly measuring = new Set<Promise<void>>();
  private readonly toTell = new Set<string>();
  private tellTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly appDataDir: string,
    private readonly events: EventPublisher
  ) {}

  list(actor: Actor): TrashItem[] {
    const found = (actor.role === "ADMIN"
      ? this.db.prepare(`${LISTED_ITEM} WHERE trash_items.restored_at IS NULL ORDER BY trash_items.deleted_at DESC, trash_items.rowid DESC`).all()
      : this.db
          .prepare(`${LISTED_ITEM} WHERE trash_items.deleted_by = ? AND trash_items.restored_at IS NULL ORDER BY trash_items.deleted_at DESC, trash_items.rowid DESC`)
          .all(actor.id)) as Array<Omit<TrashItem, "deleter"> & { deleter_email: string; deleter_name: string; deleter_avatar_at: number | null }>;
    return found.map(({ deleter_email, deleter_name, deleter_avatar_at, ...item }) => ({
      ...item,
      deleter: { id: item.deleted_by, email: deleter_email, display_name: deleter_name, avatar_at: deleter_avatar_at }
    }));
  }

  /** The ids of everything the actor can see in the trash. */
  visibleIds(actor: Actor): string[] {
    return rows<{ id: string }>(
      actor.role === "ADMIN"
        ? this.db.prepare("SELECT id FROM trash_items WHERE restored_at IS NULL").all()
        : this.db.prepare("SELECT id FROM trash_items WHERE deleted_by = ? AND restored_at IS NULL").all(actor.id)
    ).map((item) => item.id);
  }

  /**
   * How much of what is to be thrown away would have to be copied to get to the trash, which is what makes it
   * slow: only what lies on another disk than the trash it goes to. Anything else is renamed, however large.
   */
  async cost(actor: Actor, sources: Array<{ rootSlug: string; path: string }>): Promise<{ copyBytes: number }> {
    let copyBytes = 0;
    for (const source of sources) {
      const safe = await this.paths.resolveExisting(source.rootSlug, source.path);
      this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
      copyBytes += await this.carryBytes(safe);
    }
    return { copyBytes };
  }

  /**
   * What `place` would have to copy: nothing on a remote, which keeps its own trash. With `measured`, which has
   * added the thing up already, a copy to another disk is not read through a second time to know what it is.
   */
  async carryBytes(safe: SafePath, found?: Found, measured?: Measured): Promise<number> {
    if (isRemote(safe.root)) return 0;
    const folder = await this.localDir(safe.root);
    if (!measured) return bytesToCarry(safe.absolutePath, folder, found);
    return (await onAnotherDisk(safe.absolutePath, folder)) ? (measured.size ?? 0) : 0;
  }

  /**
   * What the Trash records of something about to be thrown away, without reading through what is renamed: a local
   * folder on the trash's own disk is recorded with no size, and `measureLater` adds it up once it is in the trash.
   * One that has to be copied to another disk is read through here anyway, for the task to count and show progress by.
   * A remote folder is not, as every entry would be a round trip.
   */
  async measure(safe: SafePath, found?: Found): Promise<Measured> {
    if (isRemote(safe.root)) {
      const stat = await this.storage.stat(safe);
      return stat.isDirectory() ? { kind: "folder", size: null, items: null } : { kind: "file", size: stat.size, items: null };
    }
    const top = await fsp.lstat(safe.absolutePath).catch((error: unknown) => {
      if (!errnoIs(error, "ENOENT")) throw error;
      return null;
    });
    if (!top) return { kind: "file", size: null, items: null };
    if (!top.isDirectory()) return { kind: "file", size: top.size, items: null };
    if (!(await onAnotherDisk(safe.absolutePath, await this.localDir(safe.root)))) return { kind: "folder", size: null, items: null };
    const tree = await measureTree(safe.absolutePath, found);
    return tree ? { kind: "folder", size: tree.bytes, items: tree.entries } : { kind: "folder", size: null, items: null };
  }

  /**
   * Moves a file or folder into the trash and records it. The caller has already checked that the actor may remove it.
   * `deletionId` names the action that throws it away, which puts what goes in the same one together; `measured` is
   * what `measure` found of it, if it was asked already. Resolves to whether the bytes were streamed through
   * `onBytes`, as opposed to renamed.
   */
  async place(actor: Actor, safe: SafePath, deletionId: string, measured?: Measured, onBytes: (bytes: number) => void = () => undefined, onFile?: FileHooks): Promise<boolean> {
    const known = measured ?? (await this.measure(safe));
    let streamed = false;
    if (isRemote(safe.root)) {
      // A remote keeps its own trash, so nothing has to be fetched to throw it away.
      const trashPath = `${this.storage.remote.trashFolder(safe.root, safe.logicalPath)}/${Date.now()}-${id("trash")}-${this.storage.name(safe)}`;
      await this.storage.remote.mkdir(safe.root, path.posix.dirname(trashPath));
      await this.storage.remote.move(safe.root, safe.logicalPath, trashPath, known.kind === "folder");
      this.record(actor, safe, trashPath, deletionId, known);
    } else {
      const trashPath = path.join(await this.localDir(safe.root), `${Date.now()}-${id("trash")}-${path.basename(safe.absolutePath)}`);
      streamed = await this.moveLocal(actor, safe, trashPath, deletionId, known, onBytes, onFile);
    }
    this.audit.write({ actorType: "user", actorId: actor.id, action: "delete_to_trash", rootId: safe.root.id, path: safe.logicalPath, result: "success" });
    return streamed;
  }

  getRestorable(actor: Actor, trashItemId: string): RestorableTrashItem {
    const item = row<RestorableTrashItem>(
      this.db.prepare("SELECT * FROM trash_items WHERE id = ? AND restored_at IS NULL").get(trashItemId)
    );
    if (!item) throw new AppError(404, "Trash item not found", "TRASH_ITEM_NOT_FOUND");
    if (actor.role !== "ADMIN" && item.deleted_by !== actor.id) {
      throw new AppError(404, "Trash item not found", "TRASH_ITEM_NOT_FOUND");
    }
    return item;
  }

  markRestored(itemId: string): void {
    this.db.prepare("UPDATE trash_items SET restored_at = ? WHERE id = ?").run(now(), itemId);
  }

  /** The trash dir a local trash item lies directly in, when it is one Kago throws into: the location's own, or the one in the app data. */
  dirOf(root: Root | null, trashPath: string): string | null {
    const dir = path.dirname(path.resolve(trashPath));
    const known = [path.resolve(this.appDataDir, "trash"), ...(root && !isRemote(root) ? [path.resolve(root.base_path, TRASH_FOLDER)] : [])];
    return known.includes(dir) ? dir : null;
  }

  requireDirOf(root: Root, trashPath: string): string {
    const dir = this.dirOf(root, trashPath);
    if (!dir) throw new AppError(404, "Trash item not found", "TRASH_ITEM_NOT_FOUND");
    return dir;
  }

  /** The item a task to empty the trash names, or null when it has gone since or is not the actor's. */
  async emptiable(actor: Actor, trashItemId: string): Promise<EmptiableTrashItem | null> {
    const item = row<RestorableTrashItem>(this.db.prepare("SELECT * FROM trash_items WHERE id = ? AND restored_at IS NULL").get(trashItemId));
    if (!item || (actor.role !== "ADMIN" && item.deleted_by !== actor.id)) return null;
    const root = await this.paths.resolveRootById(item.original_root_id, "/").then((safe) => safe.root, () => null);
    const remote = root && isRemote(root) ? root : null;
    // Trashed entries always sit directly inside a trash dir; never remove anything else.
    const local = !remote && this.dirOf(root, item.trash_path) ? item.trash_path : null;
    return { item, remote, local };
  }

  /** Removes an item for good, calling `onEntry` for each file or folder of a local one as it goes. */
  async discard({ item, remote, local }: EmptiableTrashItem, onEntry: () => void): Promise<void> {
    if (remote) {
      // What a remote location threw away lies in its own hidden folder; anything else is not Kago's to remove.
      const entry = this.storage.remote.isTrashItem(remote, item.trash_path) ? await this.storage.remote.stat(remote, item.trash_path) : null;
      if (entry) await this.storage.remote.remove(remote, item.trash_path, entry.directory);
    } else if (local) {
      await removeTree(local, onEntry);
    }
    this.db.prepare("DELETE FROM trash_items WHERE id = ?").run(item.id);
  }

  /**
   * The trash a local location throws into: a folder at its own top, so that what is thrown away stays on its disk
   * and is renamed, not copied. A location whose top cannot take one falls back to the trash in the app data.
   */
  private async localDir(root: Root): Promise<string> {
    const own = path.join(root.base_path, TRASH_FOLDER);
    await fsp.mkdir(own).catch(() => undefined);
    // Something else by that name, a symlink among them, is not a place to put things.
    if ((await fsp.lstat(own).catch(() => null))?.isDirectory()) return own;
    const shared = path.join(this.appDataDir, "trash");
    await fsp.mkdir(shared, { recursive: true });
    return shared;
  }

  /**
   * Adds up a folder that was renamed into the trash unmeasured, after the task that threw it away has finished, and
   * writes the result into its row. Only while the row is still listed and unmeasured: one restored or removed for
   * good meanwhile has nothing written, and a walk that finds the folder moving away under it writes nothing either.
   * What cannot be added up, or a server that stops first, leaves the row null, which the Trash shows as unknown.
   */
  private measureLater(itemId: string, trashPath: string, userId: string): void {
    const job = this.oneAtATime(async () => {
      if (!this.db.prepare("SELECT 1 FROM trash_items WHERE id = ? AND restored_at IS NULL AND size IS NULL").get(itemId)) return;
      const tree = await measureTree(trashPath, undefined, { moving: true });
      if (!tree?.directory) return;
      const written = this.db
        .prepare("UPDATE trash_items SET size = ?, item_count = ? WHERE id = ? AND restored_at IS NULL AND size IS NULL")
        .run(tree.bytes, tree.entries, itemId);
      if (written.changes > 0) this.tellLater(userId);
    }).catch(() => undefined);
    this.measuring.add(job);
    void job.finally(() => this.measuring.delete(job));
  }

  /**
   * Local folders that were thrown away and never measured, because the worker stopped first, are queued again, the
   * newest 200 and one at a time behind anything else. Remote folders and items from before sizes were kept are not
   * local folders of this kind, and keep none. Called as a worker starts; it only schedules, and returns at once.
   */
  async measureLeftover(): Promise<void> {
    const left = rows<{ id: string; original_root_id: string; trash_path: string; deleted_by: string }>(
      this.db
        .prepare("SELECT id, original_root_id, trash_path, deleted_by FROM trash_items WHERE kind = 'folder' AND size IS NULL AND restored_at IS NULL ORDER BY deleted_at DESC LIMIT ?")
        .all(leftoverLimit)
    );
    for (const item of left) {
      const root = await this.paths.resolveRootById(item.original_root_id, "/").then((safe) => safe.root, () => null);
      if (root && !isRemote(root) && this.dirOf(root, item.trash_path)) this.measureLater(item.id, item.trash_path, item.deleted_by);
    }
  }

  /** Resolves once every folder queued for measuring has been measured or given up, and whoever is to hear of it has been told. */
  async settled(): Promise<void> {
    while (this.measuring.size > 0) await Promise.all([...this.measuring]);
    this.tellNow();
  }

  /** Tells whoever threw items away that their sizes are in; bursts of folders landing together are told as one. */
  private tellLater(userId: string): void {
    this.toTell.add(userId);
    this.tellTimer ??= setTimeout(() => this.tellNow(), tellAfterMs).unref();
  }

  private tellNow(): void {
    if (this.tellTimer) clearTimeout(this.tellTimer);
    this.tellTimer = null;
    const users = [...this.toTell];
    this.toTell.clear();
    for (const userId of users) this.events.publish({ type: "trash.updated", userId });
  }

  private record(actor: Actor, safe: SafePath, trashPath: string, deletionId: string, measured: Measured): string {
    const itemId = id("trashitem");
    this.db
      .prepare(
        "INSERT INTO trash_items (id, original_root_id, original_path, trash_path, deleted_by, deleted_at, restored_at, kind, size, item_count, deletion_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)"
      )
      .run(itemId, safe.root.id, safe.logicalPath, trashPath, actor.id, now(), measured.kind, measured.size, measured.items, deletionId);
    return itemId;
  }

  /**
   * Moves a local file or folder into the trash, recorded before it gets there. A copy to another disk that is cut
   * short would otherwise leave in the trash what nothing tells the trash to empty. When the move fails, the record
   * is taken back only if nothing arrived: what was copied whole before the source could not all be removed is in
   * the trash, and stays restorable.
   */
  private async moveLocal(actor: Actor, safe: SafePath, trashPath: string, deletionId: string, measured: Measured, onBytes: (bytes: number) => void, onFile?: FileHooks): Promise<boolean> {
    const itemId = this.record(actor, safe, trashPath, deletionId, measured);
    try {
      const streamed = await movePath(safe.absolutePath, trashPath, onBytes, onFile);
      if (measured.kind === "folder" && measured.size === null) this.measureLater(itemId, trashPath, actor.id);
      return streamed;
    } catch (error) {
      if (!(await fsp.lstat(trashPath).catch(() => null))) this.db.prepare("DELETE FROM trash_items WHERE id = ?").run(itemId);
      throw error;
    }
  }
}
