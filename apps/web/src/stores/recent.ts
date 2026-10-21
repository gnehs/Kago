import { create } from "zustand";

export type RecentFolder = { rootSlug: string; path: string };

// Each account keeps its own, so whoever signs in next in this browser never sees where the last one was.
const keyFor = (userId: string) => `kago.recent.${userId}`;
const limit = 6;

function load(userId: string): RecentFolder[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(userId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item?.rootSlug === "string" && typeof item?.path === "string").slice(0, limit) : [];
  } catch {
    return [];
  }
}

export const useRecentStore = create<{ userId: string | null; folders: RecentFolder[]; signIn: (userId: string) => void; visit: (folder: RecentFolder) => void }>((set) => ({
  userId: null,
  folders: [],
  signIn: (userId) => {
    try {
      // What every account shared before they were kept apart.
      localStorage.removeItem("kago.recent");
    } catch {
      // Recent folders are a convenience; ignore storage failures.
    }
    set({ userId, folders: load(userId) });
  },
  visit: (folder) =>
    set((state) => {
      if (folder.path === "/" || !state.userId) return state;
      const folders = [folder, ...state.folders.filter((item) => item.rootSlug !== folder.rootSlug || item.path !== folder.path)].slice(0, limit);
      try {
        localStorage.setItem(keyFor(state.userId), JSON.stringify(folders));
      } catch {
        // Recent folders are a convenience; ignore storage failures.
      }
      return { folders };
    })
}));
