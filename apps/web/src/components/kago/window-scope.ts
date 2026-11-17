import { createContext, useContext } from "react";
import { create } from "zustand";

/** The window the content around belongs to; a dialog opened from inside it is drawn in it. Null on the desktop and the top bar. */
export const WindowScope = createContext<string | null>(null);

/** The window to pass to `promptText`, `confirmAction` and the other dialogs opened from code, so they open in it. */
export const useWindowScope = () => useContext(WindowScope);

/** How many dialogs each window holds open. A window with one does not take input anywhere but in it. */
const useHeldWindows = create<Record<string, number>>(() => ({}));

export const useWindowHeld = (windowId: string) => useHeldWindows((held) => (held[windowId] ?? 0) > 0);

/** Marks the window as held by one more dialog; the returned function lets it go. */
export function holdWindow(windowId: string) {
  useHeldWindows.setState((held) => ({ ...held, [windowId]: (held[windowId] ?? 0) + 1 }));
  return () => useHeldWindows.setState((held) => ({ ...held, [windowId]: (held[windowId] ?? 1) - 1 }));
}
