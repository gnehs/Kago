import { useSyncExternalStore } from "react";

/** As wide as a phone held upright. Kept in step with Tailwind's `sm` breakpoint, where the top bar drops its labels too. */
const query = globalThis.matchMedia?.("(max-width: 639px)");

const subscribe = (notify: () => void) => {
  query?.addEventListener("change", notify);
  return () => query?.removeEventListener("change", notify);
};

/** The same, for code that is not drawing anything. */
export const isCompact = () => query?.matches ?? false;

/**
 * Whether the screen is too narrow for windows to sit side by side. On such a screen every window fills the desktop
 * and is not moved or resized; the size it has on a wider screen is kept as it was.
 */
export const useCompact = () => useSyncExternalStore(subscribe, isCompact);
