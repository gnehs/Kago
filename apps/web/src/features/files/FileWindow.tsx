import { useEffect, useMemo, useRef, useState } from "react";
import { Archive, ArchiveRestore, ClipboardPaste, Copy, Download, ExternalLink, Folder, FolderOpen, FolderPlus, FolderUp, Inbox, Info, Pencil, RefreshCw, Scissors, SquareArrowOutUpRight, Trash2, Upload } from "lucide-react";
import { useFileList, useFolderContents } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoContextMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { OPEN_ITEM_EVENT } from "@/features/workspace/useShortcuts";
import { formatSize, isVideoType } from "@/lib/format";
import { baseName, nfc, parentPath } from "@/lib/paths";
import { droppedTree, flatTree, pickedFolderTree } from "@/lib/uploadTree";
import { cn } from "@/lib/utils";
import { useClipboardStore } from "@/stores/clipboard";
import { useRecentStore } from "@/stores/recent";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileItem, FileWindow } from "@/types/kago";
import { FileIcon, isArchive } from "./FileIcon";
import { fileViews, indexesInArea, revealIndex, useFileLayout, type FileTree } from "./fileLayout";
import { FileList } from "./FileList";
import { FileToolbar } from "./FileToolbar";
import { Inspector } from "./Inspector";
import { readDraggedFiles, useFileActions, type FileRef } from "./useFileActions";
import { useMarqueeSelection } from "./useMarqueeSelection";
import { videoPageUrl } from "./VideoPage";
import { classifyFileWindowError, WindowErrorState } from "./WindowErrorState";

// A shared collator sorts a folder of tens of thousands of names far faster than localeCompare does.
/** The icon of a window showing a folder. */
const FOLDER = { kind: "folder", type: "", name: "" } as const;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compare = (a: string, b: string) => collator.compare(a, b);

function sortItems(items: FileItem[], sortBy: FileWindow["sortBy"], direction: FileWindow["sortDirection"]) {
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    // Folders stay grouped first, like Finder and File Station, whatever the sort column.
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const primary = sortBy === "size" ? a.size - b.size : sortBy === "mtime" ? a.mtime - b.mtime : sortBy === "type" ? compare(a.type, b.type) : compare(a.name, b.name);
    return (primary || compare(a.name, b.name)) * sign;
  });
}

