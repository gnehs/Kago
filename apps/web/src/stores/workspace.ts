import { create } from "zustand";
import type { ExternalApp, FileItem, FileWindow, FileWindowState, FolderTab, Root, SavedFileWindow, WorkspaceState } from "../types/kago";
import { ghostWindowOut } from "../lib/motion";
import { baseName, isWithin } from "../lib/paths";
import type { FileRef } from "./clipboard";
import { isCompact } from "../lib/useCompact";
import { randomId } from "../lib/utils";
import { toast } from "./toast";
import { t } from "../lib/i18n";

/** Where a window stands on the canvas and in the stack, shared by every kind of window. */
type Placement = Pick<FileWindowState, "id" | "x" | "y" | "width" | "height" | "zIndex" | "minimized" | "maximized" | "createdAt"> & {
  /** Width over height of the content below the title bar. When set, resizing keeps it. */
  aspect?: number;
};

/** A window as its frame draws it: where it stands, and what it is called. */
export type WindowFrame = Placement & { title: string };

/** What a window's frame and its own buttons may change. */
export type WindowPatch = Partial<Pick<FileWindowState, "x" | "y" | "width" | "height" | "minimized" | "maximized" | "inspectorOpen" | "sidebarOpen">>;

/** A place a tab can show. */
type Folder = Pick<FolderTab, "rootSlug" | "logicalPath">;

export type AppKind = "settings" | "tasks" | "shares" | "trash";
export type SettingsSection = "general" | "account" | "apps" | "sync" | "convert" | "locations" | "users" | "groups" | "sso" | "permissions" | "audit" | "compatibility" | "about";

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

