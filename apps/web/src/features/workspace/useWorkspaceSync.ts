import { useCallback, useEffect, useRef } from "react";
import { api } from "@/api/client";
import { useSaveWorkspace, useWorkspace } from "@/api/hooks";
import { useWorkspaceStore } from "@/stores/workspace";
import type { WorkspaceState } from "@/types/kago";

/** How long to wait before persisting a change; null means nothing worth saving changed. */
function saveDelay(previous: WorkspaceState, next: WorkspaceState): number | null {
  if (previous.windows === next.windows) {
    if (previous.activeWindowId !== next.activeWindowId) return 300;
    return previous.sidebar === next.sidebar && previous.inspector === next.inspector && previous.shelf === next.shelf ? null : 700;
  }
  if (previous.windows.length !== next.windows.length) return 0;
  const before = new Map(previous.windows.map((window) => [window.id, window]));
  let geometryChanged = false;
  for (const window of next.windows) {
    const old = before.get(window.id);
    if (!old) return 0;
    if (window.logicalPath !== old.logicalPath || window.viewMode !== old.viewMode || window.iconSize !== old.iconSize || window.sortBy !== old.sortBy || window.sortDirection !== old.sortDirection) return 0;
    if (window.x !== old.x || window.y !== old.y || window.width !== old.width || window.height !== old.height) geometryChanged = true;
  }
  if (geometryChanged) return 1000;
  return previous.activeWindowId !== next.activeWindowId ? 300 : 700;
}

/**
 * Restores the user's workspace from the server and saves local changes back with the
 * debounce rules from the product spec. Returns a callback to run when another tab
 * reports a workspace change.
 */
export function useWorkspaceSync() {
  const workspaceQuery = useWorkspace();
  const saveWorkspace = useSaveWorkspace();
  const hydrated = useWorkspaceStore((state) => state.hydrated);
  const save = useRef(saveWorkspace.mutateAsync);
  save.current = saveWorkspace.mutateAsync;
  const hydrating = useRef(false);
  const dirty = useRef(false);
  const lastSynced = useRef("");
  const awaitingRemote = useRef(false);

  useEffect(() => {
    const remote = workspaceQuery.data;
    if (!remote) return;
    const serialized = JSON.stringify(remote);
    if (serialized === lastSynced.current) awaitingRemote.current = false;
    const isRemoteChange = awaitingRemote.current && !dirty.current && serialized !== lastSynced.current;
    if (useWorkspaceStore.getState().hydrated && !isRemoteChange) return;
    awaitingRemote.current = false;
    lastSynced.current = serialized;
    hydrating.current = true;
    useWorkspaceStore.getState().hydrate(remote);
    hydrating.current = false;
  }, [workspaceQuery.data]);

  useEffect(() => {
    if (!hydrated) return;
    let timer: number | undefined;
    let previous = useWorkspaceStore.getState().snapshot();

    const flush = () => {
      window.clearTimeout(timer);
      timer = undefined;
      // Never persist a store that has not been restored yet (e.g. after a dev hot reload
      // swaps in a fresh store); that would overwrite the saved workspace with an empty one.
      if (!useWorkspaceStore.getState().hydrated) return;
      void save
        .current(useWorkspaceStore.getState().snapshot())
        .then((saved) => {
          lastSynced.current = JSON.stringify(saved);
        })
        .catch(() => undefined)
        .finally(() => {
          if (timer === undefined) dirty.current = false;
        });
    };

    const unsubscribe = useWorkspaceStore.subscribe((state) => {
      const next = state.snapshot();
      const delay = hydrating.current ? null : saveDelay(previous, next);
      previous = next;
      if (delay === null) return;
      dirty.current = true;
      window.clearTimeout(timer);
      if (delay === 0) flush();
      else timer = window.setTimeout(flush, delay);
    });

    const flushOnHide = () => {
      if (timer === undefined || !useWorkspaceStore.getState().hydrated) return;
      window.clearTimeout(timer);
      timer = undefined;
      void api("/api/workspace", { method: "PUT", body: JSON.stringify(useWorkspaceStore.getState().snapshot()), keepalive: true }).catch(() => undefined);
    };
    window.addEventListener("pagehide", flushOnHide);

    return () => {
      unsubscribe();
      window.removeEventListener("pagehide", flushOnHide);
      if (timer !== undefined) flush();
    };
  }, [hydrated]);

  const onRemoteChange = useCallback(() => {
    awaitingRemote.current = true;
  }, []);

  return { isLoading: workspaceQuery.isLoading, onRemoteChange };
}
