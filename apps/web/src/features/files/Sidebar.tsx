import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { ChevronRight, ClipboardPaste, Copy, Download, ExternalLink, FolderOpen, FolderPlus, HardDrive, PanelTop, Pencil, Scissors, Server, Trash2 } from "lucide-react";
import { useFileList } from "@/api/hooks";
import { KagoContextMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { locationTone } from "@/features/workspace/DesktopIcons";
import { nfc, parentPath } from "@/lib/paths";
import { usePointerDrag } from "@/lib/usePointerDrag";
import { cn } from "@/lib/utils";
import { folderKey } from "@/stores/settings";
import { folderTitle, useWorkspaceStore } from "@/stores/workspace";
import { useClipboardStore, type FileRef } from "@/stores/clipboard";
import type { FileWindow, Root } from "@/types/kago";
import { FileIcon } from "./FileIcon";
import { downloadFiles, newFolderIn, pasteClipboard, renameFile, setClipboard, trashFiles } from "./useFileActions";
import { t } from "@/lib/i18n";

const FOLDER = { kind: "folder", type: "", name: "" } as const;
const INDENT = 14;
/** A folder of thousands of folders is not drawn whole in the tree; the rest are reached through the list beside it. */
const MAX_CHILDREN = 300;
const MIN_WIDTH = 144;
const MAX_WIDTH = 420;

/** How long a drag rests on a closed folder before it opens, to let the drop go further in. */
const SPRING_MS = 700;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type Tree = {
  window: FileWindow;
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
  expand: (key: string) => void;
  onNavigate: (folder: FileRef) => void;
  /** The locations nothing can be dropped into. */
  readonly: ReadonlySet<string>;
  /** The locations kept on another machine. */
  remote: ReadonlySet<string>;
  /** The folder a drag is over, by `folderKey`. */
  dropTarget: string | null;
  setDropTarget: (key: string | null) => void;
  onDropInto: (event: React.DragEvent, folder: FileRef) => void;
  queryClient: QueryClient;
  /** How many items are waiting to be pasted. */
  clipCount: number;
};

/** True for a folder and for everything inside it. */
const isWithin = (path: string, folder: string) => path === folder || path.startsWith(`${folder}/`);

/**
 * Every location and the folders inside, as a tree down the left side of a file window. It shows where the
 * window is among them, and reaches any other folder without going through the ones in between.
 */
export function Sidebar({
  window,
  roots,
  onNavigate,
  onDragTarget,
  onDropInto
}: {
  window: FileWindow;
  roots: Root[];
  onNavigate: (folder: FileRef) => void;
  /** A drag has come over a folder of the tree, which is then where it would land, not the window's own folder. */
  onDragTarget: () => void;
  onDropInto: (event: React.DragEvent, folder: FileRef) => void;
}) {
  const width = useWorkspaceStore((state) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, state.sidebar.width ?? 192)));
  const resizeHandlers = usePointerDrag(
    () => width,
    (origin, dx) => useWorkspaceStore.getState().updateSidebar({ width: Math.round(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, origin + dx))) })
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const clipCount = useClipboardStore((state) => state.clip?.items.length ?? 0);
  const readonly = useMemo(() => new Set(roots.filter((root) => root.readonly).map((root) => root.slug)), [roots]);
  const remote = useMemo(() => new Set(roots.filter((root) => root.provider !== "local").map((root) => root.slug)), [roots]);

  const expand = (key: string) => setExpanded((previous) => (previous.has(key) ? previous : new Set(previous).add(key)));

  // A drag resting on a closed folder opens it, so what is dragged can be taken further in without letting go.
  useEffect(() => {
    if (!dropTarget) return;
    const timer = setTimeout(() => expand(dropTarget), SPRING_MS);
    return () => clearTimeout(timer);
  }, [dropTarget]);

  // Wherever the window goes, the way down to it is opened, so the folder it shows is always in the tree.
  useEffect(() => {
    setExpanded((previous) => {
      const next = new Set(previous);
      for (let path = window.logicalPath; path !== "/"; ) {
        path = parentPath(path);
        next.add(folderKey(window.rootSlug, path));
      }
      return next.size === previous.size ? previous : next;
    });
  }, [window.rootSlug, window.logicalPath]);

  const tree = useMemo<Tree>(
    () => ({
      window,
      expanded,
      onNavigate,
      readonly,
      remote,
      dropTarget,
      setDropTarget: (key) => {
        if (key) onDragTarget();
        setDropTarget(key);
      },
      onDropInto,
      queryClient,
      clipCount,
      expand,
      toggle: (key) =>
        setExpanded((previous) => {
          const next = new Set(previous);
          if (!next.delete(key)) next.add(key);
          return next;
        })
    }),
    [window, expanded, onNavigate, readonly, remote, dropTarget, onDragTarget, onDropInto, queryClient, clipCount]
  );

  // The locations on other machines stand apart from the server's own, which answer faster and are always there.
  const sections = [
    { label: t("Locations"), roots: roots.filter((root) => !remote.has(root.slug)) },
    { label: t("Remote locations"), roots: roots.filter((root) => remote.has(root.slug)) }
  ];

  return (
    <nav aria-label={t("Folders")} className="relative hidden max-w-[50%] shrink-0 border-r border-line bg-elevated select-none @lg/body:flex" style={{ width }}>
      <div className="absolute inset-y-0 -right-1 z-10 w-2 cursor-ew-resize touch-none" {...resizeHandlers} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-1.5">
        {sections.map((section, index) =>
          section.roots.length === 0 ? null : (
            <div key={section.label} className={cn("flex flex-col", index > 0 && "mt-2")}>
              <span className="px-2 pt-0.5 pb-1 text-xs font-medium text-faint">{section.label}</span>
              <div role="tree" aria-label={section.label} className="flex flex-col gap-px">
                {section.roots.map((root) => (
                  <Node key={root.slug} tree={tree} rootSlug={root.slug} path="/" label={root.name} depth={0} />
                ))}
              </div>
            </div>
          )
        )}
      </div>
    </nav>
  );
}

