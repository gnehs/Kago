import { useEffect, useMemo, useRef, useState } from "react";
import { useFolderSearch } from "@/api/hooks";
import { nfc } from "@/lib/paths";
import type { FolderWindow } from "@/types/kago";
import { sortItems } from "./sortItems";

/** What is typed in the search field of the window's tab, and what searching the folder below has found so far. */
export function useFileSearch(win: FolderWindow, tabId: string) {
  // Every tab keeps what was typed in its search field.
  const [searches, setSearches] = useState<Record<string, string>>({});
  const search = searches[tabId] ?? "";
  const setSearch = (value: string) => setSearches((all) => ({ ...all, [tabId]: value }));
  const reset = () => setSearches((all) => ({ ...all, [tabId]: "" }));
  // The folders below are searched once typing pauses; clearing the field, or coming back to a tab, goes there at once.
  const [query, setQuery] = useState("");
  const typed = nfc(search.trim());
  const queryTab = useRef(tabId);
  useEffect(() => {
    const switched = queryTab.current !== tabId;
    queryTab.current = tabId;
    if (!typed || switched) return setQuery(typed);
    const timer = setTimeout(() => setQuery(typed), 250);
    return () => clearTimeout(timer);
  }, [typed, tabId]);
  // Folders open in place in the list view only; a search lists what it found, wherever inside the folder that is.
  const searching = Boolean(typed);
  const searched = useFolderSearch(win.rootSlug, win.logicalPath, searching ? query : "");
  // Matches kept from before are shown only while they are of this folder and of a search still being typed.
  const results = searching && searched.data?.rootSlug === win.rootSlug && searched.data.path === win.logicalPath ? searched.data : undefined;
  const found = useMemo(() => (results ? sortItems(results.items, win.sortBy, win.sortDirection) : []), [results, win.sortBy, win.sortDirection]);
  // A search that failed is over, whatever it had found by then.
  const pending = searching && (query !== typed || (!searched.isError && (!results || results.query !== query || results.partial)));
  return { search, setSearch, reset, typed, searching, searched, results, found, pending };
}

export type FileSearch = ReturnType<typeof useFileSearch>;
