import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { Root } from "./types.js";

const reservedSlugs = new Set([
  "api",
  "assets",
  "auth",
  "login",
  "logout",
  "admin",
  "settings",
  "tasks",
  "shares",
  "shelves",
  "tags",
  "trash",
  "users",
  "groups",
  "permissions",
  "audit",
  "s",
  "_kago",
  "static",
  "favicon.ico",
  "robots.txt"
]);

export const rootPatchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  readonly: z.boolean().optional()
});

export class RootService {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string
  ) {}

  list(): Root[] {
    return rows<Root>(this.db.prepare("SELECT * FROM roots ORDER BY name ASC").all());
  }

  /** Roots whose folder is currently present under the data dir, after picking up any new folders. */
  listMounted(): Root[] {
    this.syncFromDataDir();
    return this.list().filter((root) => fs.existsSync(root.base_path));
  }

  // Roots are not created by hand: every folder directly under the data dir is mounted as one.
  syncFromDataDir(): Root[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.dataDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dataRoot = path.resolve(this.dataDir);
    const known = new Set(this.list().map((root) => root.base_path));
    const created: Root[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || /^[.@#]/.test(entry.name)) continue;
      const basePath = path.join(dataRoot, entry.name);
      if (known.has(basePath)) continue;
      created.push(this.insert(this.availableSlug(entry.name), entry.name.slice(0, 120), basePath, false));
    }
    return created;
  }

  getBySlug(slug: string): Root {
    const root = row<Root>(this.db.prepare("SELECT * FROM roots WHERE slug = ?").get(slug));
    if (!root) throw new AppError(404, "Root not found", "ROOT_NOT_FOUND");
    return root;
  }

  getById(rootId: string): Root {
    const root = row<Root>(this.db.prepare("SELECT * FROM roots WHERE id = ?").get(rootId));
    if (!root) throw new AppError(404, "Root not found", "ROOT_NOT_FOUND");
    return root;
  }

  private insert(slug: string, name: string, basePath: string, readonly: boolean): Root {
    const ts = now();
    const root: Root = {
      id: id("root"),
      slug,
      name,
      base_path: basePath,
      readonly: readonly ? 1 : 0,
      created_at: ts,
      updated_at: ts
    };
    this.db
      .prepare(
        "INSERT INTO roots (id, slug, name, base_path, readonly, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
      )
      .run(root.id, root.slug, root.name, root.base_path, root.readonly, root.created_at, root.updated_at);
    return root;
  }

  private availableSlug(folderName: string): string {
    const cleaned = folderName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 56);
    // Names without any ASCII letters (e.g. CJK) get a stable hash-based slug instead.
    const base = cleaned || `folder-${createHash("sha1").update(folderName).digest("hex").slice(0, 8)}`;
    const taken = new Set(this.list().map((root) => root.slug));
    let slug = base;
    for (let n = 2; reservedSlugs.has(slug) || taken.has(slug); n += 1) slug = `${base}-${n}`;
    return slug;
  }

  patch(rootId: string, input: z.infer<typeof rootPatchSchema>): Root {
    const root = this.getById(rootId);
    const readonly = input.readonly === undefined ? root.readonly : input.readonly ? 1 : 0;
    this.db
      .prepare("UPDATE roots SET name = ?, readonly = ?, updated_at = ? WHERE id = ?")
      .run(input.name ?? root.name, readonly, now(), rootId);
    return this.getById(rootId);
  }
}
