import { create } from "zustand";
import type { ExternalApp, FileItem, FileTab, FileWindow, Root, WorkspaceState } from "../types/kago";
import { ghostWindowOut } from "../lib/motion";
import { baseName } from "../lib/paths";
import { isCompact } from "../lib/useCompact";
import { randomId } from "../lib/utils";
import { toast } from "./toast";
import { t } from "../lib/i18n";

/** Geometry and stacking shared by every window on the canvas. */
export type WindowFrame = Pick<FileWindow, "id" | "title" | "x" | "y" | "width" | "height" | "zIndex" | "minimized" | "maximized" | "focused" | "createdAt"> & {
  /** Width over height of the content below the title bar. When set, resizing keeps it. */
  aspect?: number;
};

export type AppKind = "settings" | "tasks" | "shares" | "trash";
export type SettingsSection = "general" | "account" | "apps" | "sync" | "locations" | "users" | "groups" | "sso" | "permissions" | "audit";

/**
 * Built-in tools that open as windows next to file windows. They share the window
 * manager but are not part of the persisted workspace, which only restores file windows.
 */
export type AppWindow = WindowFrame & { app: AppKind; section: SettingsSection };

/** Another service of the machine, shown in a frame inside a window of Kago's. It is kept with the app windows, one for each service. */
export type ExternalWindow = WindowFrame & { app: "external"; external: ExternalApp };

/** A file opened for viewing. Like app windows, previews are not persisted with the workspace. */
export type PreviewWindow = WindowFrame & { preview: { rootSlug: string; item: FileItem } };

const appMeta: Record<AppKind, { title: string; width: number; height: number }> = {
  settings: { title: t("Settings"), width: 880, height: 620 },
  tasks: { title: t("Tasks"), width: 560, height: 520 },
  shares: { title: t("Shares"), width: 760, height: 580 },
  trash: { title: t("Trash"), width: 620, height: 480 }
};

type WorkspaceStore = WorkspaceState & {
  hydrated: boolean;
  appWindows: Array<AppWindow | ExternalWindow>;
  previewWindows: PreviewWindow[];
  openPreview: (rootSlug: string, item: FileItem) => void;
  /** Shows another file in a preview window that is already open, e.g. the next video of a folder. */
  setPreviewItem: (id: string, item: FileItem) => void;
  /** Locks a preview window to its content's proportions, reshaping it around its centre. */
  setPreviewAspect: (id: string, aspect: number) => void;
  openApp: (app: AppKind, section?: SettingsSection) => void;
  /** Shows another service in a window of its own, or brings back the window that already shows it. */
  openExternal: (app: ExternalApp) => void;
  setAppSection: (id: string, section: SettingsSection) => void;
  hydrate: (workspace: WorkspaceState) => void;
  /** Pulls windows back inside the canvas after it shrinks. */
  refitWindows: () => void;
  openRoot: (root: Root) => void;
  openWindow: (partial: Pick<FileWindow, "rootSlug" | "logicalPath" | "title">) => void;
  /** Opens a folder in a tab of its own, beside the ones the window already has, and shows it. */
  openTab: (id: string, folder: Pick<FileTab, "rootSlug" | "logicalPath">) => void;
  /** Closes a tab; the one beside it is shown in its place. The last tab of a window stays. */
  closeTab: (id: string, tabId: string) => void;
  activateTab: (id: string, tabId: string) => void;
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
export const MAX_TABS = 12;
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
  // A phone shows every window full screen whatever its size, so one opened there is given the size it would have
  // on a desk, for the day it is seen on one, rather than being squeezed to fit a screen that does not use it.
  if (isCompact()) return { width, height, x: 32 + (index % 6) * 28, y: 24 + (index % 6) * 28 };
  const size = clampWindowSize(Math.min(width, canvas.width - 64), Math.min(height, canvas.height - 64));
  const offset = (index % 6) * 28;
  return { ...size, ...clampWindowPosition((canvas.width - size.width) / 2 + offset, Math.max(16, (canvas.height - size.height) / 2 - 16) + offset, size.width) };
}

