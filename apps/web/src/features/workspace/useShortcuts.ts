import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { pasteClipboard, setClipboard } from "@/features/files/useFileActions";
import { baseName, parentPath } from "@/lib/paths";
import { isEditableTarget } from "@/lib/usePointerDrag";
import { useClipboardStore } from "@/stores/clipboard";
import { useWorkspaceStore } from "@/stores/workspace";

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
        store.closeWindow(store.activeWindowId!);
        return;
      }
      const active = store.windows.find((window) => window.id === store.activeWindowId && !window.minimized);
      if (!active) return;
      const rows = () => Array.from(document.querySelectorAll<HTMLElement>(`[data-window="${active.id}"] [data-file-path]`));

      if (closes) {
        event.preventDefault();
        store.closeWindow(active.id);
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
        store.selectItems(active.id, rows().map((row) => row.dataset.filePath!).filter(Boolean));
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
      } else if (["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(event.key)) {
        const list = rows();
        if (list.length === 0) return;
        event.preventDefault();
        const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
        const current = list.findIndex((row) => row.dataset.filePath === active.selectedItems.at(-1));
        const nextIndex = current === -1 ? (forward ? 0 : list.length - 1) : Math.min(list.length - 1, Math.max(0, current + (forward ? 1 : -1)));
        const next = list[nextIndex];
        if (!next?.dataset.filePath) return;
        store.selectItems(active.id, [next.dataset.filePath]);
        next.scrollIntoView({ block: "nearest" });
      } else if (event.key === "Enter") {
        const selectedPath = active.selectedItems[0];
        const row = rows().find((item) => item.dataset.filePath === selectedPath);
        if (!selectedPath || !row) return;
        event.preventDefault();
        if (row.dataset.fileKind !== "folder") window.dispatchEvent(new CustomEvent(OPEN_ITEM_EVENT, { detail: { windowId: active.id, path: selectedPath } }));
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
