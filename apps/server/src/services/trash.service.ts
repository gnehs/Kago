import fsp from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import { bytesToCarry, movePath, removeTree, type Found } from "../lib/tree-ops.js";
import { TRASH_FOLDER } from "../lib/system-files.js";
import { isRemote } from "../storage/remote-storage.js";
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

/** A trash item to remove for good, with where it lies: `remote` for a remote location's, `local` for the trash dir entry of a local one. */
export type EmptiableTrashItem = { item: RestorableTrashItem; remote: Root | null; local: string | null };

/** Where thrown-away files wait, and the record of where each came from. Running the tasks that fill, restore and empty it is TaskService's. */
export class TrashService {
  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly appDataDir: string
  ) {}

  list(actor: Actor) {
    const publicColumns = "id, original_root_id, original_path, deleted_by, deleted_at, restored_at";
    if (actor.role === "ADMIN") {
      return this.db.prepare(`SELECT ${publicColumns} FROM trash_items WHERE restored_at IS NULL ORDER BY deleted_at DESC`).all();
    }
    return this.db
      .prepare(`SELECT ${publicColumns} FROM trash_items WHERE deleted_by = ? AND restored_at IS NULL ORDER BY deleted_at DESC`)
      .all(actor.id);
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

  /** What `place` would have to copy: nothing on a remote, which keeps its own trash. */
  async carryBytes(safe: SafePath, found?: Found): Promise<number> {
    if (isRemote(safe.root)) return 0;
    return bytesToCarry(safe.absolutePath, await this.localDir(safe.root), found);
  }

  /**
   * Moves a file or folder into the trash and records it. The caller has already checked that the actor may remove it.
   * Resolves to whether the bytes were streamed through `onBytes`, as opposed to renamed.
   */
  async place(actor: Actor, safe: SafePath, onBytes: (bytes: number) => void = () => undefined): Promise<boolean> {
    let streamed = false;
    if (isRemote(safe.root)) {
      // A remote keeps its own trash, so nothing has to be fetched to throw it away.
      const trashPath = `${this.storage.remote.trashFolder(safe.root, safe.logicalPath)}/${Date.now()}-${id("trash")}-${this.storage.name(safe)}`;
      await this.storage.remote.mkdir(safe.root, path.posix.dirname(trashPath));
      await this.storage.remote.move(safe.root, safe.logicalPath, trashPath, (await this.storage.stat(safe)).isDirectory());
      this.record(actor, safe, trashPath);
    } else {
      const trashPath = path.join(await this.localDir(safe.root), `${Date.now()}-${id("trash")}-${path.basename(safe.absolutePath)}`);
      streamed = await this.moveLocal(actor, safe, trashPath, onBytes);
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

  private record(actor: Actor, safe: SafePath, trashPath: string): string {
    const itemId = id("trashitem");
    this.db
      .prepare("INSERT INTO trash_items (id, original_root_id, original_path, trash_path, deleted_by, deleted_at, restored_at) VALUES (?, ?, ?, ?, ?, ?, NULL)")
      .run(itemId, safe.root.id, safe.logicalPath, trashPath, actor.id, now());
    return itemId;
  }

  /**
   * Moves a local file or folder into the trash, recorded before it gets there. A copy to another disk that is cut
   * short would otherwise leave in the trash what nothing tells the trash to empty. When the move fails, the record
   * is taken back only if nothing arrived: what was copied whole before the source could not all be removed is in
   * the trash, and stays restorable.
   */
  private async moveLocal(actor: Actor, safe: SafePath, trashPath: string, onBytes: (bytes: number) => void): Promise<boolean> {
    const itemId = this.record(actor, safe, trashPath);
    try {
      return await movePath(safe.absolutePath, trashPath, onBytes);
    } catch (error) {
      if (!(await fsp.lstat(trashPath).catch(() => null))) this.db.prepare("DELETE FROM trash_items WHERE id = ?").run(itemId);
      throw error;
    }
  }
}
