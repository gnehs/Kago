import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import { KagoLoading } from "@/components/kago/empty-state";
import { FinderTagDots } from "@/features/tags/FinderTags";
import { formatDate, formatSize, kindLabel } from "@/lib/format";
import { baseName } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { useClipboardStore } from "@/stores/clipboard";
import { setFolderView } from "@/stores/settings";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileItem, FolderView, FolderWindow } from "@/types/kago";
import { setDragDownload, setDragPreview } from "./dragOut";
import { FileIcon } from "./FileIcon";
import { FileThumbnail } from "./FileThumbnail";
import { GRID_SIZES, LIST_HEADER_HEIGHT, revealIndex, useFileLayout, useVisibleRange, type FileLayout, type FileTree } from "./fileLayout";
import { KAGO_DRAG_TYPE } from "./useFileActions";
import { t } from "@/lib/i18n";

type FileListProps = {
  window: FolderWindow;
  items: FileItem[];
  /** Folders opened in place, in the list view. */
  tree?: FileTree;
  /** The scroll container the list sits in, and where each item is laid out inside it. */
  scroller: HTMLElement | null;
  layout: FileLayout;
  onSelect: (event: React.MouseEvent, item: FileItem) => void;
  /** A folder can be opened where it is, in a tab of its own, or in a window of its own. */
  onOpen: (item: FileItem, where?: "window" | "tab") => void;
  onContextItem: (item: FileItem) => void;
  /** Dropping onto a folder puts the items inside it. Omitted when the window cannot be written to. */
  onDropInto?: (event: React.DragEvent, folder: FileItem) => void;
};

type ViewProps = FileListProps & { selectedPaths: Set<string>; dropTarget: string | null; setDropTarget: (path: string | null) => void; cutPaths: Set<string> };

/** Behaviour shared by every view: selection, open, drag source, folder drop target and context-menu target. */
function itemProps({ window, items, selectedPaths, onSelect, onOpen, onContextItem, onDropInto, setDropTarget }: ViewProps, item: FileItem, index: number) {
  const selected = selectedPaths.has(item.path);
  const dropHandlers =
    item.kind === "folder" && onDropInto
      ? {
          onDragOver(event: React.DragEvent) {
            event.preventDefault();
            setDropTarget(item.path);
          },
          onDragLeave(event: React.DragEvent) {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
          },
          onDrop(event: React.DragEvent) {
            event.preventDefault();
            // The window underneath is a drop target too; this drop belongs to the folder.
            event.stopPropagation();
            setDropTarget(null);
            onDropInto(event, item);
          }
        }
      : {};
  return {
    ...dropHandlers,
    "data-file-path": item.path,
    "data-file-kind": item.kind,
    "aria-selected": selected,
    // Only the rows near the viewport are rendered, so the full size of the list has to be stated.
    "aria-setsize": items.length,
    "aria-posinset": index + 1,
    draggable: true,
    onDragStart(event: React.DragEvent) {
      // Dragging an item that is not selected picks it up alone, and selects it, as a click would have.
      const dragged = selected ? items.filter((entry) => selectedPaths.has(entry.path)) : [item];
      if (!selected) useWorkspaceStore.getState().selectItems(window.id, [item.path]);
      event.dataTransfer.setData(KAGO_DRAG_TYPE, JSON.stringify(dragged.map(({ path }) => ({ rootSlug: window.rootSlug, path }))));
      event.dataTransfer.effectAllowed = "copyMove";
      setDragDownload(event.dataTransfer, window.rootSlug, dragged);
      setDragPreview(event.dataTransfer, event.currentTarget, dragged.length);
    },
    onClick: (event: React.MouseEvent) => onSelect(event, item),
    onDoubleClick: () => onOpen(item),
    onAuxClick(event: React.MouseEvent) {
      if (event.button === 1 && item.kind === "folder") onOpen(item, "tab");
    },
    onContextMenu: () => onContextItem(item)
  };
}

const selectedClass = (window: FolderWindow, selected: boolean) => (selected ? (window.focused ? "kago-selection kago-selection-raised" : "bg-accent-soft") : "hover:bg-hover");

/**
 * Where a chosen row stands among the chosen rows around it. Rows chosen one under another are drawn as one block,
 * so each has to know whether the block carries on above it and below it.
 */
