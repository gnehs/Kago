import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";
import type { Actor, FileList, FileTask, Root, Shelf, WorkspaceState } from "../types/kago";

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

export function useFileList(rootSlug: string, path: string) {
  return useQuery({
    queryKey: ["fs", "list", rootSlug, path],
    queryFn: () => api<FileList>(`/api/fs/list?${new URLSearchParams({ rootSlug, path }).toString()}`)
  });
}

export function useTasks() {
  return useQuery({ queryKey: ["tasks"], queryFn: () => api<FileTask[]>("/api/tasks"), refetchInterval: 4000 });
}

export function useShelves() {
  return useQuery({ queryKey: ["shelves"], queryFn: () => api<Shelf[]>("/api/shelves") });
}
