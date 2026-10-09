import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, Ban, CircleUserRound, ClipboardPaste, Copy, Download, ExternalLink, Folder, FolderOpen, FolderPlus, FolderUp, Inbox, Info, PanelTop, Pencil, Play, Plus, RefreshCw, Scissors, SquareArrowOutUpRight, Trash2, Upload, Wallpaper } from "lucide-react";
import { useFileList, useFolderContents } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoContextMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { Button } from "@/components/ui/button";
import { chooseAvatar } from "@/features/auth/AvatarDialog";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { OPEN_ITEM_EVENT } from "@/features/workspace/useShortcuts";
import { formatSize, isCueSheet, isMusicFile, isPicture, isVideoType } from "@/lib/format";
import { nfc, parentPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { droppedTree, flatTree, pickedFolderTree } from "@/lib/uploadTree";
import { cn } from "@/lib/utils";
import { useClipboardStore } from "@/stores/clipboard";
import { useRecentStore } from "@/stores/recent";
import { setWallpaper } from "@/stores/settings";
import { toast } from "@/stores/toast";
import { folderTitle, useWorkspaceStore } from "@/stores/workspace";
import type { FileItem, FileWindow, FolderView, FolderWindow, Root } from "@/types/kago";
import { FileIcon, isArchive } from "./FileIcon";
import { fileViews, indexesInArea, revealIndex, useFileLayout, type FileTree } from "./fileLayout";
import { FileColumns, FileList, type FileColumn } from "./FileList";
import { FileToolbar } from "./FileToolbar";
import { useFolderView } from "./folderView";
import { Inspector } from "./Inspector";
import { Sidebar } from "./Sidebar";
import { TabStrip } from "./TabStrip";
import { readDraggedFiles, useFileActions, type FileRef } from "./useFileActions";
import { useMarqueeSelection } from "./useMarqueeSelection";
import { videoPageUrl } from "./VideoPage";
import { classifyFileWindowError, WindowErrorState } from "./WindowErrorState";
import { t } from "@/lib/i18n";

// A shared collator sorts a folder of tens of thousands of names far faster than localeCompare does.
/** The icon of a window showing a folder. */
const FOLDER = { kind: "folder", type: "", name: "" } as const;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compare = (a: string, b: string) => collator.compare(a, b);

function sortItems(items: FileItem[], sortBy: FolderView["sortBy"], direction: FolderView["sortDirection"]) {
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    // Folders stay grouped first, like Finder and File Station, whatever the sort column.
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const primary = sortBy === "size" ? a.size - b.size : sortBy === "mtime" ? a.mtime - b.mtime : sortBy === "type" ? compare(a.type, b.type) : compare(a.name, b.name);
    return (primary || compare(a.name, b.name)) * sign;
  });
}

/** A place a window has been: back and forward go between them, across locations too. */
type Place = { rootSlug: string; path: string };

const isInside = (path: string, folder: string) => (folder === "/" ? path !== "/" : path.startsWith(`${folder}/`));

