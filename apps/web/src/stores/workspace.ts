import { create } from "zustand";
import type { FileWindow, Root, WorkspaceState } from "../types/kago";

type WorkspaceStore = WorkspaceState & {
  hydrated: boolean;
  nextZ: number;
  hydrate: (workspace: WorkspaceState) => void;
  openRoot: (root: Root) => void;
  openWindow: (partial: Pick<FileWindow, "rootSlug" | "logicalPath" | "title">) => void;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  updateWindow: (id: string, patch: Partial<FileWindow>) => void;
  selectItems: (id: string, items: string[]) => void;
  snapshot: () => WorkspaceState;
};

const ts = () => Date.now();
const titleFromPath = (logicalPath: string, rootSlug: string) => logicalPath === "/" ? rootSlug : logicalPath.split("/").filter(Boolean).at(-1) ?? rootSlug;
const initialGeometry = (index: number) => {
  const viewportWidth = typeof globalThis.innerWidth === "number" ? globalThis.innerWidth : 1280;
  const width = Math.max(760, Math.min(980, viewportWidth - 560));
  return {
    x: 60 + index * 32,
    y: 220 + index * 28,
    width,
    height: 620
  };
};

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  hydrated: false,
  activeWindowId: null,
  windows: [],
  sidebar: { collapsed: false },
  inspector: { open: true, width: 320 },
  shelf: { collapsed: false, x: 360, y: 680 },
  nextZ: 120,
  hydrate: (workspace) =>
    set({
      ...workspace,
      hydrated: true,
      nextZ: Math.max(120, ...workspace.windows.map((window) => window.zIndex + 1))
    }),
  openRoot: (root) => {
    const existing = get().windows.find((window) => window.rootSlug === root.slug && window.logicalPath === "/");
    if (existing) {
      get().focusWindow(existing.id);
      return;
    }
    get().openWindow({ rootSlug: root.slug, logicalPath: "/", title: root.name });
  },
  openWindow: (partial) =>
    set((state) => {
      if (state.windows.length >= 12) return state;
      const index = state.windows.length;
      const id = `win_${crypto.randomUUID()}`;
      const geometry = initialGeometry(index);
      const window: FileWindow = {
        id,
        rootSlug: partial.rootSlug,
        logicalPath: partial.logicalPath,
        title: partial.title,
        x: geometry.x,
        y: geometry.y,
        width: geometry.width,
        height: geometry.height,
        zIndex: state.nextZ,
        minimized: false,
        maximized: false,
        focused: true,
        viewMode: "list",
        sortBy: "name",
        sortDirection: "asc",
        selectedItems: [],
        createdAt: ts(),
        updatedAt: ts()
      };
      return {
        windows: [...state.windows.map((item) => ({ ...item, focused: false })), window],
        activeWindowId: id,
        nextZ: state.nextZ + 1
      };
    }),
  closeWindow: (id) =>
    set((state) => {
      const windows = state.windows.filter((window) => window.id !== id);
      const activeWindowId = state.activeWindowId === id ? windows.at(-1)?.id ?? null : state.activeWindowId;
      return { windows, activeWindowId };
    }),
  focusWindow: (id) =>
    set((state) => ({
      activeWindowId: id,
      nextZ: state.nextZ + 1,
      windows: state.windows.map((window) => ({
        ...window,
        focused: window.id === id,
        zIndex: window.id === id ? state.nextZ : window.zIndex
      }))
    })),
  updateWindow: (id, patch) =>
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? { ...window, ...patch, title: patch.logicalPath ? titleFromPath(patch.logicalPath, window.rootSlug) : patch.title ?? window.title, updatedAt: ts() }
          : window
      )
    })),
  selectItems: (id, items) =>
    set((state) => ({
      windows: state.windows.map((window) => (window.id === id ? { ...window, selectedItems: items } : window))
    })),
  snapshot: () => {
    const state = get();
    return {
      activeWindowId: state.activeWindowId,
      windows: state.windows,
      sidebar: state.sidebar,
      inspector: state.inspector,
      shelf: state.shelf
    };
  }
}));
