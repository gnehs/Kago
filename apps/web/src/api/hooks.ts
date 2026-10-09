import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, previewUrl } from "./client";
import { decodeSubtitle } from "../lib/subtitles";
import { isTrashing, useTrashingStore } from "../stores/trashing";
import type { Actor, AuditLog, ExternalApp, FileItem, FileList, FileMeta, FileTask, Group, ImageMetadata, LibraryIcon, MediaInfo, PermissionRule, Root, ShareLink, Shelf, SqlitePage, SsoConfig, SsoIdentity, SsoInfo, SqliteTable, StorageInfo, SubtitleList, SyncJob, SyncRun, SyncTrial, Tag, TrashItem, UserAccount, WorkspaceState } from "../types/kago";

export function useSetupStatus() {
  return useQuery({ queryKey: ["auth", "setup"], queryFn: () => api<{ needsSetup: boolean; oidc: SsoInfo | null }>("/api/auth/setup") });
}

export function useMe() {
  return useQuery({ queryKey: ["auth", "me"], queryFn: () => api<{ user: Actor | null }>("/api/auth/me") });
}

/** The identities linked to the account signed in, and whether it can also sign in with a password. */
export function useIdentities() {
  return useQuery({ queryKey: ["auth", "identities"], queryFn: () => api<{ sso: SsoInfo | null; hasPassword: boolean; identities: SsoIdentity[] }>("/api/auth/identities") });
}

export function useSsoConfig() {
  return useQuery({ queryKey: ["sso"], queryFn: () => api<SsoConfig>("/api/sso"), retry: false });
}

export function useUsers() {
  return useQuery({ queryKey: ["users"], queryFn: () => api<UserAccount[]>("/api/users"), retry: false });
}

export function useAdminContacts(enabled = true) {
  return useQuery({ queryKey: ["admins"], queryFn: () => api<Array<{ displayName: string; email: string }>>("/api/admins"), enabled });
}

export function useGroups() {
  return useQuery({ queryKey: ["groups"], queryFn: () => api<Group[]>("/api/groups"), retry: false });
}

export function useRoots() {
  return useQuery({ queryKey: ["roots"], queryFn: () => api<Root[]>("/api/roots") });
}

/** The kinds of remote location, the ones set up, and whether the server can reach any at all. Administrators only. */
export function useStorage() {
  return useQuery({ queryKey: ["storage"], queryFn: () => api<StorageInfo>("/api/storage"), retry: false });
}

export function useSyncJobs() {
  // A run changes a job's last result without any event of its own.
  return useQuery({ queryKey: ["sync-jobs"], queryFn: () => api<SyncJob[]>("/api/sync-jobs"), refetchInterval: 10_000 });
}

/** What a job's last trial run would have changed; asked for again whenever that run is another one. What was fetched stays while `enabled` is off. */
export function useSyncTrial(job: SyncJob | null, enabled = true) {
  return useQuery({ queryKey: ["sync-trial", job?.id, job?.last_run_at], queryFn: () => api<SyncTrial>(`/api/sync-jobs/${job!.id}/trial`), enabled: enabled && job !== null });
}

/** A job's last runs, asked for again when another one starts and while one is still going. What was fetched stays while `enabled` is off. */
export function useSyncRuns(job: SyncJob | null, enabled = true) {
  return useQuery({ queryKey: ["sync-runs", job?.id, job?.last_run_at, job?.last_status], queryFn: () => api<SyncRun[]>(`/api/sync-jobs/${job!.id}/runs`), enabled: enabled && job !== null });
}

export function useSshKey(enabled = true) {
  return useQuery({ queryKey: ["ssh-key"], queryFn: () => api<{ publicKey: string }>("/api/storage/ssh-key"), enabled, retry: false, staleTime: Infinity });
}

export function useWorkspace() {
  return useQuery({ queryKey: ["workspace"], queryFn: () => api<WorkspaceState>("/api/workspace") });
}