/** Restored windows are pulled fully into view; only dragging may push one partly off-canvas. */
function fitGeometry<T extends WindowFrame>(window: T): T {
  // On a phone the frame is not what is drawn; it is left as the wider screen it came from had it.
  if (isCompact()) return window;
  const size = window.aspect ? fitAspectSize(window.aspect, window.width) : clampWindowSize(window.width, window.height);
  return {
    ...window,
    ...size,
    x: Math.round(Math.max(0, Math.min(window.x, canvas.width - size.width))),
    y: Math.round(Math.max(0, Math.min(window.y, canvas.height - size.height)))
  };
}

type Stack = { windows: FileWindow[]; appWindows: Array<AppWindow | ExternalWindow>; previewWindows: PreviewWindow[] };

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

/** What each location is called. The store names windows after folders, and the top of a location goes by the location's name. */
let rootNames = new Map<string, string>();

export function setRootNames(roots: Root[]) {
  rootNames = new Map(roots.map((root) => [root.slug, root.name]));
}

/** The name a folder goes by on a title bar or a tab. */
export const folderTitle = (rootSlug: string, logicalPath: string) => (logicalPath === "/" ? "" : baseName(logicalPath)) || rootNames.get(rootSlug) || rootSlug;

const newTab = (folder: Pick<FileTab, "rootSlug" | "logicalPath">): FileTab => ({ id: `tab_${randomId()}`, rootSlug: folder.rootSlug, logicalPath: folder.logicalPath });

/** Every window has at least the tab it is showing; one saved before there were tabs is given it here. */
function withTabs(window: FileWindow): FileWindow {
  if (window.tabs?.length && window.tabs.some((tab) => tab.id === window.activeTabId)) return window;
  const tab = newTab(window);
  return { ...window, tabs: [tab], activeTabId: tab.id };
}

/** Turns a window to one of its tabs. Nothing stays selected: the selection belonged to the folder it leaves. */
const showTab = (window: FileWindow, tab: FileTab): FileWindow => ({ ...window, activeTabId: tab.id, rootSlug: tab.rootSlug, logicalPath: tab.logicalPath, title: folderTitle(tab.rootSlug, tab.logicalPath), selectedItems: [], updatedAt: ts() });

const closeGuards = new Map<string, () => Promise<boolean>>();

/** A window holding unsaved work registers a guard that is asked before it closes. Returns the way to withdraw it. */
export function guardWindowClose(id: string, guard: () => Promise<boolean>) {
  closeGuards.set(id, guard);
  return () => {
    if (closeGuards.get(id) === guard) closeGuards.delete(id);
  };
}

/** Closes a window the way the user does: one with a guard gets to object first. */
export async function requestCloseWindow(id: string) {
  const guard = closeGuards.get(id);
  if (guard && !(await guard())) return;
  ghostWindowOut(id, "close");
  useWorkspaceStore.getState().closeWindow(id);
}