function Node({ tree, rootSlug, path, label, depth, locked }: { tree: Tree; rootSlug: string; path: string; label: string; depth: number; /** The folder itself cannot be changed. */ locked?: boolean }) {
  const { window, queryClient } = tree;
  const store = useWorkspaceStore.getState;
  const key = folderKey(rootSlug, path);
  const open = tree.expanded.has(key);
  const current = window.rootSlug === rootSlug && window.logicalPath === path;
  const row = useRef<HTMLDivElement>(null);
  const here = { rootSlug, path };
  const openTab = () => store().openTab(window.id, { rootSlug, logicalPath: path });
  const RootIcon = tree.remote.has(rootSlug) ? Server : HardDrive;
  const readonly = locked || tree.readonly.has(rootSlug);
  /** Where the window is, when that is this folder or somewhere inside it. */
  const inside = window.rootSlug === rootSlug && isWithin(window.logicalPath, path) ? window.logicalPath.slice(path.length) : null;

  useEffect(() => {
    if (current) row.current?.scrollIntoView({ block: "nearest" });
  }, [current]);

  return (
    <>
      <KagoContextMenu
        menu={
          <>
            <KagoMenuItem icon={<FolderOpen />} onClick={() => tree.onNavigate(here)}>{t("Open")}</KagoMenuItem>
            <KagoMenuItem icon={<PanelTop />} onClick={openTab}>{t("Open in new tab")}</KagoMenuItem>
            <KagoMenuItem icon={<ExternalLink />} onClick={() => store().openWindow({ rootSlug, logicalPath: path, title: folderTitle(rootSlug, path) })}>{t("Open in new window")}</KagoMenuItem>
            <KagoMenuSeparator />
            <KagoMenuItem icon={<FolderPlus />} disabled={readonly} onClick={() => void newFolderIn(queryClient, here).then((made) => made && tree.expand(key))}>{t("New folder")}</KagoMenuItem>
            <KagoMenuItem icon={<ClipboardPaste />} disabled={readonly || tree.clipCount === 0} onClick={() => void pasteClipboard(queryClient, here)}>{tree.clipCount > 0 ? t("Paste {count} item | Paste {count} items", { count: tree.clipCount }) : t("Paste")}</KagoMenuItem>
            {path === "/" ? null : (
              <>
                <KagoMenuSeparator />
                <KagoMenuItem icon={<Copy />} onClick={() => setClipboard("copy", [here])}>{t("Copy")}</KagoMenuItem>
                <KagoMenuItem icon={<Scissors />} disabled={readonly} onClick={() => setClipboard("cut", [here])}>{t("Cut")}</KagoMenuItem>
                {/* A window showing the folder, or one inside it, follows it to its new name. */}
                <KagoMenuItem icon={<Pencil />} disabled={readonly} onClick={() => void renameFile(queryClient, { ...here, name: label }, (renamed) => inside !== null && tree.onNavigate({ rootSlug, path: renamed + inside }))}>{t("Rename")}</KagoMenuItem>
                <KagoMenuItem icon={<Download />} onClick={() => void downloadFiles(queryClient, rootSlug, [{ path, kind: "folder" }])}>{t("Download")}</KagoMenuItem>
                <KagoMenuSeparator />
                {/* A window left inside a folder that is gone steps out to the one that held it. */}
                <KagoMenuItem icon={<Trash2 />} destructive disabled={readonly} onClick={() => void trashFiles(queryClient, [here]).then((task) => task && inside !== null && tree.onNavigate({ rootSlug, path: parentPath(path) }))}>{t("Move to Trash")}</KagoMenuItem>
              </>
            )}
          </>
        }
      >
        <div
          ref={row}
          role="treeitem"
          aria-expanded={open}
          aria-current={current ? "location" : undefined}
          className={cn("flex h-7 items-center gap-1.5 rounded-md pr-2 hover:bg-hover", current && "bg-accent-soft font-medium hover:bg-accent-soft", tree.dropTarget === key && "ring-2 ring-accent ring-inset")}
          style={{ paddingLeft: 4 + depth * INDENT }}
          onClick={(event) => (event.metaKey || event.ctrlKey ? openTab() : tree.onNavigate(here))}
          onAuxClick={(event) => event.button === 1 && openTab()}
          onDragOver={(event) => {
            // The window underneath takes drops for the folder it shows; over the tree a drop belongs to the folder under it, or to none.
            event.stopPropagation();
            if (tree.readonly.has(rootSlug)) return;
            event.preventDefault();
            if (tree.dropTarget !== key) tree.setDropTarget(key);
          }}
          onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && tree.dropTarget === key && tree.setDropTarget(null)}
          onDrop={(event) => {
            event.stopPropagation();
            tree.setDropTarget(null);
            if (!tree.readonly.has(rootSlug)) tree.onDropInto(event, here);
          }}
        >
          <button
            className="flex size-4 shrink-0 items-center justify-center rounded-sm text-muted outline-none hover:text-ink"
            aria-label={open ? t("Collapse folder") : t("Expand folder")}
            tabIndex={-1}
            onClick={(event) => {
              // The arrow only opens the folder in the tree; it does not take the window there.
              event.stopPropagation();
              tree.toggle(key);
            }}
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
          {path !== "/" ? <FileIcon item={FOLDER} /> : <RootIcon className="shrink-0" style={{ color: `var(--kago-app-${locationTone(rootSlug)})` }} />}
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </div>
      </KagoContextMenu>
      {open ? <Children tree={tree} rootSlug={rootSlug} path={path} depth={depth + 1} /> : null}
    </>
  );
}

/** The folders inside one that is open in the tree. They are only asked for once it is opened. */
function Children({ tree, rootSlug, path, depth }: { tree: Tree; rootSlug: string; path: string; depth: number }) {
  const list = useFileList(rootSlug, path);
  const folders = useMemo(() => list.data?.items.filter((item) => item.kind === "folder").sort((a, b) => collator.compare(a.name, b.name)), [list.data]);
  const note = (text: string) => (
    <span className="truncate py-1 text-xs text-faint" style={{ paddingLeft: 24 + depth * INDENT }}>{text}</span>
  );

  if (!folders) return list.isError ? note(t("Couldn’t load")) : null;
  if (folders.length === 0) return note(t("No folders inside"));
  return (
    <>
      {folders.slice(0, MAX_CHILDREN).map((folder) => (
        <Node key={folder.path} tree={tree} rootSlug={rootSlug} path={folder.path} label={nfc(folder.name)} depth={depth} locked={folder.readonly} />
      ))}
      {folders.length > MAX_CHILDREN ? note(t("{count} more folder | {count} more folders", { count: folders.length - MAX_CHILDREN })) : null}
    </>
  );
}
