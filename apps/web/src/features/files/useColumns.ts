import { useMemo, useRef } from "react";
import { useFileList, type useFolderContents } from "@/api/hooks";
import { parentPath } from "@/lib/paths";
import type { FileItem, FolderWindow } from "@/types/kago";
import type { FileColumn } from "./FileList";
import { sortItems } from "./sortItems";

/** The columns of the column view, and which of them the keyboard moves through. `listed` is what the window's own folder lists. */
export function useColumns(win: FolderWindow, listed: FileItem[], trail: string[], expandedContents: ReturnType<typeof useFolderContents>) {
  const inColumns = win.viewMode === "columns";
  const lastSelected = win.selectedItems.at(-1);
  // The columns down to the folder the selection is in. A folder that is no longer where the selection says ends them.
  const columnsAbove = useMemo(() => {
    if (!inColumns) return null;
    const columns: FileColumn[] = [{ folder: win.logicalPath, items: listed }];
    for (const [index, folder] of trail.entries()) {
      const before = columns.at(-1)!.items;
      if (before && !before.some((item) => item.path === folder && item.kind === "folder")) break;
      const inside = expandedContents[index];
      columns.push({ folder, items: inside?.items && sortItems(inside.items, win.sortBy, win.sortDirection), loading: inside?.loading, failed: inside?.failed });
    }
    return columns;
  }, [inColumns, win.logicalPath, listed, trail, expandedContents, win.sortBy, win.sortDirection]);
  // A folder selected by itself opens one more column, for what it holds.
  const deepest = columnsAbove?.at(-1);
  const opened = columnsAbove && win.selectedItems.length === 1 && columnsAbove.length === trail.length + 1 ? deepest?.items?.find((item) => item.path === lastSelected && item.kind === "folder")?.path : undefined;
  const openedList = useFileList(win.rootSlug, opened ?? win.logicalPath, Boolean(opened));
  const columns = useMemo(
    () =>
      columnsAbove && opened
        ? [...columnsAbove, { folder: opened, items: openedList.data && sortItems(openedList.data.items, win.sortBy, win.sortDirection), loading: !openedList.isError && openedList.data?.partial !== false, failed: openedList.isError }]
        : columnsAbove,
    [columnsAbove, opened, openedList.data, openedList.isError, win.sortBy, win.sortDirection]
  );
  /** The column the selection is in, which is the one the keyboard moves through. */
  const activeColumn = columns && lastSelected ? Math.max(0, columns.findIndex((column) => column.folder === parentPath(lastSelected))) : 0;
  const columnReveal = useRef<Array<((index: number) => void) | undefined>>([]);
  const items = columns ? columns[activeColumn]?.items ?? listed : listed;
  return { columns, activeColumn, opened, columnReveal, items };
}