/** Puts windows away into the top bar. */
export function minimizeWindows(ids: string[]) {
  const store = useWorkspaceStore.getState();
  for (const id of ids) {
    ghostWindowOut(id, "minimize");
    store.updateWindow(id, { minimized: true });
  }
}

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
      // The window in front when it was saved may have been one that is not saved (settings, a preview). The desktop
      // does not come back with nothing in front for that: the file window that was on top takes its place.
      const onTop = workspace.windows.filter((window) => !window.minimized).sort((a, b) => b.zIndex - a.zIndex)[0];
      const activeWindowId = appFocused ? state.activeWindowId : (workspace.activeWindowId ?? onTop?.id ?? null);
      return { ...workspace, activeWindowId, ...restack({ windows: workspace.windows.map((window) => withTabs(fitGeometry(window))), appWindows: state.appWindows, previewWindows: state.previewWindows }, appFocused ? activeWindowId : undefined, activeWindowId), hydrated: true };
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
      toast(t("That’s the most windows you can have open"), "error");
      return;
    }
    set((state) => {
      const id = `win_${randomId()}`;
      const tab = newTab(partial);
      const window: FileWindow = {
        id,
        ...partial,
        tabs: [tab],
        activeTabId: tab.id,
        ...initialGeometry(frames(state).length),
        zIndex: topZ(state) + 1,
        minimized: false,
        maximized: false,
        focused: true,
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
        ? state.appWindows.map((window) => (window.id === id && window.app !== "external" ? { ...window, minimized: false, section: section ?? window.section } : window))
        : [
            ...state.appWindows,
            { id, app, section: section ?? "general", title: meta.title, ...initialGeometry(frames(state).length, meta.width, meta.height), zIndex: topZ(state) + 1, minimized: false, maximized: false, focused: true, createdAt: ts() }
          ];
      return { ...restack({ ...state, appWindows }, id), activeWindowId: id };
    }),
  openExternal: (app) =>
    set((state) => {
      const id = `app_external_${app.id}`;
      const appWindows = state.appWindows.some((window) => window.id === id)
        ? state.appWindows.map((window) => (window.id === id && window.app === "external" ? { ...window, minimized: false, title: app.name, external: app } : window))
        : [
            ...state.appWindows,
            { id, app: "external" as const, external: app, title: app.name, ...initialGeometry(frames(state).length, 1040, 720), zIndex: topZ(state) + 1, minimized: false, maximized: false, focused: true, createdAt: ts() }
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
  setPreviewItem: (id, item) =>
    set((state) => ({ previewWindows: state.previewWindows.map((window) => (window.id === id ? { ...window, title: item.name, preview: { ...window.preview, item } } : window)) })),
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
  setAppSection: (id, section) => set((state) => ({ appWindows: state.appWindows.map((window) => (window.id === id && window.app !== "external" ? { ...window, section } : window)) })),
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
  openTab: (id, folder) =>
    set((state) => ({
      windows: state.windows.map((window) => {
        if (window.id !== id) return window;
        const tabs = window.tabs ?? [];
        if (tabs.length >= MAX_TABS) {
          toast(t("That’s the most tabs a window can have"), "error");
          return window;
        }
        const tab = newTab(folder);
        // A new tab opens next to the one it was opened from.
        const at = tabs.findIndex((entry) => entry.id === window.activeTabId) + 1;
        return showTab({ ...window, tabs: [...tabs.slice(0, at), tab, ...tabs.slice(at)] }, tab);
      })
    })),
  closeTab: (id, tabId) =>
    set((state) => ({
      windows: state.windows.map((window) => {
        const tabs = window.tabs ?? [];
        const index = tabs.findIndex((tab) => tab.id === tabId);
        if (window.id !== id || index === -1 || tabs.length < 2) return window;
        const rest = tabs.filter((tab) => tab.id !== tabId);
        return window.activeTabId === tabId ? showTab({ ...window, tabs: rest }, rest[Math.min(index, rest.length - 1)]!) : { ...window, tabs: rest, updatedAt: ts() };
      })
    })),
  activateTab: (id, tabId) =>
    set((state) => ({
      windows: state.windows.map((window) => {
        const tab = window.id === id && window.activeTabId !== tabId ? window.tabs?.find((entry) => entry.id === tabId) : undefined;
        return tab ? showTab(window, tab) : window;
      })
    })),
  updateWindow: (id, patch) =>
    set((state) => ({
      windows: state.windows.map((window) => {
        if (window.id !== id) return window;
        const next = { ...window, ...patch, updatedAt: ts() };
        if (!patch.logicalPath && !patch.rootSlug) return next;
        // Going somewhere else takes the tab along, and the window is named after where it now is.
        next.title = folderTitle(next.rootSlug, next.logicalPath);
        next.tabs = next.tabs?.map((tab) => (tab.id === next.activeTabId ? { ...tab, rootSlug: next.rootSlug, logicalPath: next.logicalPath } : tab));
        return next;
      }),
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