export function useSaveWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (workspace: WorkspaceState) => api<WorkspaceState>("/api/workspace", { method: "PUT", body: JSON.stringify(workspace) }),
    onSuccess: (workspace) => queryClient.setQueryData(["workspace"], workspace)
  });
}

/** A listing without the items already on their way to the Trash. */
function useWithoutTrashing() {
  const trashing = useTrashingStore((state) => state.tasks);
  return (list: FileList): FileList =>
    Object.keys(trashing).length === 0 ? list : { ...list, items: list.items.filter((item) => !isTrashing(trashing, list.rootSlug, item.path)) };
}

export function useFileList(rootSlug: string, path: string, enabled = true) {
  const select = useWithoutTrashing();
  return useQuery({
    queryKey: ["fs", "list", rootSlug, path],
    queryFn: () => api<FileList>(`/api/fs/list?${new URLSearchParams({ rootSlug, path }).toString()}`),
    select,
    enabled
  });
}

const folderContents = (results: UseQueryResult<FileList>[]) => results.map((result) => result.data?.items);

/** The contents of several folders at once, in the order asked; a folder still loading has none yet. */
export function useFolderContents(rootSlug: string, paths: string[]) {
  const select = useWithoutTrashing();
  return useQueries({
    // Same keys as `useFileList`, so whatever refreshes a folder's window refreshes it here too.
    queries: paths.map((path) => ({
      queryKey: ["fs", "list", rootSlug, path],
      queryFn: () => api<FileList>(`/api/fs/list?${new URLSearchParams({ rootSlug, path }).toString()}`),
      select
    })),
    combine: folderContents
  });
}

export function useFileMeta(rootSlug: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["fs", "meta", rootSlug, path],
    queryFn: () => api<FileMeta>(`/api/fs/meta?${new URLSearchParams({ rootSlug, path }).toString()}`),
    enabled
  });
}

export function useSqliteOverview(rootSlug: string, path: string) {
  return useQuery({
    queryKey: ["fs", "sqlite", rootSlug, path],
    queryFn: () => api<{ tables: SqliteTable[] }>(`/api/fs/sqlite?${new URLSearchParams({ rootSlug, path }).toString()}`),
    retry: false
  });
}

export function useSqliteRows(rootSlug: string, path: string, table: string | undefined, offset: number, limit: number) {
  return useQuery({
    queryKey: ["fs", "sqlite", rootSlug, path, table, offset, limit],
    queryFn: () => api<SqlitePage>(`/api/fs/sqlite/rows?${new URLSearchParams({ rootSlug, path, table: table!, offset: String(offset), limit: String(limit) }).toString()}`),
    enabled: table !== undefined,
    retry: false,
    // Turning the page keeps the rows on screen until the next ones arrive.
    placeholderData: keepPreviousData
  });
}

export function useImageMetadata(rootSlug: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["fs", "exif", rootSlug, path],
    queryFn: () => api<ImageMetadata>(`/api/fs/exif?${new URLSearchParams({ rootSlug, path }).toString()}`),
    enabled,
    retry: false,
    staleTime: 60_000
  });
}

export function useMediaInfo(rootSlug: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["media", "info", rootSlug, path],
    queryFn: () => api<MediaInfo>(`/api/media/info?${new URLSearchParams({ rootSlug, path }).toString()}`),
    enabled,
    retry: false,
    staleTime: 60_000
  });
}

/** How many files are asked about at once when a whole album is. */
const INFO_WINDOW = 4;
const mediaInfos = (results: UseQueryResult<MediaInfo>[]) => ({ data: results.map((result) => result.data), settled: results.filter((result) => !result.isPending).length });

/**
 * What is known about each of several files, in the order asked. They are read a few at a time, in order,
 * so opening one song of a large folder does not set the server probing all of it at once.
 */