export function FileWindowView({ window: frame, roots, isAdmin }: { window: FileWindow; roots: Root[]; isAdmin: boolean }) {
  const store = useWorkspaceStore.getState;
  const rootName = roots.find((root) => root.slug === frame.rootSlug)?.name ?? frame.rootSlug;
  const fileList = useFileList(frame.rootSlug, frame.logicalPath);
  // The folder says how it is shown; the window only shows it.
  const folderView = useFolderView(frame.rootSlug, frame.logicalPath, fileList.data?.items);
  const win = useMemo<FolderWindow>(() => ({ ...frame, ...folderView.view }), [frame, folderView.view]);
  const actions = useFileActions(win);
  const uploadInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [menuItem, setMenuItem] = useState<FileItem | null>(null);
  // What is being held over the window: files from outside the browser, which would be uploaded, or items of Kago's own.
  const [dropActive, setDropActive] = useState<false | "files" | "items">(false);
  const [dropChoice, setDropChoice] = useState<{ sources: FileRef[]; destination: FileRef; x: number; y: number } | null>(null);
  const clip = useClipboardStore((state) => state.clip);
  // Every tab has been to places of its own.
  const tabId = win.activeTabId ?? "";
  const [histories, setHistories] = useState<Record<string, { stack: Place[]; index: number }>>({});
  const history = histories[tabId] ?? { stack: [], index: -1 };
  const place = history.stack[history.index];

  // Record every change of place (breadcrumb, sidebar, shortcut, double-click) unless it came from back/forward.
  if (place?.rootSlug !== win.rootSlug || place.path !== win.logicalPath) {
    const stack = [...history.stack.slice(0, history.index + 1), { rootSlug: win.rootSlug, path: win.logicalPath }];
    setHistories({ ...histories, [tabId]: { stack, index: stack.length - 1 } });
  }

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Folders open in place in the list view only, and a search looks through the window's own folder.
  const showsTree = win.viewMode === "list" && !search.trim();
  const inColumns = win.viewMode === "columns";
  const lastSelected = win.selectedItems.at(-1);
  // In the column view the selection says how far in the columns go: every folder between the window's own and the one the selection is in.
  const trail = useMemo(() => {
    const folders: string[] = [];
    if (!inColumns || search.trim() || !lastSelected || !isInside(lastSelected, win.logicalPath)) return folders;
    for (let path = parentPath(lastSelected); path !== win.logicalPath && path !== "/"; path = parentPath(path)) folders.unshift(path);
    return folders;
  }, [inColumns, search, lastSelected, win.logicalPath]);
  const expandedPaths = useMemo(() => (showsTree ? [...expanded] : trail), [showsTree, expanded, trail]);
  const expandedContents = useFolderContents(win.rootSlug, expandedPaths);

  const error = classifyFileWindowError(fileList.error);
  const readonly = Boolean(fileList.data?.readonly);
  const allItems = useMemo(() => sortItems(fileList.data?.items ?? [], win.sortBy, win.sortDirection), [fileList.data, win.sortBy, win.sortDirection]);
  // What the window's own folder lists, with the folders opened in place in the list view.
  const { items: listed, depths } = useMemo(() => {
    const query = nfc(search.trim()).toLocaleLowerCase();
    if (query) return { items: allItems.filter((item) => item.name.toLocaleLowerCase().includes(query)), depths: [] };
    if (!showsTree || expandedPaths.length === 0) return { items: allItems, depths: [] };
    // Each open folder is followed by its own contents, sorted like the rest and one level further in.
    const contents = new Map(expandedPaths.map((path, index) => [path, expandedContents[index]]));
    const items: FileItem[] = [];
    const depths: number[] = [];
    const walk = (list: FileItem[], depth: number) => {
      for (const item of list) {
        items.push(item);
        depths.push(depth);
        const inside = item.kind === "folder" ? contents.get(item.path) : undefined;
        if (inside) walk(sortItems(inside, win.sortBy, win.sortDirection), depth + 1);
      }
    };
    walk(allItems, 0);
    return { items, depths };
  }, [allItems, search, showsTree, expandedPaths, expandedContents, win.sortBy, win.sortDirection]);

  // The columns down to the folder the selection is in. A folder that is no longer where the selection says ends them.
  const columnsAbove = useMemo(() => {
    if (!inColumns) return null;
    const columns: FileColumn[] = [{ folder: win.logicalPath, items: listed }];
    for (const [index, folder] of trail.entries()) {
      const before = columns.at(-1)!.items;
      if (before && !before.some((item) => item.path === folder && item.kind === "folder")) break;
      const inside = expandedContents[index];
      columns.push({ folder, items: inside && sortItems(inside, win.sortBy, win.sortDirection) });
    }
    return columns;
  }, [inColumns, win.logicalPath, listed, trail, expandedContents, win.sortBy, win.sortDirection]);
  // A folder selected by itself opens one more column, for what it holds.
  const deepest = columnsAbove?.at(-1);
  const opened = columnsAbove && win.selectedItems.length === 1 && columnsAbove.length === trail.length + 1 ? deepest?.items?.find((item) => item.path === lastSelected && item.kind === "folder")?.path : undefined;
  const openedList = useFileList(win.rootSlug, opened ?? win.logicalPath, Boolean(opened));
  const columns = useMemo(
    () => (columnsAbove && opened ? [...columnsAbove, { folder: opened, items: openedList.data ? sortItems(openedList.data.items, win.sortBy, win.sortDirection) : openedList.isError ? [] : undefined }] : columnsAbove),
    [columnsAbove, opened, openedList.data, openedList.isError, win.sortBy, win.sortDirection]
  );
  /** The column the selection is in, which is the one the keyboard moves through. */
  const activeColumn = columns && lastSelected ? Math.max(0, columns.findIndex((column) => column.folder === parentPath(lastSelected))) : 0;
  const columnReveal = useRef<Array<((index: number) => void) | undefined>>([]);
  const items = columns ? columns[activeColumn]?.items ?? listed : listed;
  const selectedItems = useMemo(() => {
    const selected = new Set(win.selectedItems);
    return (search.trim() ? allItems : items).filter((item) => selected.has(item.path));
  }, [allItems, items, search, win.selectedItems]);
  const selectedPaths = selectedItems.map((item) => item.path);
  // What the folder holds, for the status bar: how many of each, and how much the files weigh.
  const summary = useMemo(() => {
    const files = allItems.filter((item) => item.kind === "file");
    const folders = allItems.length - files.length;
    if (allItems.length === 0) return t("{count} item | {count} items", { count: 0 });
    const counts = [folders > 0 ? t("{count} folder | {count} folders", { count: folders }) : null, files.length > 0 ? t("{count} file | {count} files", { count: files.length }) : null].filter(Boolean).join(t(", "));
    return files.length > 0 ? `${counts} · ${formatSize(files.reduce((total, item) => total + item.size, 0))}` : counts;
  }, [allItems]);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const layout = useFileLayout(scroller, win.viewMode, win.iconSize);
  const marquee = useMarqueeSelection(win.id, (area) => indexesInArea(layout, listed.length, area).map((index) => listed[index]!.path));

  useEffect(() => {
    if (fileList.data) useRecentStore.getState().visit({ rootSlug: win.rootSlug, path: win.logicalPath });
  }, [fileList.data, win.rootSlug, win.logicalPath]);

  useEffect(() => {
    setSearch("");
    setExpanded(new Set());
  }, [win.logicalPath, win.rootSlug]);

  // Coming back to a folder (back, forward, up, or its tab) shows it scrolled to where it was left; going anywhere else starts at the top.
  const scrollTops = useRef(new Map<string, number>());
  const scrollPlace = useRef<{ key: string; tabId: string; rootSlug: string; path: string } | null>(null);
  const scrollRestore = useRef<number | null>(null);
  const viaHistory = useRef(false);
  const scrollKey = `${tabId}\n${win.rootSlug}\n${win.logicalPath}`;
  const listReady = Boolean(fileList.data);

  useLayoutEffect(() => {
    const left = scrollPlace.current;
    if (left?.key !== scrollKey) {
      const returning = viaHistory.current || (left !== null && (left.tabId !== tabId || (left.rootSlug === win.rootSlug && isInside(left.path, win.logicalPath))));
      viaHistory.current = false;
      scrollPlace.current = { key: scrollKey, tabId, rootSlug: win.rootSlug, path: win.logicalPath };
      scrollRestore.current = (returning ? scrollTops.current.get(scrollKey) : undefined) ?? 0;
    }
    // The list has to be there before it can be scrolled.
    if (scrollRestore.current === null || !scroller || !listReady) return;
    scroller.scrollTop = scrollRestore.current;
    scrollRestore.current = null;
    // Tells the list which rows to render before the next paint, rather than a frame later.
    scroller.dispatchEvent(new Event("scroll"));
  }, [scrollKey, tabId, win.rootSlug, win.logicalPath, scroller, listReady]);

  useEffect(() => {
    if (!scroller) return;
    // A folder that is still loading has nothing to scroll, which must not count as having been scrolled to the top.
    const remember = () => scrollRestore.current === null && scrollPlace.current && scrollTops.current.set(scrollPlace.current.key, scroller.scrollTop);
    scroller.addEventListener("scroll", remember, { passive: true });
    return () => scroller.removeEventListener("scroll", remember);
  }, [scroller]);

  const tree = useMemo<FileTree | undefined>(() => {
    if (!showsTree) return undefined;
    return {
      depths,
      expanded,
      setExpanded(path, open) {
        setExpanded((previous) => {
          const next = new Set(previous);
          if (open) next.add(path);
          else next.delete(path);
          return next;
        });
        // What a closing folder hides cannot stay selected.
        const selection = store().windows.find((entry) => entry.id === win.id)?.selectedItems ?? [];
        if (!open && selection.some((selected) => selected.startsWith(`${path}/`))) store().selectItems(win.id, selection.filter((selected) => !selected.startsWith(`${path}/`)));
      }
    };
  }, [showsTree, depths, expanded, win.id]);

  // A window that lost access must not keep showing what it had selected.
  useEffect(() => {
    if (error?.kind === "forbidden" && win.selectedItems.length > 0) store().selectItems(win.id, []);
  }, [error?.kind, win.id, win.selectedItems.length]);

  useEffect(() => {
    const onOpenItem = (event: Event) => {
      const detail = (event as CustomEvent<{ windowId: string; path: string }>).detail;
      const item = detail.windowId === win.id ? items.find((entry) => entry.path === detail.path) : undefined;
      if (item) store().openPreview(win.rootSlug, item);
    };
    globalThis.addEventListener(OPEN_ITEM_EVENT, onOpenItem);
    return () => globalThis.removeEventListener(OPEN_ITEM_EVENT, onOpenItem);
  }, [items, win.id, win.rootSlug]);

  // Keyboard shortcuts act on what the window lists, which is more than what is rendered.
  const hasError = Boolean(error);
  useEffect(() => {
    if (hasError) fileViews.set(win.id, { items: [], reveal: () => undefined });
    else if (!columns) fileViews.set(win.id, { items, reveal: (index) => scroller && revealIndex(scroller, layout, index), tree });
    else {
      const select = (column: number, item: FileItem | undefined) => {
        if (!item) return;
        store().selectItems(win.id, [item.path]);
        columnReveal.current[column]?.(columns[column]!.items!.indexOf(item));
      };
      fileViews.set(win.id, {
        items,
        reveal: (index) => columnReveal.current[activeColumn]?.(index),
        columns: {
          // Left steps out to the folder this column was opened from; right steps into the one selected.
          left: () => select(activeColumn - 1, columns[activeColumn - 1]?.items?.find((item) => item.path === columns[activeColumn]!.folder)),
          right: () => opened && select(activeColumn + 1, columns[activeColumn + 1]?.items?.[0])
        }
      });
    }
    return () => void fileViews.delete(win.id);
  }, [win.id, items, hasError, scroller, layout, tree, columns, activeColumn, opened]);

  const navigate = (logicalPath: string, rootSlug = win.rootSlug) => store().updateWindow(win.id, { rootSlug, logicalPath, selectedItems: [] });
  const goTo = useCallback((folder: Place) => useWorkspaceStore.getState().updateWindow(frame.id, { rootSlug: folder.rootSlug, logicalPath: folder.path, selectedItems: [] }), [frame.id]);

  function go(delta: -1 | 1) {
    const index = history.index + delta;
    const target = history.stack[index];
    if (target === undefined) return;
    setHistories({ ...histories, [tabId]: { ...history, index } });
    viaHistory.current = true;
    navigate(target.path, target.rootSlug);
  }

  function openItem(item: FileItem, where?: "window" | "tab") {
    if (item.kind === "file") store().openPreview(win.rootSlug, item);
    else if (where === "window") store().openWindow({ rootSlug: win.rootSlug, logicalPath: item.path, title: item.name });
    else if (where === "tab") store().openTab(win.id, { rootSlug: win.rootSlug, logicalPath: item.path });
    else navigate(item.path);
  }

  /** `among` is the list the item was clicked in: the window's, or in the column view that of one column. */
  function selectItem(event: React.MouseEvent, item: FileItem, among = items) {
    const paths = among.map((entry) => entry.path);
    if (event.shiftKey && anchorPath && paths.includes(anchorPath)) {
      const [from, to] = [paths.indexOf(anchorPath), paths.indexOf(item.path)].sort((a, b) => a - b);
      store().selectItems(win.id, paths.slice(from, to! + 1));
      return;
    }
    setAnchorPath(item.path);
    if (event.metaKey || event.ctrlKey) {
      // A selection never spans two columns: adding to it from another column starts over there.
      const listedHere = new Set(paths);
      const current = win.selectedItems.filter((path) => listedHere.has(path));
      store().selectItems(win.id, current.includes(item.path) ? current.filter((path) => path !== item.path) : [...current, item.path]);
    } else {
      store().selectItems(win.id, [item.path]);
    }
  }

  function onContextItem(item: FileItem) {
    setMenuItem(item);
    if (!win.selectedItems.includes(item.path)) {
      store().selectItems(win.id, [item.path]);
      setAnchorPath(item.path);
    }
  }

  /**
   * Handles a drop on the window (its current folder), on one of the folders listed in it, or on a folder in the
   * sidebar. Only the sidebar names a location: its folders may be anywhere, and whether one can be written to is
   * for the server to say, not for the folder this window happens to show.
   */
  function dropInto(event: React.DragEvent, path: string, rootSlug?: string) {
    event.preventDefault();
    setDropActive(false);
    if (rootSlug === undefined && (readonly || error)) return;
    const destination = { rootSlug: rootSlug ?? win.rootSlug, path };
    const dropped = droppedTree(event.dataTransfer);
    if (dropped) {
      void actions.upload(dropped, destination.path, destination.rootSlug);
      return;
    }
    // Dropping items onto the folder they already live in, or a folder onto itself, is a no-op.
    const sources = readDraggedFiles(event.dataTransfer).filter((source) => source.rootSlug !== destination.rootSlug || (parentPath(source.path) !== path && source.path !== path));
    const rect = event.currentTarget.closest("[data-window]")?.getBoundingClientRect();
    if (sources.length === 0 || !rect) return;
    setDropChoice({ sources, destination, x: Math.min(event.clientX - rect.left, rect.width - 180), y: Math.min(event.clientY - rect.top, rect.height - 130) });
  }

  // Right-clicking acts on the whole selection when the clicked item is part of it.
  const menuTargets = menuItem && selectedItems.some((item) => item.path === menuItem.path) ? selectedItems : menuItem ? [menuItem] : [];

  /** Every action for a set of items, or for the folder itself when there are none. Shared by right click and the toolbar. */
  function renderMenu(targets: FileItem[]) {
    const paths = targets.map((item) => item.path);
    const single = targets.length === 1 ? targets[0]! : null;
    const count = targets.length;
    // Video and music open in a player, so the menu says what opening them does.
    const playable = single?.kind === "file" && (isVideoType(single.type) || isMusicFile(single) || isCueSheet(single));
    return targets.length > 0 ? (
      <>
        {single ? <KagoMenuItem icon={playable ? <Play /> : <FolderOpen />} shortcut="↩" onClick={() => openItem(single)}>{playable ? t("Play") : t("Open")}</KagoMenuItem> : null}
        {single?.kind === "folder" ? <KagoMenuItem icon={<PanelTop />} onClick={() => openItem(single, "tab")}>{t("Open in new tab")}</KagoMenuItem> : null}
        {single?.kind === "folder" ? <KagoMenuItem icon={<ExternalLink />} onClick={() => openItem(single, "window")}>{t("Open in new window")}</KagoMenuItem> : null}
        {single?.kind === "file" && isVideoType(single.type) ? (
          <KagoMenuItem icon={<SquareArrowOutUpRight />} onClick={() => globalThis.open(videoPageUrl(win.rootSlug, single.path), "_blank", "noopener")}>{t("Play in new tab")}</KagoMenuItem>
        ) : null}
        <KagoMenuItem icon={<Download />} onClick={() => void actions.download(targets)}>{count > 1 ? t("Download {count} item | Download {count} items", { count }) : t("Download")}</KagoMenuItem>
        <KagoMenuItem icon={<Inbox />} onClick={() => void actions.addToShelf(paths)}>{t("Add to Shelf")}</KagoMenuItem>
        <KagoMenuItem icon={<Info />} shortcut="⌘I" onClick={() => store().updateWindow(win.id, { inspectorOpen: true })}>{t("Info, tags and sharing")}</KagoMenuItem>
        {single && isPicture(single) ? (
          <KagoMenuItem
            icon={<Wallpaper />}
            onClick={() =>
              void run(async () => {
                await setWallpaper({ rootSlug: win.rootSlug, path: single.path });
                toast(t("Desktop background set"));
              }, t("Couldn’t set the desktop background"))
            }
          >
            {t("Set as desktop background")}
          </KagoMenuItem>
        ) : null}
        {single && isPicture(single) ? (
          <KagoMenuItem icon={<CircleUserRound />} onClick={() => chooseAvatar(win.rootSlug, single)}>{t("Set as profile picture…")}</KagoMenuItem>
        ) : null}
        <KagoMenuSeparator />
        <KagoMenuItem icon={<Copy />} shortcut="⌘C" onClick={() => actions.copy(paths)}>{t("Copy")}</KagoMenuItem>
        <KagoMenuItem icon={<Scissors />} shortcut="⌘X" disabled={readonly || targets.some((item) => item.readonly)} onClick={() => actions.cut(paths)}>{t("Cut")}</KagoMenuItem>
        {single ? <KagoMenuItem icon={<Pencil />} disabled={readonly || single.readonly} onClick={() => void actions.rename(single)}>{t("Rename")}</KagoMenuItem> : null}
        <KagoMenuItem icon={<Archive />} disabled={readonly} onClick={() => void actions.compress(paths)}>{count > 1 ? t("Compress {count} item | Compress {count} items", { count }) : t("Compress")}</KagoMenuItem>
        {targets.every(isArchive) ? <KagoMenuItem icon={<ArchiveRestore />} disabled={readonly} onClick={() => void actions.extract(paths)}>{t("Extract here")}</KagoMenuItem> : null}
        <KagoMenuSeparator />
        <KagoMenuItem icon={<Trash2 />} destructive disabled={readonly || targets.some((item) => item.readonly)} onClick={() => void actions.trash(paths)}>{t("Move to Trash")}</KagoMenuItem>
      </>
    ) : (
      <>
        <KagoMenuItem icon={<FolderPlus />} disabled={readonly} onClick={() => void actions.newFolder()}>{t("New folder")}</KagoMenuItem>
        <KagoMenuItem icon={<Upload />} disabled={readonly} onClick={() => uploadInput.current?.click()}>{t("Upload files")}</KagoMenuItem>
        <KagoMenuItem icon={<FolderUp />} disabled={readonly} onClick={() => folderInput.current?.click()}>{t("Upload folder")}</KagoMenuItem>
        <KagoMenuItem icon={<ClipboardPaste />} shortcut="⌘V" disabled={readonly || !clip} onClick={() => void actions.paste()}>{clip ? t("Paste {count} item | Paste {count} items", { count: clip.items.length }) : t("Paste")}</KagoMenuItem>
        <KagoMenuSeparator />
        <KagoMenuItem icon={<PanelTop />} shortcut="⌥T" onClick={() => store().openTab(win.id, win)}>{t("New tab")}</KagoMenuItem>
        <KagoMenuItem icon={<ExternalLink />} onClick={() => store().openWindow({ rootSlug: win.rootSlug, logicalPath: win.logicalPath, title: win.title })}>{t("Open this folder in a new window (⌥N)")}</KagoMenuItem>
        <KagoMenuItem icon={<RefreshCw />} shortcut="⌘R" onClick={() => void actions.refresh()}>{t("Refresh")}</KagoMenuItem>
      </>
    );
  }

  return (
    <KagoWindow
      window={win}
      icon={<FileIcon item={FOLDER} />}
      titleBar={(win.tabs?.length ?? 0) > 1 ? <TabStrip window={win} roots={roots} /> : undefined}
      titleExtra={
        <>
          {readonly ? <KagoBadge>{t("Read-only")}</KagoBadge> : null}
          <KagoIconButton label={t("New tab (⌥T)")} className="size-6" onClick={() => store().openTab(win.id, win)}><Plus /></KagoIconButton>
        </>
      }
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(event.dataTransfer.types.includes("Files") ? "files" : "items");
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setDropActive(false)}
      onDrop={(event) => dropInto(event, win.logicalPath)}
    >
      <FileToolbar
        window={win}
        folderView={folderView}
        rootName={rootName}
        readonly={readonly || Boolean(error)}
        canGoBack={history.index > 0}
        canGoForward={history.index < history.stack.length - 1}
        search={search}
        onSearch={setSearch}
        onGo={go}
        onNavigate={(path) => navigate(path)}
        onNewFolder={() => void actions.newFolder()}
        onUpload={() => uploadInput.current?.click()}
        menu={error ? null : renderMenu(selectedItems)}
      />

      <div className="@container/body flex min-h-0 flex-1">
        {win.sidebarOpen === false ? null : <Sidebar window={win} roots={roots} onNavigate={goTo} onDragTarget={() => setDropActive(false)} onDropInto={(event, folder) => dropInto(event, folder.path, folder.rootSlug)} />}
        {error ? (
          <div className="min-h-0 min-w-0 flex-1">
            <WindowErrorState error={error} window={win} onRetry={() => void fileList.refetch()} />
          </div>
        ) : (
          <KagoContextMenu menu={renderMenu(menuTargets)} className="flex min-h-0 min-w-0 flex-1">
            {/* The columns scroll one by one, so there is no one area for a rubber band to be drawn across. */}
            <div ref={setScroller} className={cn("relative min-w-0 flex-1 select-none", columns && listed.length > 0 ? "flex overflow-hidden" : "overflow-auto")} onContextMenuCapture={() => setMenuItem(null)} {...(columns ? {} : marquee.handlers)}>
              {fileList.isLoading ? <KagoLoading /> : null}
              {fileList.data && listed.length === 0 ? (
                <KagoEmptyState
                  className="h-full"
                  icon={<Folder />}
                  title={search ? t("No matching items") : t("This folder is empty")}
                  description={search ? t("Nothing here has “{query}” in its name.", { query: search.trim() }) : readonly ? t("This location is read-only.") : t("Drag files in, or upload from the toolbar.")}
                />
              ) : null}
              {listed.length === 0 ? null : columns ? (
                <FileColumns
                  window={win}
                  columns={columns}
                  revealers={columnReveal}
                  onSelect={(event, item, column) => selectItem(event, item, columns[column]!.items)}
                  onSelectColumn={(column) => store().selectItems(win.id, column === 0 ? [] : [columns[column]!.folder])}
                  onOpen={openItem}
                  onContextItem={onContextItem}
                  onDropInto={readonly ? undefined : dropInto}
                />
              ) : (
                <FileList window={win} items={items} tree={tree} scroller={scroller} layout={layout} onSelect={selectItem} onOpen={openItem} onContextItem={onContextItem} onDropInto={readonly ? undefined : (event, folder) => dropInto(event, folder.path)} />
              )}
              {marquee.style ? <div className="pointer-events-none absolute border border-accent bg-accent/15" style={marquee.style} /> : null}
            </div>
          </KagoContextMenu>
        )}
        {win.inspectorOpen ? <Inspector window={win} isAdmin={isAdmin} /> : null}
      </div>

      <footer className="kago-toolbar flex h-8 shrink-0 items-center gap-1 border-t border-line-strong px-3 text-xs text-muted">
        {selectedItems.length > 0 ? (
          <>
            <span className="min-w-0 flex-1 truncate text-ink">
              {t("{count} selected", { count: selectedItems.length })}
              {selectedItems.every((item) => item.kind === "file") ? ` · ${formatSize(selectedItems.reduce((total, item) => total + item.size, 0))}` : ""}
            </span>
            <KagoIconButton label={t("Download")} className="size-6" onClick={() => void actions.download(selectedItems)}><Download /></KagoIconButton>
            <KagoIconButton label={t("Add to Shelf")} className="size-6" onClick={() => void actions.addToShelf(selectedPaths)}><Inbox /></KagoIconButton>
            <KagoIconButton label={t("Compress")} className="size-6" disabled={readonly} onClick={() => void actions.compress(selectedPaths)}><Archive /></KagoIconButton>
            <KagoIconButton label={t("Move to Trash")} className="size-6" disabled={readonly} onClick={() => void actions.trash(selectedPaths)}><Trash2 /></KagoIconButton>
          </>
        ) : (
          <span className="truncate">{error ? t("Couldn’t load") : search ? t("{count} of {total} items match", { count: items.length, total: allItems.length }) : summary}</span>
        )}
      </footer>

      {dropActive && !error ? (
        <div className={cn("pointer-events-none absolute inset-0 z-20 rounded-[inherit]", !readonly && "ring-2 ring-accent ring-inset")}>
          {/* Files brought from outside are told what letting go will do, or why it will do nothing. */}
          {dropActive === "files" ? (
            <span className="absolute bottom-11 left-1/2 flex h-8 max-w-[calc(100%-24px)] -translate-x-1/2 items-center gap-2 kago-glass rounded-full pr-3.5 pl-3 font-medium whitespace-nowrap">
              {readonly ? <Ban className="text-muted" /> : <Upload className="text-accent" />}
              <span className="truncate">{readonly ? t("This location is read-only.") : t("Drop to upload")}</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {dropChoice ? (
        <>
          <div className="absolute inset-0 z-20" onClick={() => setDropChoice(null)} />
          <div className={cn("absolute z-30 kago-glass flex w-44 flex-col gap-1 rounded-lg p-1.5")} style={{ left: Math.max(8, dropChoice.x), top: Math.max(44, dropChoice.y) }}>
            <span className="truncate px-1.5 py-0.5 text-xs text-muted">
              {t("{count} item | {count} items", { count: dropChoice.sources.length })}{dropChoice.destination.path === win.logicalPath && dropChoice.destination.rootSlug === win.rootSlug ? "" : ` → ${folderTitle(dropChoice.destination.rootSlug, dropChoice.destination.path)}`}
            </span>
            {(["copy", "move"] as const).map((type) => (
              <Button
                key={type}
                variant={type === "copy" ? "default" : "outline"}
                autoFocus={type === "copy"}
                onClick={() => {
                  void actions.transfer(type, dropChoice.sources, dropChoice.destination);
                  setDropChoice(null);
                }}
              >
                {type === "copy" ? t("Copy here") : t("Move here")}
              </Button>
            ))}
            <Button onClick={() => setDropChoice(null)}>{t("Cancel")}</Button>
          </div>
        </>
      ) : null}

      <input
        ref={uploadInput}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          void actions.upload(flatTree(Array.from(event.target.files ?? [])));
          event.target.value = "";
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        {...{ webkitdirectory: "" }}
        onChange={(event) => {
          void actions.upload(pickedFolderTree(Array.from(event.target.files ?? [])));
          event.target.value = "";
        }}
      />
    </KagoWindow>
  );
}
