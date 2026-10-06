import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { previewUrl, thumbnailUrl } from "@/api/client";
import { Button } from "@/components/ui/button";
import { formatDate, formatSize, kindLabel } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useClipboardStore } from "@/stores/clipboard";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileItem, FileWindow } from "@/types/kago";
import { FileIcon } from "./FileIcon";
import { KAGO_DRAG_TYPE } from "./useFileActions";

type FileListProps = {
  window: FileWindow;
  items: FileItem[];
  onSelect: (event: React.MouseEvent, item: FileItem) => void;
  onOpen: (item: FileItem, newWindow?: boolean) => void;
  onContextItem: (item: FileItem) => void;
  /** Dropping onto a folder puts the items inside it. Omitted when the window cannot be written to. */
  onDropInto?: (event: React.DragEvent, folder: FileItem) => void;
};

type ViewProps = FileListProps & { dropTarget: string | null; setDropTarget: (path: string | null) => void; cutPaths: Set<string> };

/** Behaviour shared by every view: selection, open, drag source, folder drop target and context-menu target. */
function itemProps({ window, onSelect, onOpen, onContextItem, onDropInto, setDropTarget }: ViewProps, item: FileItem) {
  const selected = window.selectedItems.includes(item.path);
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
    draggable: true,
    onDragStart(event: React.DragEvent) {
      const paths = selected ? window.selectedItems : [item.path];
      event.dataTransfer.setData(KAGO_DRAG_TYPE, JSON.stringify(paths.map((path) => ({ rootSlug: window.rootSlug, path }))));
      event.dataTransfer.effectAllowed = "copyMove";
    },
    onClick: (event: React.MouseEvent) => onSelect(event, item),
    onDoubleClick: () => onOpen(item),
    onAuxClick(event: React.MouseEvent) {
      if (event.button === 1 && item.kind === "folder") onOpen(item, true);
    },
    onContextMenu: () => onContextItem(item)
  };
}

const selectedClass = (window: FileWindow, selected: boolean) => (selected ? (window.focused ? "bg-accent text-accent-fg" : "bg-accent-soft") : "hover:bg-hover");

/** Folder under a drag, and items waiting to be moved by a cut. */
const stateClass = ({ dropTarget, cutPaths }: ViewProps, item: FileItem) => cn(dropTarget === item.path && "ring-2 ring-accent ring-inset", cutPaths.has(item.path) && "opacity-50");

export function FileList(props: FileListProps) {
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const clip = useClipboardStore((state) => state.clip);
  const rootSlug = props.window.rootSlug;
  const cutPaths = useMemo(() => new Set(clip?.mode === "cut" ? clip.items.filter((item) => item.rootSlug === rootSlug).map((item) => item.path) : []), [clip, rootSlug]);
  const view = { ...props, dropTarget, setDropTarget, cutPaths };
  if (props.window.viewMode === "grid") return <GridView {...view} />;
  if (props.window.viewMode === "columns") return <ColumnsView {...view} />;
  return <ListView {...view} />;
}

function ListView(props: ViewProps) {
  const { window, items } = props;
  return (
    <div className="@container min-w-0 pb-2" role="listbox" aria-multiselectable>
      <div className="sticky top-0 z-[1] flex h-7 items-center gap-2 border-b border-line bg-surface px-3 text-xs text-muted">
        <SortHeader window={window} sortBy="name" label="名稱" className="min-w-0 flex-1" />
        <SortHeader window={window} sortBy="mtime" label="修改時間" className="hidden w-36 @md:flex" />
        <SortHeader window={window} sortBy="size" label="大小" className="w-20 justify-end" />
        <SortHeader window={window} sortBy="type" label="種類" className="hidden w-24 @xl:flex" />
      </div>
      {items.map((item) => {
        const selected = window.selectedItems.includes(item.path);
        return (
          <div key={item.path} role="option" className={cn("mx-1 flex h-(--kago-row-h) items-center gap-2 rounded-sm px-2", selectedClass(window, selected), stateClass(props, item))} {...itemProps(props, item)}>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <FileIcon item={item} className={cn(selected && window.focused && item.kind === "file" && "text-inherit")} />
              <span className="truncate">{item.name}</span>
            </span>
            <span className={cn("hidden w-36 truncate tabular-nums @md:block", !selected && "text-muted")}>{formatDate(item.mtime)}</span>
            <span className={cn("w-20 text-right tabular-nums", !selected && "text-muted")}>{item.kind === "folder" ? "—" : formatSize(item.size)}</span>
            <span className={cn("hidden w-24 truncate @xl:block", !selected && "text-muted")}>{kindLabel(item)}</span>
          </div>
        );
      })}
    </div>
  );
}

