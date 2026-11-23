import { useState } from "react";
import { parentPath } from "@/lib/paths";
import { droppedTree } from "@/lib/uploadTree";
import type { FolderWindow } from "@/types/kago";
import type { classifyFileWindowError } from "./WindowErrorState";
import { placeable, readDraggedFiles, type FileActions, type FileRef } from "./useFileActions";

export type DropChoice = { sources: FileRef[]; destination: FileRef; x: number; y: number };

/**
 * What is being held over the window, and what letting go does. `scroller` is the file area, which gets the keyboard back
 * when the choice of copy or move is closed.
 */
export function useFileDrop(win: FolderWindow, readonly: boolean, error: ReturnType<typeof classifyFileWindowError>, actions: FileActions, scroller: HTMLDivElement | null) {
  // What is being held over the window: files from outside the browser, which would be uploaded, or items of Kago's own.
  const [dropActive, setDropActive] = useState<false | "files" | "items">(false);
  const [dropChoice, setDropChoice] = useState<DropChoice | null>(null);

  /**
   * Handles a drop on the window (its current folder), on one of the folders listed in it, or on a folder in the
   * sidebar. Only the sidebar names a location: its folders may be anywhere, and whether one can be written to is
   * for the server to say, not for the folder this window happens to show.
   */
  function dropInto(event: React.DragEvent, path: string, rootSlug?: string) {
    event.preventDefault();
    setDropActive(false);
    if (rootSlug === undefined && (readonly || error)) return;
    const destination = { rootSlug: rootSlug ?? win.rootSlug, path };
    const dropped = droppedTree(event.dataTransfer);
    if (dropped) {
      void actions.upload(dropped, destination.path, destination.rootSlug);
      return;
    }
    // Dropping items onto the folder they already live in is a no-op, and no folder goes into itself or one inside it.
    const sources = placeable(
      readDraggedFiles(event.dataTransfer).filter((source) => source.rootSlug !== destination.rootSlug || parentPath(source.path) !== path),
      destination
    );
    const rect = event.currentTarget.closest("[data-window]")?.getBoundingClientRect();
    if (sources.length === 0 || !rect) return;
    setDropChoice({ sources, destination, x: Math.min(event.clientX - rect.left, rect.width - 180), y: Math.min(event.clientY - rect.top, rect.height - 130) });
  }

  /** Gives the keyboard back to the list: in the column view, to the column the selection is in. */
  function focusList() {
    const list = scroller?.querySelector("[aria-selected=true]")?.closest<HTMLElement>("[role=listbox]") ?? scroller?.querySelector<HTMLElement>("[role=listbox]");
    list?.focus({ preventScroll: true });
  }

  function closeDropChoice() {
    setDropChoice(null);
    focusList();
  }

  return { dropActive, setDropActive, dropChoice, dropInto, closeDropChoice };
}
