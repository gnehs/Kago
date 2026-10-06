import { create } from "zustand";

export type RecentFolder = { rootSlug: string; path: string };

const key = "kago.recent";
const limit = 6;

function load(): RecentFolder[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item?.rootSlug === "string" && typeof item?.path === "string").slice(0, limit) : [];
  } catch {
    return [];
  }
}

export const useRecentStore = create<{ folders: RecentFolder[]; visit: (folder: RecentFolder) => void }>((set) => ({
  folders: load(),
  visit: (folder) =>
    set((state) => {
      if (folder.path === "/") return state;
      const folders = [folder, ...state.folders.filter((item) => item.rootSlug !== folder.rootSlug || item.path !== folder.path)].slice(0, limit);
      try {
        localStorage.setItem(key, JSON.stringify(folders));
      } catch {
        // Recent folders are a convenience; ignore storage failures.
      }
      return { folders };
    })
}));
