import { useCallback, useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace";

const store = useWorkspaceStore.getState;
const NOTHING_OPEN: ReadonlySet<string> = new Set();

/** The folders opened in place in the list view, kept for each tab. */
export function useOpenFolders(windowId: string, tabId: string) {
  const [expandedByTab, setExpandedByTab] = useState<Record<string, ReadonlySet<string>>>({});
  const expanded = expandedByTab[tabId] ?? NOTHING_OPEN;
  const setOpen = useCallback(
    (path: string, open: boolean) => {
      setExpandedByTab((all) => {
        const next = new Set(all[tabId] ?? NOTHING_OPEN);
        if (open) next.add(path);
        else next.delete(path);
        return { ...all, [tabId]: next };
      });
      // What a closing folder hides cannot stay selected.
      const selection = store().windows.find((entry) => entry.id === windowId)?.selectedItems ?? [];
      if (!open && selection.some((selected) => selected.startsWith(`${path}/`))) store().selectItems(windowId, selection.filter((selected) => !selected.startsWith(`${path}/`)));
    },
    [windowId, tabId]
  );
  const closeAll = () => setExpandedByTab((all) => ({ ...all, [tabId]: NOTHING_OPEN }));
  return { expanded, setOpen, closeAll };
}

export type OpenFolders = ReturnType<typeof useOpenFolders>;
