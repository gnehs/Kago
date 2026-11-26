import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { PAGE, SEARCH_PAGE, shareEndpoint, type ShareSort } from "@/lib/shareFolderModel";
import { nfc } from "@/lib/paths";
import type { ShareFolderPage, ShareItem } from "@/types/kago";

export type ShareFolder = {
  /** The entries read so far, in the order asked for. */
  items: ShareItem[];
  /** How many the folder holds. */
  total: number;
  hasMore: boolean;
  /** The first page is on its way. */
  loading: boolean;
  /** A later one is. */
  more: boolean;
  error: Error | null;
  loadMore: () => void;
  retry: () => void;
};

const EMPTY = { items: [] as ShareItem[], total: 0, hasMore: false, loading: true, more: false, error: null as Error | null };

/**
 * A folder of a link, a page at a time: the first is read at once however much the folder holds, and the next ones
 * as `loadMore` is asked for. While `find` names a file that has not turned up yet (a link that opens one far down),
 * it goes on in bigger bites until it does, so the viewer can say which are either side of it.
 */
export function useShareFolder(token: string, path: string, sort: ShareSort, find: string | null): ShareFolder {
  const [state, setState] = useState(EMPTY);
  const reading = useRef(0);
  const busy = useRef(false);
  const latest = useRef(state);
  latest.current = state;

  const fetchPage = useCallback(
    (id: number, offset: number, limit: number) => {
      busy.current = true;
      setState((now) => ({ ...now, loading: offset === 0, more: offset > 0, error: null }));
      api<ShareFolderPage>(shareEndpoint(token, "list", { path, offset, limit, sortBy: sort.by, direction: sort.direction }))
        .then((page) => {
          if (id !== reading.current) return;
          busy.current = false;
          setState((now) => {
            const known = new Set(now.items.map((item) => item.path));
            return { items: offset === 0 ? page.items : [...now.items, ...page.items.filter((item) => !known.has(item.path))], total: page.total, hasMore: page.hasMore, loading: false, more: false, error: null };
          });
        })
        .catch((error: unknown) => {
          if (id !== reading.current) return;
          busy.current = false;
          setState((now) => ({ ...now, loading: false, more: false, error: error instanceof Error ? error : new Error(String(error)) }));
        });
    },
    [token, path, sort.by, sort.direction]
  );

  // Another folder or another order starts from nothing; what was on its way for the last is not heard.
  useEffect(() => {
    const id = ++reading.current;
    busy.current = false;
    setState(EMPTY);
    fetchPage(id, 0, PAGE);
    return () => {
      reading.current += 1;
    };
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    const now = latest.current;
    if (busy.current || !now.hasMore || now.error) return;
    fetchPage(reading.current, now.items.length, PAGE);
  }, [fetchPage]);

  const retry = useCallback(() => {
    const now = latest.current;
    if (busy.current) return;
    fetchPage(reading.current, now.items.length, PAGE);
  }, [fetchPage]);

  const found = find === null || state.items.some((item) => nfc(item.name) === find);
  useEffect(() => {
    if (found || busy.current || !state.hasMore || state.error || state.loading) return;
    fetchPage(reading.current, state.items.length, SEARCH_PAGE);
  }, [found, state.hasMore, state.error, state.loading, state.items.length, fetchPage]);

  return { ...state, loadMore, retry };
}