export function useMediaInfos(rootSlug: string, paths: string[]) {
  const [reach, setReach] = useState(INFO_WINDOW);
  const { data, settled } = useQueries({
    // Same keys as `useMediaInfo`, so a file asked about either way is asked about once.
    queries: paths.map((path, index) => ({
      queryKey: ["media", "info", rootSlug, path],
      queryFn: () => api<MediaInfo>(`/api/media/info?${new URLSearchParams({ rootSlug, path }).toString()}`),
      enabled: index < reach,
      retry: false,
      staleTime: 60_000
    })),
    combine: mediaInfos
  });
  useEffect(() => {
    if (settled + INFO_WINDOW > reach && reach < paths.length) setReach(settled + INFO_WINDOW);
  }, [settled, reach, paths.length]);
  return data;
}

export function useSubtitles(rootSlug: string, path: string) {
  return useQuery({
    queryKey: ["media", "subtitles", rootSlug, path],
    queryFn: () => api<SubtitleList>(`/api/media/subtitles?${new URLSearchParams({ rootSlug, path }).toString()}`),
    retry: false,
    staleTime: 60_000
  });
}

const MAX_SIDECAR_BYTES = 1024 * 1024;

/** A small text file that goes with a piece of media (a cue sheet, lyrics), read in whatever code page it was saved in. */
export function useTextFile(rootSlug: string, file: Pick<FileItem, "path" | "mtime" | "size"> | undefined) {
  // It is read whole, into memory. Something far larger than any cue sheet or lyrics is not one, whatever its name says.
  const item = file && file.size <= MAX_SIDECAR_BYTES ? file : undefined;
  return useQuery({
    queryKey: ["fs", "text", rootSlug, item?.path, item?.mtime],
    queryFn: async () => {
      const response = await fetch(previewUrl(rootSlug, item!.path), { credentials: "include" });
      if (!response.ok) throw new Error(`Request failed: ${response.status}`);
      return decodeSubtitle(await response.arrayBuffer(), "");
    },
    enabled: item !== undefined,
    retry: false,
    staleTime: 60_000
  });
}

export function useFileTags(rootSlug: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["tags", "file", rootSlug, path],
    queryFn: () => api<Tag[]>(`/api/tags/file?${new URLSearchParams({ rootSlug, path }).toString()}`),
    enabled
  });
}

export function useShares() {
  return useQuery({ queryKey: ["shares"], queryFn: () => api<ShareLink[]>("/api/shares") });
}

export function usePermissions(rootId?: string, enabled = true) {
  return useQuery({
    queryKey: ["permissions", rootId ?? "all"],
    queryFn: () => api<PermissionRule[]>(`/api/permissions${rootId ? `?${new URLSearchParams({ rootId }).toString()}` : ""}`),
    enabled
  });
}

export function usePathPermissions(rootSlug: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["permissions", "path", rootSlug, path],
    queryFn: () => api<PermissionRule[]>(`/api/permissions?${new URLSearchParams({ rootSlug, path }).toString()}`),
    enabled
  });
}

export function useTasks() {
  return useQuery({ queryKey: ["tasks"], queryFn: () => api<FileTask[]>("/api/tasks"), refetchInterval: 4000 });
}

export function useExternalApps() {
  return useQuery({ queryKey: ["external-apps"], queryFn: () => api<ExternalApp[]>("/api/external-apps") });
}

/** The library icons that answer to a name. `available` is false when the server could reach no library. */
export function useIconSuggestions(name: string) {
  return useQuery({
    queryKey: ["app-icons", name],
    queryFn: () => api<{ available: boolean; items: LibraryIcon[] }>(`/api/app-icons?${new URLSearchParams({ q: name }).toString()}`),
    enabled: name.length > 0,
    retry: false,
    staleTime: 5 * 60_000,
    // The suggestions for what was typed so far stay while the next ones are looked up.
    placeholderData: keepPreviousData
  });
}

export function useShelves() {
  return useQuery({ queryKey: ["shelves"], queryFn: () => api<Shelf[]>("/api/shelves") });
}

export function useTrash(enabled = true) {
  return useQuery({ queryKey: ["trash"], queryFn: () => api<TrashItem[]>("/api/trash"), enabled });
}

export function useAudit(enabled = true) {
  return useQuery({ queryKey: ["audit"], queryFn: () => api<AuditLog[]>("/api/audit"), enabled, refetchInterval: enabled ? 6000 : false });
}
