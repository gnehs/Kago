import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Actor, AuditLog, FileList, FileMeta, FileTask, Root, ShareLink, Shelf, Tag, TrashItem, WorkspaceState } from "../types/kago";

export function useMe() {
  return useQuery({ queryKey: ["auth", "me"], queryFn: () => api<{ user: Actor | null }>("/api/auth/me") });
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
