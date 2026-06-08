import { create } from "zustand";
import type { FileWindow, Root, WorkspaceState } from "../types/kago";

type WorkspaceStore = WorkspaceState & {
  hydrated: boolean;
  nextZ: number;
  notice: string | null;
  hydrate: (workspace: WorkspaceState) => void;
  openRoot: (root: Root) => void;
  openWindow: (partial: Pick<FileWindow, "rootSlug" | "logicalPath" | "title">) => void;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  updateWindow: (id: string, patch: Partial<FileWindow>) => void;
  updateSidebar: (patch: Partial<WorkspaceState["sidebar"]>) => void;
  updateInspector: (patch: Partial<WorkspaceState["inspector"]>) => void;
  updateShelf: (patch: Partial<WorkspaceState["shelf"]>) => void;
  clearNotice: () => void;
  selectItems: (id: string, items: string[]) => void;
  snapshot: () => WorkspaceState;
};

const ts = () => Date.now();
const titleFromPath = (logicalPath: string, rootSlug: string) => logicalPath === "/" ? rootSlug : logicalPath.split("/").filter(Boolean).at(-1) ?? rootSlug;
const initialGeometry = (index: number) => {
  const viewportWidth = typeof globalThis.innerWidth === "number" ? globalThis.innerWidth : 1280;
  const viewportHeight = typeof globalThis.innerHeight === "number" ? globalThis.innerHeight : 820;
  const width = Math.max(820, Math.min(1220, viewportWidth - 220));
  const height = Math.max(580, Math.min(760, viewportHeight - 150));
  return {
    x: Math.max(132, Math.round((viewportWidth - width) / 2) + index * 34),
    y: 86 + index * 28,
    width,
    height
  };
};

const fitGeometry = (window: FileWindow): FileWindow => {
  const viewportWidth = typeof globalThis.innerWidth === "number" ? globalThis.innerWidth : 1280;
  const viewportHeight = typeof globalThis.innerHeight === "number" ? globalThis.innerHeight : 820;
  const minX = viewportWidth > 980 ? 156 : 12;
  const preferredMinWidth = viewportWidth > 980 ? Math.min(1040, viewportWidth - minX - 28) : 760;
  const width = Math.max(preferredMinWidth, Math.min(window.width, Math.max(760, viewportWidth - minX - 20)));
  const height = Math.max(520, Math.min(window.height, Math.max(520, viewportHeight - 78)));
  return {
    ...window,
    width,
    height,
    x: Math.max(minX, Math.min(window.x, viewportWidth - Math.min(280, width))),
    y: Math.max(54, Math.min(window.y, viewportHeight - 120))
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
  notice: null,
  hydrate: (workspace) =>
    set({
      ...workspace,
      windows: workspace.windows.map(fitGeometry),
      hydrated: true,
      nextZ: Math.max(120, ...workspace.windows.map((window) => window.zIndex + 1)),
      notice: null
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
      if (state.windows.length >= 12) return { notice: "已達視窗數量上限" };
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
        nextZ: state.nextZ + 1,
        notice: null
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
  updateSidebar: (patch) =>
    set((state) => ({
      sidebar: { ...state.sidebar, ...patch }
    })),
  updateInspector: (patch) =>
    set((state) => ({
      inspector: { ...state.inspector, ...patch }
    })),
  updateShelf: (patch) =>
    set((state) => ({
      shelf: { ...state.shelf, ...patch }
    })),
  clearNotice: () => set({ notice: null }),
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
