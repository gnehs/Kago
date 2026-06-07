import { z } from "zod";
import type { Db } from "../db/db.js";
import { row } from "../db/db.js";
import { now } from "../lib/ids.js";
import type { RootService } from "./root.service.js";

const fileWindowSchema = z.object({
  id: z.string().min(1),
  rootSlug: z.string().regex(/^[a-z0-9_-]+$/),
  logicalPath: z.string().min(1),
  title: z.string().min(1).max(160),
  x: z.number().int().min(-200).max(10000),
  y: z.number().int().min(0).max(10000),
  width: z.number().int().min(360).max(4000),
  height: z.number().int().min(280).max(3000),
  zIndex: z.number().int().min(100).max(499),
  minimized: z.boolean(),
  maximized: z.boolean(),
  focused: z.boolean().optional().default(false),
  viewMode: z.enum(["list", "grid", "columns"]),
  sortBy: z.enum(["name", "size", "mtime", "type"]),
  sortDirection: z.enum(["asc", "desc"]),
  selectedItems: z.array(z.string()).default([]),
  scrollTop: z.number().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional()
});

export const workspaceSchema = z.object({
  activeWindowId: z.string().nullable().optional(),
  windows: z.array(fileWindowSchema).max(12),
  sidebar: z.record(z.unknown()).nullable().optional(),
  inspector: z.record(z.unknown()).nullable().optional(),
  shelf: z.record(z.unknown()).nullable().optional()
});

export class WorkspaceService {
  constructor(
    private readonly db: Db,
    private readonly roots: RootService
  ) {}

  get(userId: string): z.infer<typeof workspaceSchema> {
    const stored = row<{
      windows_json: string;
      active_window_id: string | null;
      sidebar_json: string | null;
      inspector_json: string | null;
      shelf_json: string | null;
    }>(this.db.prepare("SELECT * FROM user_workspaces WHERE user_id = ?").get(userId));

    if (!stored) {
      return {
        activeWindowId: null,
        windows: [],
        sidebar: { collapsed: false },
        inspector: { open: false, width: 320 },
        shelf: { collapsed: false, x: 320, y: 720 }
      };
    }

    return {
      activeWindowId: stored.active_window_id,
      windows: JSON.parse(stored.windows_json),
      sidebar: stored.sidebar_json ? JSON.parse(stored.sidebar_json) : { collapsed: false },
      inspector: stored.inspector_json ? JSON.parse(stored.inspector_json) : { open: false, width: 320 },
      shelf: stored.shelf_json ? JSON.parse(stored.shelf_json) : { collapsed: false, x: 320, y: 720 }
    };
  }

  save(userId: string, input: z.infer<typeof workspaceSchema>): z.infer<typeof workspaceSchema> {
    for (const window of input.windows) {
      this.roots.getBySlug(window.rootSlug);
    }

    const ts = now();
    this.db
      .prepare(
        `INSERT INTO user_workspaces
        (user_id, windows_json, active_window_id, sidebar_json, inspector_json, shelf_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET
          windows_json = excluded.windows_json,
          active_window_id = excluded.active_window_id,
          sidebar_json = excluded.sidebar_json,
          inspector_json = excluded.inspector_json,
          shelf_json = excluded.shelf_json,
          updated_at = excluded.updated_at`
      )
      .run(
        userId,
        JSON.stringify(input.windows),
        input.activeWindowId ?? null,
        JSON.stringify(input.sidebar ?? {}),
        JSON.stringify(input.inspector ?? {}),
        JSON.stringify(input.shelf ?? {}),
        ts
      );
    return this.get(userId);
  }
}