function selectionRun(items: FileItem[], index: number, selectedPaths: Set<string>) {
  if (!selectedPaths.has(items[index]!.path)) return undefined;
  const above = index > 0 && selectedPaths.has(items[index - 1]!.path);
  const below = index < items.length - 1 && selectedPaths.has(items[index + 1]!.path);
  return above && below ? "middle" : above ? "end" : below ? "start" : undefined;
}

/** Folder under a drag, and items waiting to be moved by a cut. */
const stateClass = ({ dropTarget, cutPaths }: ViewProps, item: FileItem) => cn(dropTarget === item.path && "ring-2 ring-accent ring-inset", cutPaths.has(item.path) && "opacity-50");

export function FileList(props: FileListProps) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const clip = useClipboardStore((state) => state.clip);
  const rootSlug = props.window.rootSlug;
  const cutPaths = useMemo(() => new Set(clip?.mode === "cut" ? clip.items.filter((item) => item.rootSlug === rootSlug).map((item) => item.path) : []), [clip, rootSlug]);
  const selectedItems = props.window.selectedItems;
  const selectedPaths = useMemo(() => new Set(selectedItems), [selectedItems]);
  const view = { ...props, selectedPaths, dropTarget, setDropTarget, cutPaths };
  return props.window.viewMode === "grid" ? <GridView {...view} /> : <ListView {...view} />;
}

