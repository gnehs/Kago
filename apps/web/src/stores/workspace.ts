import { create } from "zustand";
import type { FileItem, FileWindow, Root, WorkspaceState } from "../types/kago";
import { baseName } from "../lib/paths";
import { randomId } from "../lib/utils";
import { toast } from "./toast";

/** Geometry and stacking shared by every window on the canvas. */
export type WindowFrame = Pick<FileWindow, "id" | "title" | "x" | "y" | "width" | "height" | "zIndex" | "minimized" | "maximized" | "focused" | "createdAt"> & {
  /** Width over height of the content below the title bar. When set, resizing keeps it. */
  aspect?: number;
};

export type AppKind = "settings" | "tasks" | "shares" | "trash";
export type SettingsSection = "general" | "users" | "groups" | "permissions" | "audit";

/**
 * Built-in tools that open as windows next to file windows. They share the window
 * manager but are not part of the persisted workspace, which only restores file windows.
 */
export type AppWindow = WindowFrame & { app: AppKind; section: SettingsSection };

/** A file opened for viewing. Like app windows, previews are not persisted with the workspace. */
export type PreviewWindow = WindowFrame & { preview: { rootSlug: string; item: FileItem } };

const appMeta: Record<AppKind, { title: string; width: number; height: number }> = {
  settings: { title: "設定", width: 880, height: 620 },
  tasks: { title: "任務", width: 560, height: 520 },
  shares: { title: "分享", width: 760, height: 580 },
  trash: { title: "垃圾桶", width: 620, height: 480 }
};

