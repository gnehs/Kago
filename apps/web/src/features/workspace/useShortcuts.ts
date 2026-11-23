import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@/api/keys";
import { fileViews } from "@/features/files/fileLayout";
import { pasteClipboard, renameFile, setClipboard, trashFiles } from "@/features/files/useFileActions";
import { nfc, parentPath } from "@/lib/paths";
import { isEditableTarget } from "@/lib/usePointerDrag";
import { useClipboardStore } from "@/stores/clipboard";
import { activeFileWindow, activeWindowId, requestCloseWindow, useWorkspaceStore } from "@/stores/workspace";

export const EDIT_ADDRESS_EVENT = "kago:edit-address";
export const OPEN_ITEM_EVENT = "kago:open-item";
/** Asks a file window, by id, to put the caret in its search field. */
export const FOCUS_SEARCH_EVENT = "kago:focus-search";

/** How long a pause ends a run of typed letters, so the next one starts a new name. */
const TYPE_AHEAD_MS = 700;
/** Where a Shift-selection started, by window. The selection's last path is the end that moves. */
const anchors = new Map<string, string>();

/** Keyboard shortcuts. Everything except the palette acts on the active window only. */
export function useShortcuts({ enabled, onOpenPalette }: { enabled: boolean; onOpenPalette: () => void }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;
    let typed = "";
    let typedAt = 0;

    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      // Browsers keep ⌘W and ⌘N for themselves in a normal tab, so Alt+W and Alt+N do the same job.
      // Alt changes the typed character on macOS, hence the physical key.
      const altKey = event.altKey && !mod ? event.code : "";
      const closes = altKey === "KeyW" || (mod && event.key.toLowerCase() === "w");
      const opensNew = altKey === "KeyN" || (mod && event.key.toLowerCase() === "n");
      const key = event.key.toLowerCase();

      if (mod && (key === "p" || key === "k")) {
        event.preventDefault();
        onOpenPalette();
        return;
      }

      // Dialogs and menus own the keyboard while they are open.
      if (document.querySelector("[role=dialog], [role=menu]")) return;
      if (isEditableTarget(event.target)) return;

      const store = useWorkspaceStore.getState();
      const focused = activeWindowId(store);
      const previewActive = store.previewWindows.some((window) => window.id === focused);
      // Escape dismisses a preview the way it used to dismiss the preview dialog.
      if ((closes || (previewActive && event.key === "Escape")) && [...store.appWindows, ...store.previewWindows].some((window) => window.id === focused)) {
        event.preventDefault();
        void requestCloseWindow(focused!);
        return;
      }
      const active = activeFileWindow(store);
      if (!active) return;
      const view = fileViews.get(active.id);
      const items = view?.items ?? [];

      if (closes) {
        event.preventDefault();
        // With several tabs open, closing takes them one at a time, as a browser does.
        if (active.tabs.length > 1) store.closeTab(active.id, active.activeTabId);
        else void requestCloseWindow(active.id);
      } else if (altKey === "KeyT") {
        event.preventDefault();
        store.openTab(active.id, active);
      } else if (opensNew) {
        event.preventDefault();
        store.openWindow(active);
      } else if (mod && key === "r") {
        event.preventDefault();
        void queryClient.invalidateQueries({ queryKey: keys.fs.list(active.rootSlug, active.logicalPath) });
      } else if (mod && key === "l") {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent(EDIT_ADDRESS_EVENT, { detail: active.id }));
      } else if (mod && key === "i") {
        event.preventDefault();
        store.updateWindow(active.id, { inspectorOpen: !active.inspectorOpen });
      } else if (mod && key === "a") {
        event.preventDefault();
        store.selectItems(active.id, items.map((item) => item.path));
      } else if (mod && (key === "c" || key === "x")) {
        // Leave the shortcut to the browser when there is text selected or no file to pick up.
        if (active.selectedItems.length === 0 || globalThis.getSelection()?.toString()) return;
        event.preventDefault();
        // What can't be taken out of its folder can't be cut, as the menu says by leaving Cut disabled.
        if (key === "x" && (view?.readonly || items.some((item) => item.readonly && active.selectedItems.includes(item.path)))) return;
        setClipboard(key === "c" ? "copy" : "cut", active.selectedItems.map((path) => ({ rootSlug: active.rootSlug, path })));
      } else if (mod && key === "v") {
        if (!useClipboardStore.getState().clip || !view || view.readonly) return;
        event.preventDefault();
        void pasteClipboard(queryClient, { rootSlug: active.rootSlug, path: view.folder }, active.id);
      } else if ((mod && key === "f") || (!mod && !event.altKey && event.key === "/")) {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent(FOCUS_SEARCH_EVENT, { detail: active.id }));
      } else if (event.key === "F2") {
        const item = active.selectedItems.length === 1 ? items.find((entry) => entry.path === active.selectedItems[0]) : undefined;
        if (!item || view?.readonly || item.readonly) return;
        event.preventDefault();
        void renameFile(queryClient, { rootSlug: active.rootSlug, path: item.path, name: item.name, kind: item.kind }, () => store.selectItems(active.id, []), active.id);
      } else if (event.key === "Delete" || (mod && event.key === "Backspace")) {
        if (active.selectedItems.length === 0 || view?.readonly || items.some((item) => item.readonly && active.selectedItems.includes(item.path))) return;
        event.preventDefault();
        const picked = active.selectedItems.map((path) => ({ rootSlug: active.rootSlug, path }));
        void trashFiles(queryClient, picked, active.id).then((task) => task && store.selectItems(active.id, []));
      } else if (event.key === "Backspace" && active.logicalPath !== "/") {
        event.preventDefault();
        store.navigate(active.id, { rootSlug: active.rootSlug, logicalPath: parentPath(active.logicalPath) });
      } else if (view?.columns && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        event.preventDefault();
        view.columns[event.key === "ArrowLeft" ? "left" : "right"]();
      } else if (view?.tree && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
        // In a tree, right opens the selected folder and left closes it, or steps out to the folder it is in.
        const item = items.find((entry) => entry.path === active.selectedItems.at(-1));
        if (!item) return;
        event.preventDefault();
        const open = event.key === "ArrowRight";
        if (item.kind === "folder" && view.tree.expanded.has(item.path) !== open) {
          view.tree.setExpanded(item.path, open);
        } else if (!open) {
          const parent = items.findIndex((entry) => entry.path === parentPath(item.path));
          if (parent === -1) return;
          store.selectItems(active.id, [items[parent]!.path]);
          view.reveal(parent);
        }
      } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        if (items.length === 0) return;
        event.preventDefault();
        const selectedPath = active.selectedItems.at(-1);
        const current = selectedPath === undefined ? -1 : items.findIndex((item) => item.path === selectedPath);
        const last = items.length - 1;
        let nextIndex: number;
        if (event.key === "Home" || event.key === "End") {
          nextIndex = event.key === "Home" ? 0 : last;
        } else {
          const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
          // Up and down step a whole row of icons; in a list a row holds one.
          const across = event.key === "ArrowDown" || event.key === "ArrowUp" ? (view?.across ?? 1) : 1;
          nextIndex = current === -1 ? (forward ? 0 : last) : current + (forward ? across : -across);
          // Below a row that is longer than the last one, down lands on the last item; off either end, the selection stays.
          if (nextIndex > last) nextIndex = Math.floor(last / across) > Math.floor(current / across) ? last : current;
          if (nextIndex < 0) nextIndex = current;
        }
        if (event.shiftKey && current !== -1) {
          const anchorPath = active.selectedItems.includes(anchors.get(active.id) ?? "") ? anchors.get(active.id)! : active.selectedItems[0]!;
          anchors.set(active.id, anchorPath);
          const anchor = items.findIndex((item) => item.path === anchorPath);
          if (anchor !== -1) {
            // The cursor comes last, so the next step knows which end of the range moves.
            const step = nextIndex >= anchor ? 1 : -1;
            const range: string[] = [];
            for (let index = anchor; index !== nextIndex + step; index += step) range.push(items[index]!.path);
            store.selectItems(active.id, range);
            view?.reveal(nextIndex);
            return;
          }
        }
        anchors.set(active.id, items[nextIndex]!.path);
        store.selectItems(active.id, [items[nextIndex]!.path]);
        view?.reveal(nextIndex);
      } else if (event.key === "Enter") {
        const selectedPath = active.selectedItems.at(-1);
        const item = items.find((entry) => entry.path === selectedPath);
        if (!selectedPath || !item) return;
        event.preventDefault();
        if (item.kind !== "folder") window.dispatchEvent(new CustomEvent(OPEN_ITEM_EVENT, { detail: { windowId: active.id, path: selectedPath } }));
        else if (mod) store.openWindow({ rootSlug: active.rootSlug, logicalPath: selectedPath });
        else store.navigate(active.id, { rootSlug: active.rootSlug, logicalPath: selectedPath });
      } else if (event.key === "Escape") {
        store.selectItems(active.id, []);
      } else if (!mod && !event.altKey && event.key.length === 1 && (event.key !== " " || typed)) {
        // Typing a name picks the first item that starts with it, as a file manager does.
        const now = Date.now();
        typed = (now - typedAt > TYPE_AHEAD_MS ? "" : typed) + nfc(event.key).toLowerCase();
        typedAt = now;
        const index = items.findIndex((item) => nfc(item.name).toLowerCase().startsWith(typed));
        if (index === -1) return;
        event.preventDefault();
        anchors.set(active.id, items[index]!.path);
        store.selectItems(active.id, [items[index]!.path]);
        view?.reveal(index);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onOpenPalette, queryClient]);
}
