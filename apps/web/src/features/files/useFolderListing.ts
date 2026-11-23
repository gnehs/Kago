import { useMemo } from "react";
import { useFolderContents, type useFileList } from "@/api/hooks";
import { isInside, parentPath } from "@/lib/paths";
import type { FileItem, FolderWindow } from "@/types/kago";
import type { FileTree } from "./fileLayout";
import { sortItems } from "./sortItems";
import type { FileSearch } from "./useFileSearch";
import type { OpenFolders } from "./useOpenFolders";

/** What the window's own folder lists: its sorted items, a search's matches, or the folders opened in place in the list view. */
export function useFolderListing(win: FolderWindow, fileList: ReturnType<typeof useFileList>, openFolders: OpenFolders, search: FileSearch) {
  const { searching, found } = search;
  const { expanded } = openFolders;
  const showsTree = win.viewMode === "list" && !searching;
  const inColumns = win.viewMode === "columns";
  const lastSelected = win.selectedItems.at(-1);
  // In the column view the selection says how far in the columns go: every folder between the window's own and the one the selection is in.
  const trail = useMemo(() => {
    const folders: string[] = [];
    if (!inColumns || searching || !lastSelected || !isInside(lastSelected, win.logicalPath)) return folders;
    for (let path = parentPath(lastSelected); path !== win.logicalPath && path !== "/"; path = parentPath(path)) folders.unshift(path);
    return folders;
  }, [inColumns, searching, lastSelected, win.logicalPath]);
  const expandedPaths = useMemo(() => (showsTree ? [...expanded] : trail), [showsTree, expanded, trail]);
  const expandedContents = useFolderContents(win.rootSlug, expandedPaths);
  const allItems = useMemo(() => sortItems(fileList.data?.items ?? [], win.sortBy, win.sortDirection), [fileList.data, win.sortBy, win.sortDirection]);
  // What the window's own folder lists, with the folders opened in place in the list view.
  const { items: listed, depths } = useMemo(() => {
    if (searching) return { items: found, depths: [] };
    if (!showsTree || expandedPaths.length === 0) return { items: allItems, depths: [] };
    // Each open folder is followed by its own contents, sorted like the rest and one level further in.
    const contents = new Map(expandedPaths.map((path, index) => [path, expandedContents[index]?.items]));
    const items: FileItem[] = [];
    const depths: number[] = [];
    const walk = (list: FileItem[], depth: number) => {
      for (const item of list) {
        items.push(item);
        depths.push(depth);
        const inside = item.kind === "folder" ? contents.get(item.path) : undefined;
        if (inside) walk(sortItems(inside, win.sortBy, win.sortDirection), depth + 1);
      }
    };
    walk(allItems, 0);
    return { items, depths };
  }, [allItems, searching, found, showsTree, expandedPaths, expandedContents, win.sortBy, win.sortDirection]);

  const tree = useMemo<FileTree | undefined>(() => (showsTree ? { depths, expanded, setExpanded: openFolders.setOpen } : undefined), [showsTree, depths, expanded, openFolders.setOpen]);

  return { allItems, listed, trail, expandedContents, tree };
}
