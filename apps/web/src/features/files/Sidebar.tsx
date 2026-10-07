import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronRight, ExternalLink, FolderOpen, HardDrive, PanelTop } from "lucide-react";
import { useFileList } from "@/api/hooks";
import { KagoContextMenu, KagoMenuItem } from "@/components/kago/menu";
import { locationTone } from "@/features/workspace/DesktopIcons";
import { nfc, parentPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { folderKey } from "@/stores/settings";
import { folderTitle, useWorkspaceStore } from "@/stores/workspace";
import type { FileRef } from "@/stores/clipboard";
import type { FileWindow, Root } from "@/types/kago";
import { FileIcon } from "./FileIcon";
import { t } from "@/lib/i18n";

const FOLDER = { kind: "folder", type: "", name: "" } as const;
const INDENT = 14;
/** A folder of thousands of folders is not drawn whole in the tree; the rest are reached through the list beside it. */
const MAX_CHILDREN = 300;

/** How long a drag rests on a closed folder before it opens, to let the drop go further in. */
const SPRING_MS = 700;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

type Tree = {
  window: FileWindow;
  expanded: ReadonlySet<string>;
  toggle: (key: string) => void;
  onNavigate: (folder: FileRef) => void;
  /** The locations nothing can be dropped into. */
  readonly: ReadonlySet<string>;
  /** The folder a drag is over, by `folderKey`. */
  dropTarget: string | null;
  setDropTarget: (key: string | null) => void;
  onDropInto: (event: React.DragEvent, folder: FileRef) => void;
};

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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const readonly = useMemo(() => new Set(roots.filter((root) => root.readonly).map((root) => root.slug)), [roots]);

  // A drag resting on a closed folder opens it, so what is dragged can be taken further in without letting go.
  useEffect(() => {
    if (!dropTarget) return;
    const timer = setTimeout(() => setExpanded((previous) => (previous.has(dropTarget) ? previous : new Set(previous).add(dropTarget))), SPRING_MS);
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
      dropTarget,
      setDropTarget: (key) => {
        if (key) onDragTarget();
        setDropTarget(key);
      },
      onDropInto,
      toggle: (key) =>
        setExpanded((previous) => {
          const next = new Set(previous);
          if (!next.delete(key)) next.add(key);
          return next;
        })
    }),
    [window, expanded, onNavigate, readonly, dropTarget, onDragTarget, onDropInto]
  );

  return (
    <nav aria-label={t("Folders")} className="hidden w-48 shrink-0 flex-col overflow-y-auto border-r border-line bg-elevated p-1.5 select-none @lg/body:flex">
      <span className="px-2 pt-0.5 pb-1 text-xs font-medium text-faint">{t("Locations")}</span>
      <div role="tree" className="flex flex-col gap-px">
        {roots.map((root) => (
          <Node key={root.slug} tree={tree} rootSlug={root.slug} path="/" label={root.name} depth={0} />
        ))}
      </div>
    </nav>
  );
}

function Node({ tree, rootSlug, path, label, depth }: { tree: Tree; rootSlug: string; path: string; label: string; depth: number }) {
  const { window } = tree;
  const store = useWorkspaceStore.getState;
  const key = folderKey(rootSlug, path);
  const open = tree.expanded.has(key);
  const current = window.rootSlug === rootSlug && window.logicalPath === path;
  const row = useRef<HTMLDivElement>(null);
  const here = { rootSlug, path };
  const openTab = () => store().openTab(window.id, { rootSlug, logicalPath: path });

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
          {path === "/" ? <HardDrive className="shrink-0" style={{ color: `var(--kago-app-${locationTone(rootSlug)})` }} /> : <FileIcon item={FOLDER} />}
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
        <Node key={folder.path} tree={tree} rootSlug={rootSlug} path={folder.path} label={nfc(folder.name)} depth={depth} />
      ))}
      {folders.length > MAX_CHILDREN ? note(t("{count} more folder | {count} more folders", { count: folders.length - MAX_CHILDREN })) : null}
    </>
  );
}
