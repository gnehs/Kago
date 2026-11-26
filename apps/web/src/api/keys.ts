import type { QueryKey } from "@tanstack/react-query";

/**
 * Every React Query key the app uses. A key is spelled here only, so what an invalidation reaches is read from one
 * place. Keys nest: `["fs", "list", root, path, "search", q]` sits under its folder's listing on purpose, so
 * invalidating a folder by prefix also reaches the searches made in it.
 */
export const keys = {
  auth: {
    all: () => ["auth"] as const,
    setup: () => ["auth", "setup"] as const,
    me: () => ["auth", "me"] as const,
    identities: () => ["auth", "identities"] as const
  },
  sso: () => ["sso"] as const,
  users: () => ["users"] as const,
  admins: () => ["admins"] as const,
  groups: () => ["groups"] as const,
  roots: () => ["roots"] as const,
  storage: () => ["storage"] as const,
  sshKey: () => ["ssh-key"] as const,
  workspace: () => ["workspace"] as const,
  shares: () => ["shares"] as const,
  tasks: () => ["tasks"] as const,
  externalApps: () => ["external-apps"] as const,
  shelves: () => ["shelves"] as const,
  trash: () => ["trash"] as const,
  plugins: () => ["plugins"] as const,
  appIcons: (name: string) => ["app-icons", name] as const,
  frameProbe: (url: string) => ["frame-probe", url] as const,
  thumbnailText: (source: unknown) => ["thumbnail-text", source] as const,
  audit: (scope: unknown) => ["audit", scope] as const,
  auditRun: (runId: string) => ["audit", "run", runId] as const,
  archivePasswords: () => ["archive-passwords"] as const,
  permissions: {
    all: () => ["permissions"] as const,
    forRoot: (rootId: string | undefined) => ["permissions", rootId ?? "all"] as const
  },
  convertJobs: () => ["convert-jobs"] as const,
  convertSupport: () => ["convert-support"] as const,
  convertRuns: (jobId: string | undefined, lastRunAt: unknown, lastStatus: unknown) => ["convert-runs", jobId, lastRunAt, lastStatus] as const,
  convertRunFiles: (jobId: string, taskId: string, status: unknown, bytes: unknown) => ["convert-run-files", jobId, taskId, status, bytes] as const,
  syncJobs: () => ["sync-jobs"] as const,
  syncTrial: (jobId: string | undefined, lastRunAt: unknown) => ["sync-trial", jobId, lastRunAt] as const,
  syncRuns: (jobId: string | undefined, lastRunAt: unknown, lastStatus: unknown) => ["sync-runs", jobId, lastRunAt, lastStatus] as const,
  /**
   * The text an editor was opened with. Not under `fs` on purpose: whatever reads every `fs` query again would read
   * this one too, and the editor would be rebuilt over what was being typed.
   */
  editorText: (rootSlug: string, path: string) => ["editor-text", rootSlug, path] as const,
  fs: {
    all: () => ["fs"] as const,
    /** Every folder listing; searches nest under these. */
    lists: () => ["fs", "list"] as const,
    rootLists: (rootSlug: string) => ["fs", "list", rootSlug] as const,
    list: (rootSlug: string, path: string) => ["fs", "list", rootSlug, path] as const,
    search: (rootSlug: string, path: string, query: string) => ["fs", "list", rootSlug, path, "search", query] as const,
    meta: (rootSlug: string, path: string) => ["fs", "meta", rootSlug, path] as const,
    size: (rootSlug: string, path: string) => ["fs", "size", rootSlug, path] as const,
    sqlite: (rootSlug: string, path: string, mtime: number | undefined) => ["fs", "sqlite", rootSlug, path, mtime] as const,
    sqliteRows: (rootSlug: string, path: string, mtime: number | undefined, table: string | undefined, offset: number, limit: number) =>
      ["fs", "sqlite", rootSlug, path, mtime, table, offset, limit] as const,
    archive: (rootSlug: string, path: string, mtime: number | undefined) => ["fs", "archive", rootSlug, path, mtime] as const,
    exif: (rootSlug: string, path: string) => ["fs", "exif", rootSlug, path] as const,
    bytes: (rootSlug: string, path: string, mtime: number | undefined) => ["fs", "bytes", rootSlug, path, mtime] as const,
    text: (rootSlug: string, path: string | undefined, mtime: number | undefined) => ["fs", "text", rootSlug, path, mtime] as const
  },
  media: {
    info: (rootSlug: string, path: string, mtime: number | undefined) => ["media", "info", rootSlug, path, mtime] as const,
    storyboard: (rootSlug: string, path: string, mtime: number | undefined) => ["media", "storyboard", rootSlug, path, mtime] as const,
    subtitles: (rootSlug: string, path: string, mtime: number | undefined) => ["media", "subtitles", rootSlug, path, mtime] as const
  }
} as const;

/**
 * A folder's own listing, as opposed to a search made in it: the search key is the listing key with two more parts.
 * A prefix match cannot tell them apart, so anything that must reach listings only asks this.
 */
export function isListingKey(key: QueryKey): boolean {
  return key[0] === "fs" && key[1] === "list" && key.length === 4;
}