export const sortColumns: Array<{ sortBy: FileWindow["sortBy"]; label: string }> = [
  { sortBy: "name", label: "名稱" },
  { sortBy: "mtime", label: "修改時間" },
  { sortBy: "size", label: "大小" },
  { sortBy: "type", label: "種類" }
];

/** Picks a sort column; picking the current one again flips its direction. Sizes and dates start largest or newest first. */
export function toggleSort(window: FileWindow, sortBy: FileWindow["sortBy"]) {
  const sortDirection = window.sortBy === sortBy ? (window.sortDirection === "asc" ? "desc" : "asc") : sortBy === "size" || sortBy === "mtime" ? "desc" : "asc";
  useWorkspaceStore.getState().updateWindow(window.id, { sortBy, sortDirection });
}

function SortHeader({ window, sortBy, label, className }: { window: FileWindow; sortBy: FileWindow["sortBy"]; label: string; className?: string }) {
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
  const { window, items } = props;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] content-start gap-1 p-2" role="listbox" aria-multiselectable>
      {items.map((item) => {
        const selected = window.selectedItems.includes(item.path);
        return (
          <div key={item.path} role="option" className={cn("flex flex-col items-center gap-1 rounded-md p-1.5", stateClass(props, item))} {...itemProps(props, item)}>
            <div className={cn("flex size-20 items-center justify-center rounded-md", selected ? "bg-hover" : "")}>
              <Thumbnail rootSlug={window.rootSlug} item={item} />
            </div>
            <span className={cn("line-clamp-2 max-w-full rounded-sm px-1.5 text-center break-words", selectedClass(window, selected))}>{item.name}</span>
          </div>
        );
      })}
    </div>
  );
}

function Thumbnail({ rootSlug, item }: { rootSlug: string; item: FileItem }) {
  const [failed, setFailed] = useState(false);
  if (item.kind === "file" && item.type.startsWith("image/") && !failed) {
    return <img alt="" loading="lazy" draggable={false} src={thumbnailUrl(rootSlug, item.path)} className="max-h-18 max-w-18 rounded-sm object-contain" onError={() => setFailed(true)} />;
  }
  return <FileIcon item={item} className="size-12 stroke-[1.25]" />;
}

/** Name column on the left, a preview of the selected item on the right. */
function ColumnsView(props: ViewProps) {
  const { window, items, onOpen } = props;
  const current = items.find((item) => item.path === window.selectedItems.at(-1));
  return (
    <div className="flex min-h-full">
      <div className="w-1/2 max-w-72 shrink-0 border-r border-line py-1" role="listbox" aria-multiselectable>
        {items.map((item) => {
          const selected = window.selectedItems.includes(item.path);
          return (
            <div key={item.path} role="option" className={cn("mx-1 flex h-(--kago-row-h) items-center gap-2 rounded-sm px-2", selectedClass(window, selected), stateClass(props, item))} {...itemProps(props, item)}>
              <FileIcon item={item} className={cn(selected && window.focused && item.kind === "file" && "text-inherit")} />
              <span className="truncate">{item.name}</span>
            </div>
          );
        })}
      </div>
      <div className="sticky top-0 flex min-w-0 flex-1 flex-col items-center gap-2 self-start p-6 text-center">
        {current ? (
          <>
            {current.kind === "file" && current.type.startsWith("image/") ? (
              <img alt="" src={previewUrl(window.rootSlug, current.path)} className="max-h-48 max-w-full rounded-md object-contain" />
            ) : (
              <FileIcon item={current} className="size-16 stroke-1" />
            )}
            <strong className="max-w-full font-medium break-words">{current.name}</strong>
            <span className="text-muted">
              {kindLabel(current)}
              {current.kind === "file" ? ` · ${formatSize(current.size)}` : ""}
            </span>
            <span className="text-muted">{formatDate(current.mtime)}</span>
            <Button className="mt-1" onClick={() => onOpen(current)}>開啟</Button>
          </>
        ) : (
          <span className="pt-10 text-faint">選取項目以預覽</span>
        )}
      </div>
    </div>
  );
}