function ListView(props: ViewProps) {
  const { window, items, tree, layout, selectedPaths } = props;
  const range = useVisibleRange(props.scroller, layout, items.length);
  return (
    <div className="@container min-w-0" role="listbox" aria-multiselectable>
      <div className="sticky top-0 z-[1] flex items-center gap-2 border-b border-line bg-surface px-3 text-xs text-muted" style={{ height: LIST_HEADER_HEIGHT }}>
        <SortHeader window={window} sortBy="name" label={t("Name")} className="min-w-0 flex-1" />
        <SortHeader window={window} sortBy="mtime" label={t("Modified")} className="hidden w-36 @md:flex" />
        <SortHeader window={window} sortBy="size" label={t("Size")} className="w-20 justify-end" />
        <SortHeader window={window} sortBy="type" label={t("Kind")} className="hidden w-24 @xl:flex" />
      </div>
      <div style={{ height: range.height + layout.bottom, paddingTop: range.offset }}>
        {items.slice(range.start, range.end).map((item, offset) => {
          const selected = selectedPaths.has(item.path);
          const open = tree?.expanded.has(item.path) ?? false;
          return (
            <div key={item.path} role="option" data-run={selectionRun(items, range.start + offset, selectedPaths)} className={cn("mx-1 flex h-(--kago-row-h) items-center gap-2 rounded-sm px-2", selectedClass(window, selected), stateClass(props, item))} {...itemProps(props, item, range.start + offset)}>
              <span className="flex min-w-0 flex-1 items-center gap-2" style={{ paddingLeft: (tree?.depths[range.start + offset] ?? 0) * TREE_INDENT }}>
                {tree ? (
                  item.kind === "folder" ? (
                    <button
                      className={cn("-mx-1 flex size-4 shrink-0 items-center justify-center rounded-sm outline-none", selected && window.focused ? "text-inherit" : "text-muted hover:text-ink")}
                      aria-label={open ? t("Collapse folder") : t("Expand folder")}
                      aria-expanded={open}
                      tabIndex={-1}
                      onClick={(event) => {
                        // The arrow only opens the folder in place; it neither selects the row nor enters the folder.
                        event.stopPropagation();
                        tree.setExpanded(item.path, !open);
                      }}
                      onDoubleClick={(event) => event.stopPropagation()}
                    >
                      <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                    </button>
                  ) : (
                    <span className="-mx-1 size-4 shrink-0" />
                  )
                ) : null}
                <FileIcon item={item} />
                <span className="truncate">{item.name}</span>
                <FinderTagDots tags={item.finderTags} />
              </span>
              <span className={cn("hidden w-36 truncate tabular-nums @md:block", !selected && "text-muted")}>{formatDate(item.mtime)}</span>
              <span className={cn("w-20 text-right tabular-nums", !selected && "text-muted")}>{item.kind === "folder" ? "—" : formatSize(item.size)}</span>
              <span className={cn("hidden w-24 truncate @xl:block", !selected && "text-muted")}>{kindLabel(item)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** How far each level of an opened folder is set in from the one above. */
const TREE_INDENT = 16;

export const sortColumns: Array<{ sortBy: FolderView["sortBy"]; label: string }> = [
  { sortBy: "name", label: t("Name") },
  { sortBy: "mtime", label: t("Modified") },
  { sortBy: "size", label: t("Size") },
  { sortBy: "type", label: t("Kind") }
];

/** The direction a column is sorted in when it is first picked: sizes and dates start largest or newest first. */
export const firstDirection = (sortBy: FolderView["sortBy"]): FolderView["sortDirection"] => (sortBy === "size" || sortBy === "mtime" ? "desc" : "asc");

/** Picks a sort column for the folder a window shows; picking the current one again flips its direction. */
export function toggleSort(window: FolderWindow, sortBy: FolderView["sortBy"]) {
  const sortDirection = window.sortBy === sortBy ? (window.sortDirection === "asc" ? "desc" : "asc") : firstDirection(sortBy);
  void setFolderView(window.rootSlug, window.logicalPath, { sortBy, sortDirection });
}

function SortHeader({ window, sortBy, label, className }: { window: FolderWindow; sortBy: FolderView["sortBy"]; label: string; className?: string }) {
  const active = window.sortBy === sortBy;
  const ascending = window.sortDirection === "asc";
  const sort = () => toggleSort(window, sortBy);

  return (
    <button className={cn("flex h-full items-center gap-1 outline-none hover:text-ink", active && "font-medium text-ink", className)} aria-sort={active ? (ascending ? "ascending" : "descending") : "none"} onClick={sort}>
      {label}
      {active ? ascending ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
    </button>
  );
}

function GridView(props: ViewProps) {
  const { window, items, layout, selectedPaths } = props;
  const range = useVisibleRange(props.scroller, layout, items.length);
  const { icon } = GRID_SIZES[window.iconSize];
  return (
    <div
      className="grid content-start px-2"
      role="listbox"
      aria-multiselectable
      style={{ gridTemplateColumns: `repeat(${layout.columns}, minmax(0, 1fr))`, gap: layout.gap, height: layout.top + range.height + layout.bottom, paddingTop: layout.top + range.offset }}
    >
      {items.slice(range.start, range.end).map((item, offset) => {
        const selected = selectedPaths.has(item.path);
        return (
          // Every cell is the same height whatever the length of its name, so rows can be placed without measuring them.
          <div key={item.path} role="option" className={cn("flex flex-col items-center gap-1 overflow-hidden rounded-md p-1.5", stateClass(props, item))} style={{ height: layout.cellHeight }} {...itemProps(props, item, range.start + offset)}>
            <div className={cn("flex shrink-0 items-center justify-center rounded-md", selected && "bg-hover ring-1 ring-line ring-inset")} style={{ width: icon + 8, height: icon + 8 }}>
              <FileThumbnail rootSlug={window.rootSlug} item={item} size={icon} />
            </div>
            <span className={cn("line-clamp-2 max-w-full rounded-sm px-1.5 text-center leading-4 break-words", selectedClass(window, selected))}>
              <FinderTagDots tags={item.finderTags} className="mr-1 inline-flex align-[-1px]" />
              {item.name}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/** One column of the column view: a folder, and what it holds once that is known. */
export type FileColumn = { folder: string; items: FileItem[] | undefined };

type FileColumnsProps = Pick<FileListProps, "window" | "onOpen" | "onContextItem"> & {
  /** The window's folder first, then each folder opened from the column before it. */
  columns: FileColumn[];
  onSelect: (event: React.MouseEvent, item: FileItem, column: number) => void;
  /** A click on the empty part of a column, which goes back to the folder that column shows. */
  onSelectColumn: (column: number) => void;
  onDropInto?: (event: React.DragEvent, folder: string) => void;
  /** Filled in with the way to scroll each column to one of its items. */
  revealers: React.RefObject<Array<((index: number) => void) | undefined>>;
};

/**
 * Columns side by side, each a level further in: selecting a folder lists what it holds in the next column,
 * so the way down to an item stays in sight.
 */
export function FileColumns(props: FileColumnsProps) {
  const { window, columns } = props;
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const clip = useClipboardStore((state) => state.clip);
  const cutPaths = useMemo(() => new Set(clip?.mode === "cut" ? clip.items.filter((item) => item.rootSlug === window.rootSlug).map((item) => item.path) : []), [clip, window.rootSlug]);
  const selectedPaths = useMemo(() => new Set(window.selectedItems), [window.selectedItems]);
  const strip = useRef<HTMLDivElement>(null);
  const deepest = columns.at(-1)!.folder;

  // The column just opened is the one being looked at, so it is brought into view.
  useLayoutEffect(() => {
    if (strip.current) strip.current.scrollLeft = strip.current.scrollWidth;
  }, [deepest]);

  return (
    <div ref={strip} className="flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden select-none">
      {columns.map((column, index) => (
        <Column key={column.folder} {...props} column={column} index={index} opened={columns[index + 1]?.folder} selectedPaths={selectedPaths} cutPaths={cutPaths} dropTarget={dropTarget} setDropTarget={setDropTarget} />
      ))}
    </div>
  );
}

function Column({ column, index, opened, revealers, onSelect, onSelectColumn, onDropInto, ...shared }: FileColumnsProps & Pick<ViewProps, "selectedPaths" | "cutPaths" | "dropTarget" | "setDropTarget"> & { column: FileColumn; index: number; /** The folder of this column that the next one shows. */ opened?: string }) {
  const { window, dropTarget, setDropTarget } = shared;
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const layout = useFileLayout(scroller, "columns", window.iconSize);
  const items = column.items ?? EMPTY;
  const range = useVisibleRange(scroller, layout, items.length);
  const view: ViewProps = { ...shared, items, scroller, layout, onSelect: (event, item) => onSelect(event, item, index), onDropInto: onDropInto ? (event, folder) => onDropInto(event, folder.path) : undefined };

  useEffect(() => {
    const list = revealers.current;
    list[index] = (item) => scroller && revealIndex(scroller, layout, item);
    return () => void (list[index] = undefined);
  }, [revealers, index, scroller, layout]);

  const onBlank = (event: React.SyntheticEvent) => !(event.target as Element).closest("[data-file-path]");

  return (
    <div
      ref={setScroller}
      role="listbox"
      aria-multiselectable
      aria-label={baseName(column.folder) || undefined}
      className={cn("relative w-56 shrink-0 overflow-x-hidden overflow-y-auto border-r border-line", dropTarget === column.folder && "bg-hover")}
      onClick={(event) => onBlank(event) && onSelectColumn(index)}
      onDragOver={(event) => {
        // A folder row under the pointer takes the drop itself; anywhere else it goes to the folder this column shows.
        if (onDropInto && !(event.target as Element).closest("[data-file-kind=folder]")) setDropTarget(column.folder);
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setDropTarget(null)}
      onDrop={(event) => {
        setDropTarget(null);
        if (!onDropInto) return;
        event.stopPropagation();
        onDropInto(event, column.folder);
      }}
    >
      {column.items === undefined ? (
        <KagoLoading />
      ) : items.length === 0 ? (
        <p className="m-0 px-3 py-2.5 text-faint">{t("Empty folder")}</p>
      ) : (
        <div style={{ height: layout.top + range.height + layout.bottom, paddingTop: layout.top + range.offset }}>
          {items.slice(range.start, range.end).map((item, offset) => {
            const selected = shared.selectedPaths.has(item.path);
            return (
              // A folder the next column was opened from stays marked after the selection has moved on into it.
              <div key={item.path} role="option" data-run={selectionRun(items, range.start + offset, shared.selectedPaths)} className={cn("mx-1 flex h-(--kago-row-h) items-center gap-2 rounded-sm px-2", selected ? selectedClass(window, true) : item.path === opened ? "bg-accent-soft" : "hover:bg-hover", stateClass(view, item))} {...itemProps(view, item, range.start + offset)}>
                <FileIcon item={item} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                <FinderTagDots tags={item.finderTags} />
                {item.kind === "folder" ? <ChevronRight className={cn("size-3.5 shrink-0", !selected && "text-faint")} /> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const EMPTY: FileItem[] = [];
