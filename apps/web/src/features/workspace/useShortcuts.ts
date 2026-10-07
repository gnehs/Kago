import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fileViews } from "@/features/files/fileLayout";
import { pasteClipboard, setClipboard } from "@/features/files/useFileActions";
import { baseName, parentPath } from "@/lib/paths";
import { isEditableTarget } from "@/lib/usePointerDrag";
import { useClipboardStore } from "@/stores/clipboard";
import { requestCloseWindow, useWorkspaceStore } from "@/stores/workspace";

export const EDIT_ADDRESS_EVENT = "kago:edit-address";
export const OPEN_ITEM_EVENT = "kago:open-item";

/** Keyboard shortcuts. Everything except the palette acts on the active window only. */
export function useShortcuts({ enabled, onOpenPalette }: { enabled: boolean; onOpenPalette: () => void }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled) return;

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
      const previewActive = store.previewWindows.some((window) => window.id === store.activeWindowId && !window.minimized);
      // Escape dismisses a preview the way it used to dismiss the preview dialog.
      if ((closes || (previewActive && event.key === "Escape")) && [...store.appWindows, ...store.previewWindows].some((window) => window.id === store.activeWindowId)) {
        event.preventDefault();
        void requestCloseWindow(store.activeWindowId!);
        return;
      }
      const active = store.windows.find((window) => window.id === store.activeWindowId && !window.minimized);
      if (!active) return;
      const view = fileViews.get(active.id);
      const items = view?.items ?? [];

      if (closes) {
        event.preventDefault();
        // With several tabs open, closing takes them one at a time, as a browser does.
        if ((active.tabs?.length ?? 0) > 1 && active.activeTabId) store.closeTab(active.id, active.activeTabId);
        else void requestCloseWindow(active.id);
      } else if (altKey === "KeyT") {
        event.preventDefault();
        store.openTab(active.id, active);
      } else if (opensNew) {
        event.preventDefault();
        store.openWindow({ rootSlug: active.rootSlug, logicalPath: active.logicalPath, title: active.title });
      } else if (mod && key === "r") {
        event.preventDefault();
        void queryClient.invalidateQueries({ queryKey: ["fs", "list", active.rootSlug, active.logicalPath] });
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
        setClipboard(key === "c" ? "copy" : "cut", active.selectedItems.map((path) => ({ rootSlug: active.rootSlug, path })));
      } else if (mod && key === "v") {
        if (!useClipboardStore.getState().clip) return;
        event.preventDefault();
        void pasteClipboard(queryClient, { rootSlug: active.rootSlug, path: active.logicalPath });
      } else if (event.key === "Backspace" && active.logicalPath !== "/") {
        event.preventDefault();
        store.updateWindow(active.id, { logicalPath: parentPath(active.logicalPath), selectedItems: [] });
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
      } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        if (items.length === 0) return;
        event.preventDefault();
        const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
        const selectedPath = active.selectedItems.at(-1);
        const current = selectedPath === undefined ? -1 : items.findIndex((item) => item.path === selectedPath);
        const nextIndex = current === -1 ? (forward ? 0 : items.length - 1) : Math.min(items.length - 1, Math.max(0, current + (forward ? 1 : -1)));
        store.selectItems(active.id, [items[nextIndex]!.path]);
        view?.reveal(nextIndex);
      } else if (event.key === "Enter") {
        const selectedPath = active.selectedItems[0];
        const item = items.find((entry) => entry.path === selectedPath);
        if (!selectedPath || !item) return;
        event.preventDefault();
        if (item.kind !== "folder") window.dispatchEvent(new CustomEvent(OPEN_ITEM_EVENT, { detail: { windowId: active.id, path: selectedPath } }));
        else if (mod) store.openWindow({ rootSlug: active.rootSlug, logicalPath: selectedPath, title: baseName(selectedPath) });
        else store.updateWindow(active.id, { logicalPath: selectedPath, selectedItems: [] });
      } else if (event.key === "Escape") {
        store.selectItems(active.id, []);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, onOpenPalette, queryClient]);
}