type WorkspaceStore = Omit<WorkspaceState, "activeWindowId" | "windows"> & {
  hydrated: boolean;
  windows: FileWindowState[];
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
  openWindow: (folder: Folder) => void;
  /** Opens a folder in a tab of its own, beside the ones the window already has, and shows it. */
  openTab: (id: string, folder: Folder) => void;
  /** Closes a tab; the one beside it is shown in its place. The last tab of a window stays. */
  closeTab: (id: string, tabId: string) => void;
  activateTab: (id: string, tabId: string) => void;
  /** Takes the tab a window is showing somewhere else, with nothing selected there. */
  navigate: (id: string, folder: Folder) => void;
  closeWindow: (id: string) => void;
  focusWindow: (id: string) => void;
  updateWindow: (id: string, patch: WindowPatch) => void;
  updateSidebar: (patch: Partial<WorkspaceState["sidebar"]>) => void;
  updateInspector: (patch: Partial<WorkspaceState["inspector"]>) => void;
  updateShelf: (patch: Partial<WorkspaceState["shelf"]>) => void;
  selectItems: (id: string, items: string[]) => void;
  /** Takes every tab showing a folder, or one inside it, along to where that folder is now. */
  followFolder: (from: FileRef, to: FileRef) => void;
  /** Lets go of items that are no longer where they were, and of what is inside them, in every tab's selection. */
  deselect: (refs: FileRef[]) => void;
  /** The workspace as it is saved, in the shape the server and every other client read. */
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
function fitGeometry<T extends Placement>(window: T): T {
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

type Stack = { windows: FileWindowState[]; appWindows: Array<AppWindow | ExternalWindow>; previewWindows: PreviewWindow[] };

const frames = (stack: Stack): Placement[] => [...stack.windows, ...stack.appWindows, ...stack.previewWindows];

/** The window in front among those not put away. It is the one with the focus. */
const frontmost = (stack: Stack) => frames(stack).filter((window) => !window.minimized).sort((a, b) => b.zIndex - a.zIndex)[0];

/** The window with the focus: the one in front, or none when every window is put away. */
export const activeWindowId = (stack: Stack) => frontmost(stack)?.id ?? null;

/** Whether a window has the focus, for drawing it as the one that does. */
export const useFocused = (id: string) => useWorkspaceStore((state) => activeWindowId(state) === id);

const topZ = (stack: Stack) => Math.max(fileWindowZBase - 1, ...frames(stack).map((window) => window.zIndex));

/**
 * Renumbers z-indexes from the base across file, app and preview windows, optionally raising one
 * to the front, so they never drift past the window layer.
 */
function restack(stack: Stack, frontId?: string | null): Stack {
  const order = frames(stack)
    .sort((a, b) => Number(a.id === frontId) - Number(b.id === frontId) || a.zIndex - b.zIndex || a.createdAt - b.createdAt)
    .map((window) => window.id);
  const apply = <T extends Placement>(window: T): T => {
    const zIndex = Math.min(fileWindowZLimit, fileWindowZBase + order.indexOf(window.id));
    return zIndex === window.zIndex ? window : { ...window, zIndex };
  };
  return { windows: keep(stack.windows, apply), appWindows: keep(stack.appWindows, apply), previewWindows: keep(stack.previewWindows, apply) };
}

/** Maps a list, and keeps the list itself when nothing in it changed, so autosave does not see a phantom change. */
function keep<T>(list: T[], change: (entry: T) => T): T[] {
  const next = list.map(change);
  return next.some((entry, index) => entry !== list[index]) ? next : list;
}

/** What each location is called. A window is named after the folder it shows, and the top of a location goes by the location's name. */
let rootNames = new Map<string, string>();
/** Bumped when the names change, so a saved title is worked out again. */
let namesVersion = 0;

export function setRootNames(roots: Root[]) {
  const next = new Map(roots.map((root) => [root.slug, root.name]));
  if (next.size === rootNames.size && [...next].every(([slug, name]) => rootNames.get(slug) === name)) return;
  rootNames = next;
  namesVersion += 1;
}

/** The name a folder goes by on a title bar or a tab. */
export const folderTitle = (rootSlug: string, logicalPath: string) => (logicalPath === "/" ? "" : baseName(logicalPath)) || rootNames.get(rootSlug) || rootSlug;

const newTab = (folder: Folder, selectedItems: string[] = []): FolderTab => ({ id: `tab_${randomId()}`, rootSlug: folder.rootSlug, logicalPath: folder.logicalPath, selectedItems });

/** The tab a window is showing. */
const shownTab = (window: Pick<FileWindowState, "tabs" | "activeTabId">) => window.tabs.find((tab) => tab.id === window.activeTabId)!;

/** A window with one of its tabs changed. */
function withTab(window: FileWindowState, tabId: string, change: (tab: FolderTab) => FolderTab): FileWindowState {
  const tabs = keep(window.tabs, (tab) => (tab.id === tabId ? change(tab) : tab));
  return tabs === window.tabs ? window : { ...window, tabs };
}

/**
 * Reads a window as it was saved. The folder written on the window is the one every client showed, so it is the
 * active tab's, even where a client from before tabs moved the window and left its tab behind. A window saved
 * before there were tabs is given the one it is showing.
 */
function loadWindow(saved: SavedFileWindow): FileWindowState {
  const { rootSlug, logicalPath, selectedItems, title: _title, focused: _focused, tabs, activeTabId, ...frame } = saved;
  const shown = { rootSlug, logicalPath, selectedItems: selectedItems ?? [] };
  if (!tabs?.some((tab) => tab.id === activeTabId)) {
    const tab = newTab(shown, shown.selectedItems);
    return { ...frame, tabs: [tab], activeTabId: tab.id };
  }
  return {
    ...frame,
    tabs: tabs.map((tab) => (tab.id === activeTabId ? { id: tab.id, ...shown } : { id: tab.id, rootSlug: tab.rootSlug, logicalPath: tab.logicalPath, selectedItems: tab.selectedItems ?? [] })),
    activeTabId: activeTabId!
  };
}

/** Writes a window the way it has always been saved, so clients that read the window's own fields see what it shows. */
function saveWindow(window: FileWindowState, focused: boolean): SavedFileWindow {
  const { tabs, activeTabId, ...frame } = window;
  const shown = shownTab(window);
  return {
    ...frame,
    rootSlug: shown.rootSlug,
    logicalPath: shown.logicalPath,
    title: folderTitle(shown.rootSlug, shown.logicalPath),
    focused,
    selectedItems: shown.selectedItems,
    tabs: tabs.map(({ selectedItems, ...tab }) => (tab.id === activeTabId ? tab : { ...tab, selectedItems })),
    activeTabId
  };
}

let saved: { windows: FileWindowState[]; activeWindowId: string | null; namesVersion: number; result: SavedFileWindow[] } | null = null;

/** The saved form of the windows, the same list for as long as nothing in it changed. */
function savedWindows(windows: FileWindowState[], activeWindowId: string | null) {
  if (saved?.windows !== windows || saved.activeWindowId !== activeWindowId || saved.namesVersion !== namesVersion) {
    saved = { windows, activeWindowId, namesVersion, result: windows.map((window) => saveWindow(window, window.id === activeWindowId)) };
  }
  return saved.result;
}

const views = new WeakMap<FileWindowState, FileWindow>();
let lastViews: { windows: FileWindowState[]; result: FileWindow[] } | null = null;

/** A file window as it is read, the same object for as long as the window is unchanged. */
function view(window: FileWindowState): FileWindow {
  let read = views.get(window);
  if (!read) {
    const { rootSlug, logicalPath, selectedItems } = shownTab(window);
    read = { ...window, rootSlug, logicalPath, selectedItems };
    views.set(window, read);
  }
  return read;
}

/** Every file window as it is read. */
export function fileWindows(state: Pick<Stack, "windows">): FileWindow[] {
  if (lastViews?.windows !== state.windows) lastViews = { windows: state.windows, result: state.windows.map(view) };
  return lastViews.result;
}

/** The file window with the focus, unless it is put away or the focus is on another kind of window. */
export function activeFileWindow(state: Stack): FileWindow | undefined {
  const id = activeWindowId(state);
  return fileWindows(state).find((window) => window.id === id);
}

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
  const focused = activeWindowId(store);
  for (const id of ids) {
    ghostWindowOut(id, "minimize");
    store.updateWindow(id, { minimized: true });
  }
  useWorkspaceStore.setState((state) => {
    if (!focused || !ids.includes(focused)) return state;
    // The window that takes the focus is raised over any put away, so it is the one in front when they come back.
    return restack(state, frontmost(state)?.id ?? null);
  });
}

export const useWorkspaceStore = create<WorkspaceStore>((set, get) => {
  /** Changes one file window. */
  const editWindow = (id: string, change: (window: FileWindowState) => FileWindowState) =>
    set((state) => {
      const windows = keep(state.windows, (window) => (window.id === id ? change(window) : window));
      return windows === state.windows ? state : { windows };
    });

  return {
    hydrated: false,
    windows: [],
    sidebar: { collapsed: false },
    inspector: { open: false, width: 300 },
    shelf: { collapsed: false },
    appWindows: [],
    previewWindows: [],
    hydrate: (workspace) =>
      set((state) => {
        // A remote update only describes file windows; an app or preview window keeps focus, and stays in front, if it had it.
        const local = frontmost(state);
        const appFocused = local !== undefined && !state.windows.some((window) => window.id === local.id);
        const windows = workspace.windows.map((window) => fitGeometry(loadWindow(window)));
        // The window in front when it was saved may have been one that is not saved (settings, a preview). The desktop
        // does not come back with nothing in front for that: the file window that was on top takes its place.
        const onTop = windows.filter((window) => !window.minimized).sort((a, b) => b.zIndex - a.zIndex)[0];
        const focus = appFocused ? local.id : (workspace.activeWindowId ?? onTop?.id ?? null);
        return {
          sidebar: workspace.sidebar,
          inspector: workspace.inspector,
          shelf: workspace.shelf,
          ...restack({ windows, appWindows: state.appWindows, previewWindows: state.previewWindows }, focus),
          hydrated: true
        };
      }),
    refitWindows: () =>
      set((state) => {
        const refit = <T extends Placement>(window: T): T => {
          const next = fitGeometry(window);
          return next.x === window.x && next.y === window.y && next.width === window.width && next.height === window.height ? window : next;
        };
        const windows = keep(state.windows, refit);
        const appWindows = keep(state.appWindows, refit);
        const previewWindows = keep(state.previewWindows, refit);
        return windows !== state.windows || appWindows !== state.appWindows || previewWindows !== state.previewWindows ? { windows, appWindows, previewWindows } : state;
      }),
    openRoot: (root) => {
      const existing = get().windows.find((window) => shownTab(window).rootSlug === root.slug);
      if (existing) {
        get().updateWindow(existing.id, { minimized: false });
        get().focusWindow(existing.id);
        return;
      }
      get().openWindow({ rootSlug: root.slug, logicalPath: "/" });
    },
    openWindow: (folder) => {
      if (get().windows.length >= MAX_WINDOWS) {
        toast(t("That’s the most windows you can have open"), "error");
        return;
      }
      set((state) => {
        const id = `win_${randomId()}`;
        const tab = newTab(folder);
        const window: FileWindowState = {
          id,
          tabs: [tab],
          activeTabId: tab.id,
          ...initialGeometry(frames(state).length),
          zIndex: topZ(state) + 1,
          minimized: false,
          maximized: false,
          createdAt: ts(),
          updatedAt: ts()
        };
        return restack({ ...state, windows: [...state.windows, window] }, id);
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
              { id, app, section: section ?? "general", title: meta.title, ...initialGeometry(frames(state).length, meta.width, meta.height), zIndex: topZ(state) + 1, minimized: false, maximized: false, createdAt: ts() }
            ];
        return restack({ ...state, appWindows }, id);
      }),
    openExternal: (app) =>
      set((state) => {
        const id = `app_external_${app.id}`;
        const appWindows = state.appWindows.some((window) => window.id === id)
          ? state.appWindows.map((window) => (window.id === id && window.app === "external" ? { ...window, minimized: false, title: app.name, external: app } : window))
          : [
              ...state.appWindows,
              { id, app: "external" as const, external: app, title: app.name, ...initialGeometry(frames(state).length, 1040, 720), zIndex: topZ(state) + 1, minimized: false, maximized: false, createdAt: ts() }
            ];
        return restack({ ...state, appWindows }, id);
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
              { id, preview: { rootSlug, item }, title: item.name, ...initialGeometry(frames(state).length, 760, 560), zIndex: topZ(state) + 1, minimized: false, maximized: false, createdAt: ts() }
            ];
        return restack({ ...state, previewWindows }, id);
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
        const focused = activeWindowId(state);
        const stack = {
          windows: state.windows.filter((window) => window.id !== id),
          appWindows: state.appWindows.filter((window) => window.id !== id),
          previewWindows: state.previewWindows.filter((window) => window.id !== id)
        };
        return focused === id ? restack(stack, frontmost(stack)?.id ?? null) : stack;
      }),
    focusWindow: (id) =>
      set((state) => {
        const current = frames(state).find((window) => window.id === id);
        if (!current || current.zIndex === topZ(state)) return state;
        return restack(state, id);
      }),
    openTab: (id, folder) =>
      editWindow(id, (window) => {
        if (window.tabs.length >= MAX_TABS) {
          toast(t("That’s the most tabs a window can have"), "error");
          return window;
        }
        const tab = newTab(folder);
        // A new tab opens next to the one it was opened from.
        const at = window.tabs.findIndex((entry) => entry.id === window.activeTabId) + 1;
        return { ...window, tabs: [...window.tabs.slice(0, at), tab, ...window.tabs.slice(at)], activeTabId: tab.id, updatedAt: ts() };
      }),
    closeTab: (id, tabId) =>
      editWindow(id, (window) => {
        const index = window.tabs.findIndex((tab) => tab.id === tabId);
        if (index === -1 || window.tabs.length < 2) return window;
        const tabs = window.tabs.filter((tab) => tab.id !== tabId);
        const activeTabId = window.activeTabId === tabId ? tabs[Math.min(index, tabs.length - 1)]!.id : window.activeTabId;
        return { ...window, tabs, activeTabId, updatedAt: ts() };
      }),
    activateTab: (id, tabId) =>
      editWindow(id, (window) => (window.activeTabId !== tabId && window.tabs.some((tab) => tab.id === tabId) ? { ...window, activeTabId: tabId, updatedAt: ts() } : window)),
    navigate: (id, folder) =>
      editWindow(id, (window) => ({ ...withTab(window, window.activeTabId, (tab) => ({ ...tab, rootSlug: folder.rootSlug, logicalPath: folder.logicalPath, selectedItems: [] })), updatedAt: ts() })),
    updateWindow: (id, patch) =>
      set((state) => ({
        windows: state.windows.map((window) => (window.id === id ? { ...window, ...patch, updatedAt: ts() } : window)),
        // App and preview windows only take frame changes (move, resize, minimize, maximize).
        appWindows: state.appWindows.some((window) => window.id === id) ? state.appWindows.map((window) => (window.id === id ? { ...window, ...patch } : window)) : state.appWindows,
        previewWindows: state.previewWindows.some((window) => window.id === id) ? state.previewWindows.map((window) => (window.id === id ? { ...window, ...patch } : window)) : state.previewWindows
      })),
    updateSidebar: (patch) => set((state) => ({ sidebar: { ...state.sidebar, ...patch } })),
    updateInspector: (patch) => set((state) => ({ inspector: { ...state.inspector, ...patch } })),
    updateShelf: (patch) => set((state) => ({ shelf: { ...state.shelf, ...patch } })),
    selectItems: (id, items) => editWindow(id, (window) => withTab(window, window.activeTabId, (tab) => ({ ...tab, selectedItems: items }))),
    followFolder: (from, to) =>
      set((state) => {
        const moved = (rootSlug: string, path: string) => (rootSlug === from.rootSlug && isWithin(path, from.path) ? to.path + path.slice(from.path.length) : null);
        const windows = keep(state.windows, (window) => {
          const tabs = keep(window.tabs, (tab) => {
            const path = moved(tab.rootSlug, tab.logicalPath);
            if (path === null) return tab;
            // What it had selected is inside the folder too, and stays selected where it now is.
            return { ...tab, rootSlug: to.rootSlug, logicalPath: path, selectedItems: tab.selectedItems.map((item) => moved(tab.rootSlug, item) ?? item) };
          });
          return tabs === window.tabs ? window : { ...window, tabs, updatedAt: ts() };
        });
        return windows === state.windows ? state : { windows };
      }),
    deselect: (refs) =>
      set((state) => {
        const kept = (tab: FolderTab): FolderTab => {
          const rest = tab.selectedItems.filter((path) => !refs.some((ref) => ref.rootSlug === tab.rootSlug && isWithin(path, ref.path)));
          return rest.length < tab.selectedItems.length ? { ...tab, selectedItems: rest } : tab;
        };
        const windows = keep(state.windows, (window) => {
          const tabs = keep(window.tabs, kept);
          return tabs === window.tabs ? window : { ...window, tabs };
        });
        return windows === state.windows ? state : { windows };
      }),
    snapshot: () => {
      const state = get();
      // Only file windows are persisted, so an active app window is saved as "none".
      const focused = activeWindowId(state);
      const activeId = state.windows.some((window) => window.id === focused) ? focused : null;
      return { activeWindowId: activeId, windows: savedWindows(state.windows, activeId), sidebar: state.sidebar, inspector: state.inspector, shelf: state.shelf };
    }
  };
});
