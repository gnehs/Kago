import { create } from "zustand";
import type { FileWindow, Root, WorkspaceState } from "../types/kago";
import { baseName } from "../lib/paths";
import { toast } from "./toast";

type WorkspaceStore = WorkspaceState & {
  hydrated: boolean;
  hydrate: (workspace: WorkspaceState) => void;
  /** Pulls windows back inside the canvas after it shrinks. */
  refitWindows: () => void;
  openRoot: (root: Root) => void;
  openWindow: (partial: Pick<FileWindow, "rootSlug" | "logicalPath" | "title">) => void;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  updateWindow: (id: string, patch: Partial<FileWindow>) => void;
  updateSidebar: (patch: Partial<WorkspaceState["sidebar"]>) => void;
  updateInspector: (patch: Partial<WorkspaceState["inspector"]>) => void;
  updateShelf: (patch: Partial<WorkspaceState["shelf"]>) => void;
  selectItems: (id: string, items: string[]) => void;
  snapshot: () => WorkspaceState;
};

export const MAX_WINDOWS = 12;
export const MIN_WINDOW_WIDTH = 360;
export const MIN_WINDOW_HEIGHT = 280;
/** How much of a window must stay reachable inside the canvas. */
const KEEP_VISIBLE = 120;
const TITLEBAR_HEIGHT = 36;

const fileWindowZBase = 100;
const fileWindowZLimit = 499;

const ts = () => Date.now();

/**
 * Window geometry is relative to the workspace canvas, not the viewport.
 * The canvas reports its size here so the store can clamp without reading the DOM.
 */
let canvas = { width: Math.max(480, (globalThis.innerWidth ?? 1280) - 232), height: Math.max(360, globalThis.innerHeight ?? 800) };

export const getCanvasSize = () => canvas;

export function setCanvasSize(width: number, height: number) {
  canvas = { width: Math.round(width), height: Math.round(height) };
}

export function clampWindowPosition(x: number, y: number, width: number) {
  return {
    x: Math.round(Math.min(canvas.width - KEEP_VISIBLE, Math.max(KEEP_VISIBLE - width, x))),
    y: Math.round(Math.min(Math.max(0, canvas.height - TITLEBAR_HEIGHT), Math.max(0, y)))
  };
}

export function clampWindowSize(width: number, height: number) {
  return {
    width: Math.round(Math.max(MIN_WINDOW_WIDTH, Math.min(width, canvas.width))),
    height: Math.round(Math.max(MIN_WINDOW_HEIGHT, Math.min(height, canvas.height)))
  };
}

function initialGeometry(index: number) {
  const size = clampWindowSize(Math.min(920, canvas.width - 64), Math.min(620, canvas.height - 64));
  const offset = (index % 6) * 28;
  return { ...size, ...clampWindowPosition((canvas.width - size.width) / 2 + offset, Math.max(16, (canvas.height - size.height) / 2 - 16) + offset, size.width) };
}

/** Restored windows are pulled fully into view; only dragging may push one partly off-canvas. */
function fitGeometry(window: FileWindow): FileWindow {
  const size = clampWindowSize(window.width, window.height);
  return {
    ...window,
    ...size,
    x: Math.round(Math.max(0, Math.min(window.x, canvas.width - size.width))),
    y: Math.round(Math.max(0, Math.min(window.y, canvas.height - size.height)))
  };
}

/** Renumbers z-indexes from the base so they never drift past the file-window layer. */
function restack(windows: FileWindow[]): FileWindow[] {
  const order = [...windows].sort((a, b) => a.zIndex - b.zIndex || a.createdAt - b.createdAt).map((window) => window.id);
  return windows.map((window) => ({ ...window, zIndex: Math.min(fileWindowZLimit, fileWindowZBase + order.indexOf(window.id)) }));
}

const topZ = (windows: FileWindow[]) => Math.max(fileWindowZBase - 1, ...windows.map((window) => window.zIndex));

const titleFromPath = (logicalPath: string, fallback: string) => (logicalPath === "/" ? fallback : baseName(logicalPath) || fallback);

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  hydrated: false,
  activeWindowId: null,
  windows: [],
  sidebar: { collapsed: false },
  inspector: { open: false, width: 300 },
  shelf: { collapsed: false },
  hydrate: (workspace) => set({ ...workspace, windows: restack(workspace.windows.map(fitGeometry)), hydrated: true }),
  refitWindows: () =>
    set((state) => {
      const windows = state.windows.map((window) => {
        const next = fitGeometry(window);
        return next.x === window.x && next.y === window.y && next.width === window.width && next.height === window.height ? window : next;
      });
      return windows.some((window, index) => window !== state.windows[index]) ? { windows } : state;
    }),
  openRoot: (root) => {
    const existing = get().windows.find((window) => window.rootSlug === root.slug);
    if (existing) {
      get().updateWindow(existing.id, { minimized: false });
      get().focusWindow(existing.id);
      return;
    }
    get().openWindow({ rootSlug: root.slug, logicalPath: "/", title: root.name });
  },
  openWindow: (partial) => {
    if (get().windows.length >= MAX_WINDOWS) {
      toast("已達視窗數量上限", "error");
      return;
    }
    set((state) => {
      const windows = restack(state.windows);
      const id = `win_${crypto.randomUUID()}`;
      const window: FileWindow = {
        id,
        ...partial,
        ...initialGeometry(windows.length),
        zIndex: topZ(windows) + 1,
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
      return { windows: [...windows.map((item) => ({ ...item, focused: false })), window], activeWindowId: id };
    });
  },
  closeWindow: (id) =>
    set((state) => {
      const windows = state.windows.filter((window) => window.id !== id);
      if (state.activeWindowId !== id) return { windows };
      const next = [...windows].filter((window) => !window.minimized).sort((a, b) => b.zIndex - a.zIndex)[0];
      return { windows: windows.map((window) => ({ ...window, focused: window.id === next?.id })), activeWindowId: next?.id ?? null };
    }),
  focusWindow: (id) =>
    set((state) => {
      const current = state.windows.find((window) => window.id === id);
      if (!current) return state;
      if (state.activeWindowId === id && current.zIndex === topZ(state.windows)) return state;
      const windows = restack(state.windows.map((window) => (window.id === id ? { ...window, zIndex: fileWindowZLimit + 1 } : window)));
      return { activeWindowId: id, windows: windows.map((window) => ({ ...window, focused: window.id === id })) };
    }),
  updateWindow: (id, patch) =>
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? { ...window, ...patch, title: patch.logicalPath ? titleFromPath(patch.logicalPath, window.rootSlug) : patch.title ?? window.title, updatedAt: ts() }
          : window
      )
    })),
  updateSidebar: (patch) => set((state) => ({ sidebar: { ...state.sidebar, ...patch } })),
  updateInspector: (patch) => set((state) => ({ inspector: { ...state.inspector, ...patch } })),
  updateShelf: (patch) => set((state) => ({ shelf: { ...state.shelf, ...patch } })),
  selectItems: (id, items) =>
    set((state) => ({ windows: state.windows.map((window) => (window.id === id ? { ...window, selectedItems: items } : window)) })),
  snapshot: () => {
    const { activeWindowId, windows, sidebar, inspector, shelf } = get();
    return { activeWindowId, windows, sidebar, inspector, shelf };
  }
}));
