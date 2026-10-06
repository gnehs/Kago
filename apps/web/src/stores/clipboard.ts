import { create } from "zustand";

export type FileRef = { rootSlug: string; path: string };

/** Files picked up with copy or cut, waiting to be pasted into a folder. References only, like the shelf. */
export const useClipboardStore = create<{ clip: { mode: "copy" | "cut"; items: FileRef[] } | null }>(() => ({ clip: null }));
