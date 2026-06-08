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

export const rootInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9_-]+$/).min(1).max(64),
  name: z.string().min(1).max(120),
  basePath: z.string().min(1),
  readonly: z.boolean().optional().default(false)
});

export class RootService {
  constructor(
    private readonly db: Db,
    private readonly dataDir: string
  ) {}

  list(): Root[] {
    return rows<Root>(this.db.prepare("SELECT * FROM roots ORDER BY name ASC").all());
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

  create(input: z.infer<typeof rootInputSchema>): Root {
    if (reservedSlugs.has(input.slug)) throw new AppError(400, "Reserved root slug", "RESERVED_SLUG");
    if (row<Root>(this.db.prepare("SELECT * FROM roots WHERE slug = ?").get(input.slug))) {
      throw new AppError(409, "Root slug already exists", "ROOT_SLUG_EXISTS");
    }
    const basePath = this.resolveBasePath(input.basePath);
    fs.mkdirSync(basePath, { recursive: true });
    this.assertBasePathInsideData(basePath);
    const ts = now();
    const root: Root = {
      id: id("root"),
      slug: input.slug,
      name: input.name,
      base_path: basePath,
      readonly: input.readonly ? 1 : 0,
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

  patch(rootId: string, input: Partial<z.infer<typeof rootInputSchema>>): Root {
    const root = this.getById(rootId);
    const next = {
      name: input.name ?? root.name,
      basePath: input.basePath ? this.resolveBasePath(input.basePath) : root.base_path,
      readonly: input.readonly === undefined ? root.readonly : input.readonly ? 1 : 0
    };
    fs.mkdirSync(next.basePath, { recursive: true });
    this.assertBasePathInsideData(next.basePath);
    this.db
      .prepare("UPDATE roots SET name = ?, base_path = ?, readonly = ?, updated_at = ? WHERE id = ?")
      .run(next.name, next.basePath, next.readonly, now(), rootId);
    return this.getById(rootId);
  }

  delete(rootId: string): void {
    this.getById(rootId);
    this.db.prepare("DELETE FROM roots WHERE id = ?").run(rootId);
  }

  private resolveBasePath(basePath: string): string {
    if (basePath !== "/data" && !basePath.startsWith("/data/")) {
      throw new AppError(400, "Root base path must be inside /data", "ROOT_PATH_OUTSIDE_DATA");
    }

    const dataRoot = path.resolve(this.dataDir);
    const candidate = basePath === "/data" ? dataRoot : path.resolve(dataRoot, basePath.slice("/data/".length));
    if (!isInside(dataRoot, candidate)) {
      throw new AppError(400, "Root base path escapes /data", "ROOT_PATH_ESCAPES_DATA");
    }
    return candidate;
  }

  private assertBasePathInsideData(candidate: string): void {
    const dataRoot = fs.realpathSync(this.dataDir);
    const target = fs.realpathSync(candidate);
    if (!isInside(dataRoot, target)) {
      throw new AppError(400, "Root base path escapes /data", "ROOT_PATH_ESCAPES_DATA");
    }
  }
}

function isInside(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
