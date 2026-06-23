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
  const minX = viewportWidth > 980 ? 292 : 12;
  const availableWidth = Math.max(360, viewportWidth - minX - 28);
  const width = Math.max(360, Math.min(1040, availableWidth));
  const height = Math.max(280, Math.min(720, viewportHeight - 132));
  return {
    x: Math.max(minX, Math.round((viewportWidth - width + minX) / 2) + index * 28),
    y: 92 + index * 24,
    width,
    height
  };
};

const fitGeometry = (window: FileWindow): FileWindow => {
  const viewportWidth = typeof globalThis.innerWidth === "number" ? globalThis.innerWidth : 1280;
  const viewportHeight = typeof globalThis.innerHeight === "number" ? globalThis.innerHeight : 820;
  const minX = viewportWidth > 980 ? 292 : 12;
  const maxWidth = Math.max(360, viewportWidth - minX - 20);
  const restoredWidth = Math.min(window.width, maxWidth);
  const minUsefulDesktopWidth = viewportWidth > 1180 ? Math.min(920, maxWidth) : 360;
  const width = Math.max(restoredWidth < 820 ? minUsefulDesktopWidth : 360, restoredWidth);
  const height = Math.max(280, Math.min(window.height, Math.max(280, viewportHeight - 78)));
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
    const existing = get().windows.find((window) => window.rootSlug === root.slug);
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
