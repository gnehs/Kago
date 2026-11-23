import { useEffect, useLayoutEffect, useRef, type MutableRefObject } from "react";
import { isInside } from "@/lib/paths";
import type { FolderWindow } from "@/types/kago";

/** Where each folder was scrolled to, in the tab that showed it. `viaHistory` is set when back or forward made the move. */
export function useScrollMemory(scroller: HTMLDivElement | null, win: FolderWindow, tabId: string, listReady: boolean, viaHistory: MutableRefObject<boolean>) {
  // Coming back to a folder (back, forward, up, or its tab) shows it scrolled to where it was left; going anywhere else starts at the top.
  const scrollTops = useRef(new Map<string, number>());
  const scrollPlace = useRef<{ key: string; tabId: string; rootSlug: string; path: string } | null>(null);
  const scrollRestore = useRef<number | null>(null);
  const scrollKey = `${tabId}\n${win.rootSlug}\n${win.logicalPath}`;

  useLayoutEffect(() => {
    const left = scrollPlace.current;
    if (left?.key !== scrollKey) {
      const returning = viaHistory.current || (left !== null && (left.tabId !== tabId || (left.rootSlug === win.rootSlug && isInside(left.path, win.logicalPath))));
      viaHistory.current = false;
      scrollPlace.current = { key: scrollKey, tabId, rootSlug: win.rootSlug, path: win.logicalPath };
      scrollRestore.current = (returning ? scrollTops.current.get(scrollKey) : undefined) ?? 0;
    }
    // The list has to be there before it can be scrolled.
    if (scrollRestore.current === null || !scroller || !listReady) return;
    scroller.scrollTop = scrollRestore.current;
    scrollRestore.current = null;
    // Tells the list which rows to render before the next paint, rather than a frame later.
    scroller.dispatchEvent(new Event("scroll"));
  }, [scrollKey, tabId, win.rootSlug, win.logicalPath, scroller, listReady, viaHistory]);

  useEffect(() => {
    if (!scroller) return;
    // A folder that is still loading has nothing to scroll, which must not count as having been scrolled to the top.
    const remember = () => scrollRestore.current === null && scrollPlace.current && scrollTops.current.set(scrollPlace.current.key, scroller.scrollTop);
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => scroller.removeEventListener("scroll", remember);
  }, [scroller]);
}
