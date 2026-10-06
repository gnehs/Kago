import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Actor, AuditLog, FileList, FileMeta, FileTask, Group, MediaInfo, PermissionRule, Root, ShareLink, Shelf, Tag, TrashItem, UserAccount, WorkspaceState } from "../types/kago";

export function useSetupStatus() {
  return useQuery({ queryKey: ["auth", "setup"], queryFn: () => api<{ needsSetup: boolean }>("/api/auth/setup") });
}

export function useMe() {
  return useQuery({ queryKey: ["auth", "me"], queryFn: () => api<{ user: Actor | null }>("/api/auth/me") });
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

export function useFileList(rootSlug: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["fs", "list", rootSlug, path],
    queryFn: () => api<FileList>(`/api/fs/list?${new URLSearchParams({ rootSlug, path }).toString()}`),
    enabled
  });
}

export function useFileMeta(rootSlug: string, path: string, enabled = true) {
  return useQuery({
    queryKey: ["fs", "meta", rootSlug, path],
    queryFn: () => api<FileMeta>(`/api/fs/meta?${new URLSearchParams({ rootSlug, path }).toString()}`),
    enabled
  });
}

export function useMediaInfo(rootSlug: string, path: string) {
  return useQuery({
    queryKey: ["media", "info", rootSlug, path],
    queryFn: () => api<MediaInfo>(`/api/media/info?${new URLSearchParams({ rootSlug, path }).toString()}`),
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

export function useShelves() {
  return useQuery({ queryKey: ["shelves"], queryFn: () => api<Shelf[]>("/api/shelves") });
}

export function useTrash(enabled = true) {
  return useQuery({ queryKey: ["trash"], queryFn: () => api<TrashItem[]>("/api/trash"), enabled });
}

export function useAudit(enabled = true) {
  return useQuery({ queryKey: ["audit"], queryFn: () => api<AuditLog[]>("/api/audit"), enabled, refetchInterval: enabled ? 6000 : false });
}
