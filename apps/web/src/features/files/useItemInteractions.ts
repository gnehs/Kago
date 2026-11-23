import { useMemo, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileItem, FolderWindow } from "@/types/kago";
import type { FileColumn } from "./FileList";

const store = useWorkspaceStore.getState;

/**
 * What clicking, tapping, holding and right-clicking the items of the window do to its selection and to the menu.
 * `items` is the list the keyboard moves through; `columns` is set in the column view.
 */
export function useItemInteractions(win: FolderWindow, items: FileItem[], columns: FileColumn[] | null, navigate: (logicalPath: string) => void) {
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [menuItem, setMenuItem] = useState<FileItem | null>(null);
  // After a finger has rested on an item, each tap picks an item out or puts it back, until none is left.
  const [picking, setPicking] = useState(false);
  if (picking && win.selectedItems.length === 0) setPicking(false);
  // The folder a right click on empty space was in: in the column view, that of the column clicked.
  const [menuFolder, setMenuFolder] = useState<string | null>(null);

  const selectedItems = useMemo(() => {
    const selected = new Set(win.selectedItems);
    return items.filter((item) => selected.has(item.path));
  }, [items, win.selectedItems]);
  // Right-clicking acts on the whole selection when the clicked item is part of it.
  const menuTargets = menuItem && selectedItems.some((item) => item.path === menuItem.path) ? selectedItems : menuItem ? [menuItem] : [];

  function openItem(item: FileItem, where?: "window" | "tab") {
    if (item.kind === "file") store().openPreview(win.rootSlug, item);
    else if (where === "window") store().openWindow({ rootSlug: win.rootSlug, logicalPath: item.path, title: item.name });
    else if (where === "tab") store().openTab(win.id, { rootSlug: win.rootSlug, logicalPath: item.path });
    else navigate(item.path);
  }

  /** `among` is the list the item was clicked in: the window's, or in the column view that of one column. */
  function selectItem(event: React.MouseEvent, item: FileItem, among = items) {
    const paths = among.map((entry) => entry.path);
    if (event.shiftKey && anchorPath && paths.includes(anchorPath)) {
      const [from, to] = [paths.indexOf(anchorPath), paths.indexOf(item.path)].sort((a, b) => a - b);
      store().selectItems(win.id, paths.slice(from, to! + 1));
      return;
    }
    setAnchorPath(item.path);
    if (event.metaKey || event.ctrlKey) toggleItem(item, among);
    else store().selectItems(win.id, [item.path]);
  }

  function toggleItem(item: FileItem, among: FileItem[]) {
    // A selection never spans two columns: adding to it from another column starts over there.
    const listedHere = new Set(among.map((entry) => entry.path));
    const current = win.selectedItems.filter((path) => listedHere.has(path));
    store().selectItems(win.id, current.includes(item.path) ? current.filter((path) => path !== item.path) : [...current, item.path]);
  }

  /** A tap opens what a double click would, unless items are being picked out. In the column view a folder is selected instead, which lists it in the next column. */
  function tapItem(item: FileItem, among = items) {
    if (picking) {
      setAnchorPath(item.path);
      toggleItem(item, among);
    } else if (columns && item.kind === "folder") {
      setAnchorPath(item.path);
      store().selectItems(win.id, [item.path]);
    } else openItem(item);
  }

  /** Resting a finger on an item picks it out, and the context menu that opens for a long press is for it. */
  function holdItem(item: FileItem, among = items) {
    // A long press is heard twice on Android (the hold and its contextmenu event), and must come to the same.
    const selection = store().windows.find((entry) => entry.id === win.id)?.selectedItems ?? [];
    if (!selection.includes(item.path)) {
      if (picking) toggleItem(item, among);
      else store().selectItems(win.id, [item.path]);
    }
    setPicking(true);
    setAnchorPath(item.path);
    setMenuItem(item);
    setMenuFolder(null);
  }

  function onContextItem(item: FileItem) {
    setMenuItem(item);
    if (!win.selectedItems.includes(item.path)) {
      store().selectItems(win.id, [item.path]);
      setAnchorPath(item.path);
    }
  }

  /**
   * A right click in the file area, before an item hears of it. On empty space the menu is for the folder there: in the
   * column view, the column's. A finger is heard as it lands, since a long press opens the menu without a contextmenu event on iOS.
   */
  function onAreaMenu(event: React.SyntheticEvent) {
    setMenuItem(null);
    setMenuFolder((event.target as Element).closest<HTMLElement>("[data-folder]")?.dataset.folder ?? null);
  }

  return { selectedItems, menuTargets, menuFolder, openItem, selectItem, tapItem, holdItem, onContextItem, onAreaMenu };
}
