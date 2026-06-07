import { z } from "zod";
import type { Db } from "../db/db.js";
import { rows } from "../db/db.js";
import { id, now } from "../lib/ids.js";
import type { PathService } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { Actor } from "./types.js";

export const tagSchema = z.object({
  name: z.string().min(1).max(80),
  color: z.string().max(40).optional()
});

export class TagService {
  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService
  ) {}

  list(actor: Actor) {
    return this.db
      .prepare("SELECT * FROM tags WHERE owner_id IS NULL OR owner_id = ? ORDER BY name ASC")
      .all(actor.id);
  }

  create(actor: Actor, input: z.infer<typeof tagSchema>) {
    const ts = now();
    const tag = { id: id("tag"), name: input.name, color: input.color ?? null, owner_id: actor.id, created_at: ts, updated_at: ts };
    this.db
      .prepare("INSERT INTO tags (id, name, color, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(tag.id, tag.name, tag.color, tag.owner_id, tag.created_at, tag.updated_at);
    return tag;
  }

  async getFileTags(actor: Actor, rootSlug: string, logicalPath: string) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "read", safe.root, safe.logicalPath);
    return rows(
      this.db
        .prepare(
          `SELECT tags.* FROM file_tags
          JOIN tags ON tags.id = file_tags.tag_id
          WHERE file_tags.root_id = ? AND file_tags.path = ?`
        )
        .all(safe.root.id, safe.logicalPath)
    );
  }

  async setFileTags(actor: Actor, rootSlug: string, logicalPath: string, tagIds: string[]) {
    const safe = await this.paths.resolveExisting(rootSlug, logicalPath);
    this.permissions.require(actor, "manage_tags", safe.root, safe.logicalPath);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM file_tags WHERE root_id = ? AND path = ?").run(safe.root.id, safe.logicalPath);
      for (const tagId of tagIds) {
        this.db
          .prepare("INSERT INTO file_tags (root_id, path, tag_id, created_at) VALUES (?, ?, ?, ?)")
          .run(safe.root.id, safe.logicalPath, tagId, now());
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getFileTags(actor, rootSlug, logicalPath);
  }
}
