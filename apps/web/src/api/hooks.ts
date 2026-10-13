import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, apiLines, ApiError, previewUrl, serverMessage } from "./client";
import { decodeSubtitle } from "../lib/subtitles";
import { withSpeeds } from "../lib/taskSpeed";
import { isTrashing, useTrashingStore } from "../stores/trashing";
import type { Actor, AuditLog, ConvertJob, ConvertRun, ConvertSupport, ExternalApp, FileItem, FileList, FileMeta, FileTask, FolderSize, FrameVerdict, Group, ImageMetadata, LibraryIcon, MediaInfo, PermissionRule, Root, ShareLink, Shelf, SqlitePage, Storyboard, SsoConfig, SsoIdentity, SsoInfo, SqliteTable, StorageInfo, SubtitleList, SyncJob, SyncRun, SyncTrial, TrashItem, UserAccount, WorkspaceState } from "../types/kago";

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

/** The kinds of remote location, the ones set up, whether the server can reach any at all, and what its disk allows in the local ones. Administrators only. */
export function useStorage() {
  return useQuery({ queryKey: ["storage"], queryFn: () => api<StorageInfo>("/api/storage"), retry: false });
}

export function useConvertJobs() {
  // A run changes a job's last result without any event of its own.
  return useQuery({ queryKey: ["convert-jobs"], queryFn: () => api<ConvertJob[]>("/api/convert-jobs"), refetchInterval: 10_000 });
}

/** What the server can convert to. It does not change while the server runs. */
export function useConvertSupport(enabled = true) {
  return useQuery({ queryKey: ["convert-support"], queryFn: () => api<ConvertSupport>("/api/convert/support"), staleTime: Infinity, enabled });
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

/** An auto-convert's last runs, asked for again as `useSyncRuns` does. */
export function useConvertRuns(job: ConvertJob | null, enabled = true) {
  return useQuery({ queryKey: ["convert-runs", job?.id, job?.last_run_at, job?.last_status], queryFn: () => api<ConvertRun[]>(`/api/convert-jobs/${job!.id}/runs`), enabled: enabled && job !== null });
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

type FileListLine = Omit<FileList, "items"> | { items: FileItem[] } | { done: true } | { error: string; code?: string };

/**
 * A folder's listing, read as the server sends it. One opened for the first time fills while it is read, so the
 * first of a very large folder is there long before the last; one already shown stays as it is until its new listing is whole.
 */
function fileListQuery(client: QueryClient, rootSlug: string, path: string) {
  const queryKey = ["fs", "list", rootSlug, path];
  return {
    queryKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<FileList> => {
      const filling = client.getQueryData<FileList>(queryKey)?.partial !== false;
      const items: FileItem[] = [];
      let folder: Omit<FileList, "items"> | undefined;
      let whole = false;
      let shown = 0;
      for await (const line of apiLines<FileListLine>(`/api/fs/list?${new URLSearchParams({ rootSlug, path }).toString()}`, signal)) {
        if ("error" in line) throw new ApiError(serverMessage(line.error), line.code ?? "REQUEST_FAILED", 500);
        if ("done" in line) whole = true;
        else if (!("items" in line)) folder = line;
        else {
          for (const item of line.items) items.push(item);
          // Every showing sorts the folder again, so the more there is, the longer until the next.
          if (filling && folder && performance.now() - shown >= Math.max(250, items.length / 100)) {
            client.setQueryData<FileList>(queryKey, { ...folder, items: [...items], partial: true });
            shown = performance.now();
          }
        }
      }
      // An answer cut short has no last line.
      if (!folder || !whole) throw new ApiError(serverMessage(undefined), "REQUEST_FAILED", 500);
      return { ...folder, items, partial: false };
    }
  };
}

export function useFileList(rootSlug: string, path: string, enabled = true) {
  const select = useWithoutTrashing();
  return useQuery({ ...fileListQuery(useQueryClient(), rootSlug, path), select, enabled });
}

const folderContents = (results: UseQueryResult<FileList>[]) => results.map((result) => result.data?.items);

/** The contents of several folders at once, in the order asked; a folder still loading has none yet. */
export function useFolderContents(rootSlug: string, paths: string[]) {
  const select = useWithoutTrashing();
  const client = useQueryClient();
  return useQueries({
    // Same keys as `useFileList`, so whatever refreshes a folder's window refreshes it here too.
    queries: paths.map((path) => ({ ...fileListQuery(client, rootSlug, path), select })),
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

/** How much a folder holds, which the server reads the whole folder to tell: asked only where it is shown, and given up when that goes away. */
export function useFolderSize(rootSlug: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["fs", "size", rootSlug, path],
    queryFn: ({ signal }) => api<FolderSize>(`/api/fs/size?${new URLSearchParams({ rootSlug, path }).toString()}`, { signal }),
    enabled,
    // Coming back to a folder just measured does not measure it again.
    staleTime: 60_000,
    retry: false
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

/** The pictures for a video's timeline. Asking is what has them made, so it is asked again until they are. */
export function useStoryboard(rootSlug: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["media", "storyboard", rootSlug, path],
    queryFn: () => api<Storyboard>(`/api/media/storyboard?${new URLSearchParams({ rootSlug, path }).toString()}`),
    enabled,
    retry: false,
    staleTime: 60_000,
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 15_000 : false)
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

export function useTasks() {
  return useQuery({ queryKey: ["tasks"], queryFn: async () => withSpeeds(await api<FileTask[]>("/api/tasks")), refetchInterval: 4000 });
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

/** Whether the service at an address lets itself be shown inside Kago. The server asks the service; this only says what it heard. */
export function useFrameProbe(url: string, enabled = true) {
  return useQuery({
    queryKey: ["frame-probe", url],
    queryFn: () => api<{ verdict: FrameVerdict }>("/api/external-apps/probe", { method: "POST", body: JSON.stringify({ url }) }),
    enabled: enabled && /^https?:\/\/[^/]/i.test(url),
    retry: false,
    staleTime: 60_000
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
