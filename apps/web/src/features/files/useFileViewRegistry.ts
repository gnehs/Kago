import { useEffect, type MutableRefObject } from "react";
import { OPEN_ITEM_EVENT } from "@/features/workspace/useShortcuts";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileItem, FolderWindow } from "@/types/kago";
import type { classifyFileWindowError } from "./WindowErrorState";
import { fileViews, revealIndex, type FileLayout, type FileTree } from "./fileLayout";
import type { FileColumn } from "./FileList";

const store = useWorkspaceStore.getState;

type Registry = {
  win: FolderWindow;
  items: FileItem[];
  columns: FileColumn[] | null;
  activeColumn: number;
  /** The folder a column was opened for, in the column view. */
  opened: string | undefined;
  columnReveal: MutableRefObject<Array<((index: number) => void) | undefined>>;
  tree: FileTree | undefined;
  layout: FileLayout;
  scroller: HTMLDivElement | null;
  readonly: boolean;
  error: ReturnType<typeof classifyFileWindowError>;
};

/** Tells the rest of the app what the window lists: its keyboard shortcuts act on it, and so does the open-item event. */
export function useFileViewRegistry({ win, items, columns, activeColumn, opened, columnReveal, tree, layout, scroller, readonly, error }: Registry) {
  // A window that lost access must not keep showing what it had selected.
  useEffect(() => {
    if (error?.kind === "forbidden" && win.selectedItems.length > 0) store().selectItems(win.id, []);
  }, [error?.kind, win.id, win.selectedItems.length]);

  useEffect(() => {
    const onOpenItem = (event: Event) => {
      const detail = (event as CustomEvent<{ windowId: string; path: string }>).detail;
      const item = detail.windowId === win.id ? items.find((entry) => entry.path === detail.path) : undefined;
      if (item) store().openPreview(win.rootSlug, item);
    };
    globalThis.addEventListener(OPEN_ITEM_EVENT, onOpenItem);
    return () => globalThis.removeEventListener(OPEN_ITEM_EVENT, onOpenItem);
  }, [items, win.id, win.rootSlug]);

  // Keyboard shortcuts act on what the window lists, which is more than what is rendered.
  const hasError = Boolean(error);
  useEffect(() => {
    if (hasError) fileViews.set(win.id, { items: [], reveal: () => undefined, folder: win.logicalPath, readonly: true });
    else if (!columns) fileViews.set(win.id, { items, reveal: (index) => scroller && revealIndex(scroller, layout, index), across: layout.columns, tree, folder: win.logicalPath, readonly });
    else {
      const select = (column: number, item: FileItem | undefined) => {
        if (!item) return;
        store().selectItems(win.id, [item.path]);
        columnReveal.current[column]?.(columns[column]!.items!.indexOf(item));
      };
      fileViews.set(win.id, {
        items,
        reveal: (index) => columnReveal.current[activeColumn]?.(index),
        // The folder a column was opened for is the one being looked at; failing that, the one the selection is in.
        folder: opened ?? columns[activeColumn]!.folder,
        readonly,
        columns: {
          // Left steps out to the folder this column was opened from; right steps into the one selected.
          left: () => select(activeColumn - 1, columns[activeColumn - 1]?.items?.find((item) => item.path === columns[activeColumn]!.folder)),
          right: () => opened && select(activeColumn + 1, columns[activeColumn + 1]?.items?.[0])
        }
      });
    }
    return () => void fileViews.delete(win.id);
  }, [win.id, win.logicalPath, items, hasError, readonly, scroller, layout, tree, columns, activeColumn, opened, columnReveal]);
}