export function FileWindowView({ window: win, rootName, isAdmin }: { window: FileWindow; rootName: string; isAdmin: boolean }) {
  const store = useWorkspaceStore.getState;
  const fileList = useFileList(win.rootSlug, win.logicalPath);
  const actions = useFileActions(win);
  const uploadInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
  const [menuItem, setMenuItem] = useState<FileItem | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropChoice, setDropChoice] = useState<{ sources: FileRef[]; destination: string; x: number; y: number } | null>(null);
  const clip = useClipboardStore((state) => state.clip);
  const [history, setHistory] = useState({ stack: [win.logicalPath], index: 0 });

  // Record every path change (breadcrumb, shortcut, double-click) unless it came from back/forward.
  if (history.stack[history.index] !== win.logicalPath) {
    const stack = [...history.stack.slice(0, history.index + 1), win.logicalPath];
    setHistory({ stack, index: stack.length - 1 });
  }

  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  // Folders open in place in the list view only, and a search looks through the window's own folder.
  const showsTree = win.viewMode === "list" && !search.trim();
  const expandedPaths = useMemo(() => (showsTree ? [...expanded] : []), [showsTree, expanded]);
  const expandedContents = useFolderContents(win.rootSlug, expandedPaths);

  const error = classifyFileWindowError(fileList.error);
  const readonly = Boolean(fileList.data?.readonly);
  const allItems = useMemo(() => sortItems(fileList.data?.items ?? [], win.sortBy, win.sortDirection), [fileList.data, win.sortBy, win.sortDirection]);
  const { items, depths } = useMemo(() => {
    const query = nfc(search.trim()).toLocaleLowerCase();
    if (query) return { items: allItems.filter((item) => item.name.toLocaleLowerCase().includes(query)), depths: [] };
    if (expandedPaths.length === 0) return { items: allItems, depths: [] };
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
  }, [allItems, search, expandedPaths, expandedContents, win.sortBy, win.sortDirection]);
  const selectedItems = useMemo(() => {
    const selected = new Set(win.selectedItems);
    return (search.trim() ? allItems : items).filter((item) => selected.has(item.path));
  }, [allItems, items, search, win.selectedItems]);
  const selectedPaths = selectedItems.map((item) => item.path);
  // What the folder holds, for the status bar: how many of each, and how much the files weigh.
  const summary = useMemo(() => {
    const files = allItems.filter((item) => item.kind === "file");
    const folders = allItems.length - files.length;
    if (allItems.length === 0) return "0 個項目";
    const counts = [folders > 0 ? `${folders} 個資料夾` : null, files.length > 0 ? `${files.length} 個檔案` : null].filter(Boolean).join("、");
    return files.length > 0 ? `${counts} · ${formatSize(files.reduce((total, item) => total + item.size, 0))}` : counts;
  }, [allItems]);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const layout = useFileLayout(scroller, win.viewMode, win.iconSize);
  const marquee = useMarqueeSelection(win.id, (area) => indexesInArea(layout, items.length, area).map((index) => items[index]!.path));

  useEffect(() => {
    if (fileList.data) useRecentStore.getState().visit({ rootSlug: win.rootSlug, path: win.logicalPath });
  }, [fileList.data, win.rootSlug, win.logicalPath]);

  useEffect(() => {
    setSearch("");
    setExpanded(new Set());
  }, [win.logicalPath, win.rootSlug]);

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
    fileViews.set(win.id, { items: hasError ? [] : items, reveal: (index) => scroller && revealIndex(scroller, layout, index), tree: hasError ? undefined : tree });
    return () => void fileViews.delete(win.id);
  }, [win.id, items, hasError, scroller, layout, tree]);

  const navigate = (logicalPath: string) => store().updateWindow(win.id, { logicalPath, selectedItems: [] });

  function go(delta: -1 | 1) {
    const index = history.index + delta;
    const target = history.stack[index];
    if (target === undefined) return;
    setHistory({ ...history, index });
    navigate(target);
  }

  function openItem(item: FileItem, newWindow = false) {
    if (item.kind === "file") store().openPreview(win.rootSlug, item);
    else if (newWindow) store().openWindow({ rootSlug: win.rootSlug, logicalPath: item.path, title: item.name });
    else navigate(item.path);
  }

  function selectItem(event: React.MouseEvent, item: FileItem) {
    const paths = items.map((entry) => entry.path);
    if (event.shiftKey && anchorPath && paths.includes(anchorPath)) {
      const [from, to] = [paths.indexOf(anchorPath), paths.indexOf(item.path)].sort((a, b) => a - b);
      store().selectItems(win.id, paths.slice(from, to! + 1));
      return;
    }
    setAnchorPath(item.path);
    if (event.metaKey || event.ctrlKey) {
      store().selectItems(win.id, win.selectedItems.includes(item.path) ? win.selectedItems.filter((path) => path !== item.path) : [...win.selectedItems, item.path]);
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

  /** Handles a drop on the window (its current folder) or on one of the folders listed in it. */
  function dropInto(event: React.DragEvent, destination: string) {
    event.preventDefault();
    setDropActive(false);
    if (readonly || error) return;
    const dropped = droppedTree(event.dataTransfer);
    if (dropped) {
      void actions.upload(dropped, destination);
      return;
    }
    // Dropping items onto the folder they already live in, or a folder onto itself, is a no-op.
    const sources = readDraggedFiles(event.dataTransfer).filter((source) => source.rootSlug !== win.rootSlug || (parentPath(source.path) !== destination && source.path !== destination));
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
    const countSuffix = targets.length > 1 ? ` ${targets.length} 個項目` : "";
    return targets.length > 0 ? (
      <>
        {single ? <KagoMenuItem icon={<FolderOpen />} onClick={() => openItem(single)}>開啟</KagoMenuItem> : null}
        {single?.kind === "folder" ? <KagoMenuItem icon={<ExternalLink />} onClick={() => openItem(single, true)}>在新視窗開啟</KagoMenuItem> : null}
        {single?.kind === "file" && isVideoType(single.type) ? (
          <KagoMenuItem icon={<SquareArrowOutUpRight />} onClick={() => globalThis.open(videoPageUrl(win.rootSlug, single.path), "_blank", "noopener")}>在新分頁中播放</KagoMenuItem>
        ) : null}
        <KagoMenuItem icon={<Download />} onClick={() => void actions.download(targets)}>下載{countSuffix}</KagoMenuItem>
        <KagoMenuItem icon={<Inbox />} onClick={() => void actions.addToShelf(paths)}>加入中轉區</KagoMenuItem>
        <KagoMenuItem icon={<Info />} onClick={() => store().updateWindow(win.id, { inspectorOpen: true })}>資訊、標籤與分享</KagoMenuItem>
        <KagoMenuSeparator />
        <KagoMenuItem icon={<Copy />} onClick={() => actions.copy(paths)}>複製</KagoMenuItem>
        <KagoMenuItem icon={<Scissors />} disabled={readonly || targets.some((item) => item.readonly)} onClick={() => actions.cut(paths)}>剪下</KagoMenuItem>
        {single ? <KagoMenuItem icon={<Pencil />} disabled={readonly || single.readonly} onClick={() => void actions.rename(single)}>重新命名</KagoMenuItem> : null}
        <KagoMenuItem icon={<Archive />} disabled={readonly} onClick={() => void actions.compress(paths)}>壓縮{countSuffix}</KagoMenuItem>
        {targets.every(isArchive) ? <KagoMenuItem icon={<ArchiveRestore />} disabled={readonly} onClick={() => void actions.extract(paths)}>解壓縮到這裡</KagoMenuItem> : null}
        <KagoMenuSeparator />
        <KagoMenuItem icon={<Trash2 />} destructive disabled={readonly || targets.some((item) => item.readonly)} onClick={() => void actions.trash(paths)}>移到垃圾桶</KagoMenuItem>
      </>
    ) : (
      <>
        <KagoMenuItem icon={<FolderPlus />} disabled={readonly} onClick={() => void actions.newFolder()}>新增資料夾</KagoMenuItem>
        <KagoMenuItem icon={<Upload />} disabled={readonly} onClick={() => uploadInput.current?.click()}>上傳檔案</KagoMenuItem>
        <KagoMenuItem icon={<FolderUp />} disabled={readonly} onClick={() => folderInput.current?.click()}>上傳資料夾</KagoMenuItem>
        <KagoMenuItem icon={<ClipboardPaste />} disabled={readonly || !clip} onClick={() => void actions.paste()}>{clip ? `貼上 ${clip.items.length} 個項目` : "貼上"}</KagoMenuItem>
        <KagoMenuSeparator />
        <KagoMenuItem icon={<ExternalLink />} onClick={() => store().openWindow({ rootSlug: win.rootSlug, logicalPath: win.logicalPath, title: win.title })}>在新視窗開啟此資料夾（⌥N）</KagoMenuItem>
        <KagoMenuItem icon={<RefreshCw />} onClick={() => void actions.refresh()}>重新整理</KagoMenuItem>
      </>
    );
  }

  return (
    <KagoWindow
      window={win}
      icon={<FileIcon item={FOLDER} />}
      titleExtra={readonly ? <KagoBadge>唯讀</KagoBadge> : null}
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setDropActive(false)}
      onDrop={(event) => dropInto(event, win.logicalPath)}
    >
      <FileToolbar
        window={win}
        rootName={rootName}
        readonly={readonly || Boolean(error)}
        canGoBack={history.index > 0}
        canGoForward={history.index < history.stack.length - 1}
        search={search}
        onSearch={setSearch}
        onGo={go}
        onNavigate={navigate}
        onNewFolder={() => void actions.newFolder()}
        onUpload={() => uploadInput.current?.click()}
        menu={error ? null : renderMenu(selectedItems)}
      />

      <div className="flex min-h-0 flex-1">
        {error ? (
          <div className="min-h-0 min-w-0 flex-1">
            <WindowErrorState error={error} window={win} onRetry={() => void fileList.refetch()} />
          </div>
        ) : (
          <KagoContextMenu menu={renderMenu(menuTargets)} className="flex min-h-0 min-w-0 flex-1">
            <div ref={setScroller} className="relative min-w-0 flex-1 overflow-auto select-none" onContextMenuCapture={() => setMenuItem(null)} {...marquee.handlers}>
              {fileList.isLoading ? <KagoLoading /> : null}
              {fileList.data && items.length === 0 ? (
                <KagoEmptyState
                  className="h-full"
                  icon={<Folder />}
                  title={search ? "沒有符合的項目" : "這個資料夾是空的"}
                  description={search ? `找不到名稱包含「${search.trim()}」的項目。` : readonly ? "這個位置是唯讀的。" : "把檔案拖進來，或使用工具列上傳。"}
                />
              ) : null}
              {items.length > 0 ? <FileList window={win} items={items} tree={tree} scroller={scroller} layout={layout} onSelect={selectItem} onOpen={openItem} onContextItem={onContextItem} onDropInto={readonly ? undefined : (event, folder) => dropInto(event, folder.path)} /> : null}
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
              已選取 {selectedItems.length} 項
              {selectedItems.every((item) => item.kind === "file") ? ` · ${formatSize(selectedItems.reduce((total, item) => total + item.size, 0))}` : ""}
            </span>
            <KagoIconButton label="下載" className="size-6" onClick={() => void actions.download(selectedItems)}><Download /></KagoIconButton>
            <KagoIconButton label="加入中轉區" className="size-6" onClick={() => void actions.addToShelf(selectedPaths)}><Inbox /></KagoIconButton>
            <KagoIconButton label="壓縮" className="size-6" disabled={readonly} onClick={() => void actions.compress(selectedPaths)}><Archive /></KagoIconButton>
            <KagoIconButton label="移到垃圾桶" className="size-6" disabled={readonly} onClick={() => void actions.trash(selectedPaths)}><Trash2 /></KagoIconButton>
          </>
        ) : (
          <span className="truncate">{error ? "無法讀取" : search ? `符合 ${items.length} / ${allItems.length} 個項目` : summary}</span>
        )}
      </footer>

      {dropActive && !readonly && !error ? <div className="pointer-events-none absolute inset-0 z-20 rounded-[inherit] ring-2 ring-accent ring-inset" /> : null}
      {dropChoice ? (
        <>
          <div className="absolute inset-0 z-20" onClick={() => setDropChoice(null)} />
          <div className={cn("absolute z-30 kago-glass flex w-44 flex-col gap-1 rounded-lg p-1.5")} style={{ left: Math.max(8, dropChoice.x), top: Math.max(44, dropChoice.y) }}>
            <span className="truncate px-1.5 py-0.5 text-xs text-muted">
              {dropChoice.sources.length} 個項目{dropChoice.destination === win.logicalPath ? "" : ` → ${baseName(dropChoice.destination)}`}
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
                {type === "copy" ? "複製到這裡" : "搬移到這裡"}
              </Button>
            ))}
            <Button variant="ghost" onClick={() => setDropChoice(null)}>取消</Button>
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