type WorkspaceStore = WorkspaceState & {
  hydrated: boolean;
  appWindows: AppWindow[];
  previewWindows: PreviewWindow[];
  openPreview: (rootSlug: string, item: FileItem) => void;
  /** Locks a preview window to its content's proportions, reshaping it around its centre. */
  setPreviewAspect: (id: string, aspect: number) => void;
  openApp: (app: AppKind, section?: SettingsSection) => void;
  setAppSection: (id: string, section: SettingsSection) => void;
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
export const TITLEBAR_HEIGHT = 36;

const fileWindowZBase = 100;
const fileWindowZLimit = 499;

const ts = () => Date.now();

/**
 * Window geometry is relative to the workspace canvas, not the viewport.
 * The canvas reports its size here so the store can clamp without reading the DOM.
 */
let canvas = { width: Math.max(480, globalThis.innerWidth ?? 1280), height: Math.max(360, (globalThis.innerHeight ?? 800) - 40) };

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

const MIN_ASPECT_WIDTH = 320;
const MIN_ASPECT_CONTENT_HEIGHT = 180;

/** The size of a window whose content keeps `aspect`, as close to `width` as the minimum and the given box allow. */
export function fitAspectSize(aspect: number, width: number, maxWidth = canvas.width, maxHeight = canvas.height) {
  const smallest = Math.max(MIN_ASPECT_WIDTH, MIN_ASPECT_CONTENT_HEIGHT * aspect);
  // The box wins over the minimum, so a tall video still fits a short canvas.
  const fitted = Math.min(Math.max(width, smallest), maxWidth, (maxHeight - TITLEBAR_HEIGHT) * aspect);
  return { width: Math.round(fitted), height: Math.round(fitted / aspect) + TITLEBAR_HEIGHT };
}

function initialGeometry(index: number, width = 920, height = 620) {
  const size = clampWindowSize(Math.min(width, canvas.width - 64), Math.min(height, canvas.height - 64));
  const offset = (index % 6) * 28;
  return { ...size, ...clampWindowPosition((canvas.width - size.width) / 2 + offset, Math.max(16, (canvas.height - size.height) / 2 - 16) + offset, size.width) };
}

/** Restored windows are pulled fully into view; only dragging may push one partly off-canvas. */
function fitGeometry<T extends WindowFrame>(window: T): T {
  const size = window.aspect ? fitAspectSize(window.aspect, window.width) : clampWindowSize(window.width, window.height);
  return {
    ...window,
    ...size,
    x: Math.round(Math.max(0, Math.min(window.x, canvas.width - size.width))),
    y: Math.round(Math.max(0, Math.min(window.y, canvas.height - size.height)))
  };
}

type Stack = { windows: FileWindow[]; appWindows: AppWindow[]; previewWindows: PreviewWindow[] };

const frames = (stack: Stack): WindowFrame[] => [...stack.windows, ...stack.appWindows, ...stack.previewWindows];

const topZ = (stack: Stack) => Math.max(fileWindowZBase - 1, ...frames(stack).map((window) => window.zIndex));

/**
 * Renumbers z-indexes from the base across file, app and preview windows, optionally raising one
 * to the front, so they never drift past the window layer. Also syncs the focused flag.
 */
function restack(stack: Stack, frontId?: string | null, focusId: string | null | undefined = frontId): Stack {
  const order = frames(stack)
    .sort((a, b) => Number(a.id === frontId) - Number(b.id === frontId) || a.zIndex - b.zIndex || a.createdAt - b.createdAt)
    .map((window) => window.id);
  const apply = <T extends WindowFrame>(window: T): T => {
    const zIndex = Math.min(fileWindowZLimit, fileWindowZBase + order.indexOf(window.id));
    const focused = focusId === undefined ? window.focused : window.id === focusId;
    return zIndex === window.zIndex && focused === window.focused ? window : { ...window, zIndex, focused };
  };
  // Keep array identity when nothing moved so autosave does not see a phantom change.
  const keep = <T extends WindowFrame>(list: T[]): T[] => {
    const next = list.map(apply);
    return next.some((window, index) => window !== list[index]) ? next : list;
  };
  return { windows: keep(stack.windows), appWindows: keep(stack.appWindows), previewWindows: keep(stack.previewWindows) };
}

const titleFromPath = (logicalPath: string, fallback: string) => (logicalPath === "/" ? fallback : baseName(logicalPath) || fallback);

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => ({
  hydrated: false,
  activeWindowId: null,
  windows: [],
  sidebar: { collapsed: false },
  inspector: { open: false, width: 300 },
  shelf: { collapsed: false },
  appWindows: [],
  previewWindows: [],
  hydrate: (workspace) =>
    set((state) => {
      // A remote update only describes file windows; an app or preview window keeps focus, and stays in front, if it had it.
      const appFocused = [...state.appWindows, ...state.previewWindows].some((window) => window.id === state.activeWindowId);
      const activeWindowId = appFocused ? state.activeWindowId : workspace.activeWindowId;
      return { ...workspace, activeWindowId, ...restack({ windows: workspace.windows.map(fitGeometry), appWindows: state.appWindows, previewWindows: state.previewWindows }, appFocused ? activeWindowId : undefined, activeWindowId), hydrated: true };
    }),
  refitWindows: () =>
    set((state) => {
      const refit = <T extends WindowFrame>(window: T): T => {
        const next = fitGeometry(window);
        return next.x === window.x && next.y === window.y && next.width === window.width && next.height === window.height ? window : next;
      };
      const windows = state.windows.map(refit);
      const appWindows = state.appWindows.map(refit);
      const previewWindows = state.previewWindows.map(refit);
      const changed =
        windows.some((window, index) => window !== state.windows[index]) ||
        appWindows.some((window, index) => window !== state.appWindows[index]) ||
        previewWindows.some((window, index) => window !== state.previewWindows[index]);
      return changed ? { windows, appWindows, previewWindows } : state;
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
      const id = `win_${randomId()}`;
      const window: FileWindow = {
        id,
        ...partial,
        ...initialGeometry(frames(state).length),
        zIndex: topZ(state) + 1,
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
      return { ...restack({ ...state, windows: [...state.windows, window] }, id), activeWindowId: id };
    });
  },
  openApp: (app, section) =>
    set((state) => {
      const existing = state.appWindows.find((window) => window.app === app);
      const id = existing?.id ?? `app_${app}`;
      const meta = appMeta[app];
      const appWindows = existing
        ? state.appWindows.map((window) => (window.id === id ? { ...window, minimized: false, section: section ?? window.section } : window))
        : [
            ...state.appWindows,
            { id, app, section: section ?? "general", title: meta.title, ...initialGeometry(frames(state).length, meta.width, meta.height), zIndex: topZ(state) + 1, minimized: false, maximized: false, focused: true, createdAt: ts() }
          ];
      return { ...restack({ ...state, appWindows }, id), activeWindowId: id };
    }),
  openPreview: (rootSlug, item) =>
    set((state) => {
      // Opening a file that is already being previewed brings its window back instead of duplicating it.
      const existing = state.previewWindows.find((window) => window.preview.rootSlug === rootSlug && window.preview.item.path === item.path);
      const id = existing?.id ?? `preview_${randomId()}`;
      const previewWindows = existing
        ? state.previewWindows.map((window) => (window.id === id ? { ...window, minimized: false, title: item.name, preview: { rootSlug, item } } : window))
        : [
            ...state.previewWindows,
            { id, preview: { rootSlug, item }, title: item.name, ...initialGeometry(frames(state).length, 760, 560), zIndex: topZ(state) + 1, minimized: false, maximized: false, focused: true, createdAt: ts() }
          ];
      return { ...restack({ ...state, previewWindows }, id), activeWindowId: id };
    }),
  setPreviewAspect: (id, aspect) =>
    set((state) => ({
      previewWindows: state.previewWindows.map((window) => {
        if (window.id !== id || !Number.isFinite(aspect) || aspect <= 0) return window;
        // Transcoded frames are rounded to even pixels, so the same video can report a hair's difference.
        if (window.aspect && Math.abs(window.aspect / aspect - 1) < 0.01) return window;
        // Keep the area the window had, so a portrait video turns it tall instead of shrinking it.
        const size = fitAspectSize(aspect, Math.sqrt(window.width * (window.height - TITLEBAR_HEIGHT) * aspect));
        return fitGeometry({ ...window, aspect, ...size, x: window.x + (window.width - size.width) / 2, y: window.y + (window.height - size.height) / 2 });
      })
    })),
  setAppSection: (id, section) => set((state) => ({ appWindows: state.appWindows.map((window) => (window.id === id ? { ...window, section } : window)) })),
  closeWindow: (id) =>
    set((state) => {
      const stack = {
        windows: state.windows.filter((window) => window.id !== id),
        appWindows: state.appWindows.filter((window) => window.id !== id),
        previewWindows: state.previewWindows.filter((window) => window.id !== id)
      };
      if (state.activeWindowId !== id) return stack;
      const next = frames(stack).filter((window) => !window.minimized).sort((a, b) => b.zIndex - a.zIndex)[0];
      return { ...restack(stack, next?.id ?? null), activeWindowId: next?.id ?? null };
    }),
  focusWindow: (id) =>
    set((state) => {
      const current = frames(state).find((window) => window.id === id);
      if (!current) return state;
      if (state.activeWindowId === id && current.focused && current.zIndex === topZ(state)) return state;
      return { ...restack(state, id), activeWindowId: id };
    }),
  updateWindow: (id, patch) =>
    set((state) => ({
      windows: state.windows.map((window) =>
        window.id === id
          ? { ...window, ...patch, title: patch.logicalPath ? titleFromPath(patch.logicalPath, window.rootSlug) : patch.title ?? window.title, updatedAt: ts() }
          : window
      ),
      // App and preview windows only take frame changes (move, resize, minimize, maximize).
      appWindows: state.appWindows.some((window) => window.id === id)
        ? state.appWindows.map((window) => (window.id === id ? { ...window, ...(patch as Partial<WindowFrame>) } : window))
        : state.appWindows,
      previewWindows: state.previewWindows.some((window) => window.id === id)
        ? state.previewWindows.map((window) => (window.id === id ? { ...window, ...(patch as Partial<WindowFrame>) } : window))
        : state.previewWindows
    })),
  updateSidebar: (patch) => set((state) => ({ sidebar: { ...state.sidebar, ...patch } })),
  updateInspector: (patch) => set((state) => ({ inspector: { ...state.inspector, ...patch } })),
  updateShelf: (patch) => set((state) => ({ shelf: { ...state.shelf, ...patch } })),
  selectItems: (id, items) =>
    set((state) => ({ windows: state.windows.map((window) => (window.id === id ? { ...window, selectedItems: items } : window)) })),
  snapshot: () => {
    const { activeWindowId, windows, sidebar, inspector, shelf } = get();
    // Only file windows are persisted, so an active app window is saved as "none".
    return { activeWindowId: windows.some((window) => window.id === activeWindowId) ? activeWindowId : null, windows, sidebar, inspector, shelf };
  }
}));
