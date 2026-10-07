import { useEffect, useMemo } from "react";
import { isPicture, isVideoType } from "@/lib/format";
import { parentPath } from "@/lib/paths";
import { folderKey, setFolderView, useSettingsStore } from "@/stores/settings";
import type { AccountSettings, FileItem, FolderView, FolderViewEntry } from "@/types/kago";

/** How a folder is shown when nothing at all has been said about it. */
export const BASE_VIEW: FolderView = { viewMode: "list", iconSize: "medium", sortBy: "name", sortDirection: "asc" };

/** How much of a folder has to be pictures and videos before it opens as icons on its own. */
const MEDIA_SHARE = 0.7;

export type ResolvedView = {
  view: FolderView;
  /** What is set for the folder itself, if anything. */
  own?: FolderViewEntry;
  /** Where the view mode comes from: the folder, a folder above it, what it holds, or the default. */
  source: "folder" | "parent" | "auto" | "default";
  /** The folder above that the view mode follows. */
  parent?: string;
  /** True when the view mode is a suggestion made just now, which nothing has kept yet. */
  suggested: boolean;
};

/** Icons for a folder that is mostly pictures and videos; no opinion about any other. */
export function suggestViewMode(items: FileItem[]): FolderView["viewMode"] | undefined {
  const media = items.filter((item) => isPicture(item) || (item.kind === "file" && isVideoType(item.type))).length;
  return items.length > 0 && media / items.length > MEDIA_SHARE ? "grid" : undefined;
}

/**
 * The view of a folder, each part taken from the nearest place that names it: the folder itself, the closest
 * folder above that passes its view down, what the folder holds, and last the default. The window showing the
 * folder has no say, so a folder looks the same from wherever it is reached.
 */
export function resolveFolderView(settings: AccountSettings, folderViews: Record<string, FolderViewEntry>, rootSlug: string, path: string, suggestion?: FolderView["viewMode"]): ResolvedView {
  const own = folderViews[folderKey(rootSlug, path)];
  const above: FolderViewEntry[] = [];
  for (let current = path; current !== "/"; ) {
    current = parentPath(current);
    const entry = folderViews[folderKey(rootSlug, current)];
    if (entry?.recursive) above.push(entry);
  }
  const fallback = { ...BASE_VIEW, ...settings.defaultView };
  const modeAbove = above.find((entry) => entry.viewMode);
  const sortAbove = above.find((entry) => entry.sortBy);
  const smart = settings.smartView === false ? undefined : own?.autoMode ?? suggestion;
  const sorted = own?.sortBy ? own : sortAbove;
  return {
    view: {
      viewMode: own?.viewMode ?? modeAbove?.viewMode ?? smart ?? fallback.viewMode,
      iconSize: own?.iconSize ?? above.find((entry) => entry.iconSize)?.iconSize ?? fallback.iconSize,
      sortBy: sorted?.sortBy ?? fallback.sortBy,
      sortDirection: sorted ? sorted.sortDirection ?? "asc" : fallback.sortDirection
    },
    own,
    source: own?.viewMode ? "folder" : modeAbove ? "parent" : smart ? "auto" : "default",
    parent: own?.viewMode ? undefined : modeAbove?.path,
    suggested: !own?.viewMode && !modeAbove && Boolean(smart) && !own?.autoMode
  };
}

/** The view of the folder a window is showing. `items` is what the folder holds, once that is known. */
export function useFolderView(rootSlug: string, path: string, items: FileItem[] | undefined): ResolvedView {
  const settings = useSettingsStore((state) => state.settings);
  const folderViews = useSettingsStore((state) => state.folderViews);
  const suggestion = useMemo(() => (items ? suggestViewMode(items) : undefined), [items]);
  const resolved = useMemo(() => resolveFolderView(settings, folderViews, rootSlug, path, suggestion), [settings, folderViews, rootSlug, path, suggestion]);

  // A suggestion is kept the first time it is made, so the folder does not change its view as files come and go.
  const { suggested, view } = resolved;
  useEffect(() => {
    if (suggested) void setFolderView(rootSlug, path, { autoMode: view.viewMode });
  }, [suggested, rootSlug, path, view.viewMode]);

  return resolved;
}
