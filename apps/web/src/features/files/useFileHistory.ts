import { useCallback, useRef, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FolderWindow } from "@/types/kago";

const store = useWorkspaceStore.getState;

/** A place a window has been: back and forward go between them, across locations too. */
type Place = { rootSlug: string; path: string };

/** The places each tab of the window has been, and the ways to move between them. */
export function useFileHistory(win: FolderWindow, tabId: string) {
  // Every tab has been to places of its own.
  const [histories, setHistories] = useState<Record<string, { stack: Place[]; index: number }>>({});
  const history = histories[tabId] ?? { stack: [], index: -1 };
  const place = history.stack[history.index];
  // Set when back or forward made the move, which scroll restoration reads.
  const viaHistory = useRef(false);

  // Record every change of place (breadcrumb, sidebar, shortcut, double-click) unless it came from back/forward.
  if (place?.rootSlug !== win.rootSlug || place.path !== win.logicalPath) {
    const stack = [...history.stack.slice(0, history.index + 1), { rootSlug: win.rootSlug, path: win.logicalPath }];
    setHistories({ ...histories, [tabId]: { stack, index: stack.length - 1 } });
  }

  const navigate = (logicalPath: string, rootSlug = win.rootSlug) => store().navigate(win.id, { rootSlug, logicalPath });
  const goTo = useCallback((folder: Place) => useWorkspaceStore.getState().navigate(win.id, { rootSlug: folder.rootSlug, logicalPath: folder.path }), [win.id]);

  function go(delta: -1 | 1) {
    const index = history.index + delta;
    const target = history.stack[index];
    if (target === undefined) return;
    setHistories({ ...histories, [tabId]: { ...history, index } });
    viaHistory.current = true;
    navigate(target.path, target.rootSlug);
  }

  return { canGoBack: history.index > 0, canGoForward: history.index < history.stack.length - 1, go, navigate, goTo, viaHistory };
}
