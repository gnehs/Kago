import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Inbox, X } from "lucide-react";
import { api } from "@/api/client";
import { useFileList, useRoots, useShelves } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { setDragDownload, setDragPreview } from "@/features/files/dragOut";
import { FileIcon } from "@/features/files/FileIcon";
import { KAGO_DRAG_TYPE, readDraggedFiles } from "@/features/files/useFileActions";
import { displayPath, ensureZipName, joinLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { isInteractiveTarget, usePointerDrag } from "@/lib/usePointerDrag";
import { cn } from "@/lib/utils";
import { promptText } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import { getCanvasSize, useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";

const MARGIN = 12;

/**
 * Workspace-level holding area. It stores references only; nothing is copied until the
 * user sends the shelf to a window, which enqueues a server task.
 */
export function Shelf() {
  const queryClient = useQueryClient();
  const shelves = useShelves();
  const roots = useRoots().data;
  const shelfState = useWorkspaceStore((state) => state.shelf);
  const active = useWorkspaceStore((state) => state.windows.find((window) => window.id === state.activeWindowId && !window.minimized));
  const activeList = useFileList(active?.rootSlug ?? "", active?.logicalPath ?? "/", Boolean(active));
  const element = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 264, height: 40 });
  const [dropActive, setDropActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  const store = useWorkspaceStore.getState;
  const shelf = shelves.data?.[0];
  const collapsed = Boolean(shelfState.collapsed);
  const itemCount = shelf?.items.length ?? 0;

  // The shelf stays out of the way until there is something to drop on it.
  useEffect(() => {
    const onDragStart = (event: DragEvent) => setDragging(Boolean(event.dataTransfer?.types.includes(KAGO_DRAG_TYPE)));
    const onDragEnd = () => {
      setDragging(false);
      setDropActive(false);
    };
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("drop", onDragEnd);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", onDragEnd);
    };
  }, []);

  useLayoutEffect(() => {
    if (element.current) setSize({ width: element.current.offsetWidth, height: element.current.offsetHeight });
  }, [collapsed, itemCount, dragging, Boolean(shelf)]);

  const canvas = getCanvasSize();
  const clamp = (x: number, y: number) => ({
    x: Math.round(Math.max(MARGIN, Math.min(x, canvas.width - size.width - MARGIN))),
    y: Math.round(Math.max(MARGIN, Math.min(y, canvas.height - size.height - MARGIN)))
  });
  // Until the user drags it, the shelf rests in the bottom-right corner of the canvas.
  const placed = shelfState.x !== undefined && shelfState.y !== undefined;
  const style = placed ? (({ x, y }) => ({ left: x, top: y }))(clamp(shelfState.x!, shelfState.y!)) : { right: MARGIN, bottom: MARGIN };

  const dragHandlers = usePointerDrag(
    (event) => (isInteractiveTarget(event.target) || !element.current ? null : { x: element.current.offsetLeft, y: element.current.offsetTop }),
    (origin, dx, dy) => store().updateShelf(clamp(origin.x + dx, origin.y + dy))
  );

  if (!shelf || (itemCount === 0 && !dragging)) return null;
  const shelfId = shelf.id;
  const canSend = Boolean(active) && !activeList.data?.readonly && itemCount > 0;

  async function addDropped(event: React.DragEvent) {
    event.preventDefault();
    setDropActive(false);
    const items = readDraggedFiles(event.dataTransfer);
    if (items.length === 0) return;
    await run(async () => {
      await Promise.all(items.map((item) => api(`/api/shelves/${shelfId}/items`, { method: "POST", body: JSON.stringify(item) })));
      await queryClient.invalidateQueries({ queryKey: ["shelves"] });
    }, t("Couldn’t add to Shelf"));
  }

  async function send(type: "copy" | "move" | "compress") {
    if (!active) return;
    let path = active.logicalPath;
    if (type === "compress") {
      const name = await promptText({ title: t("Compress the Shelf to zip"), defaultValue: "shelf.zip", confirmLabel: t("Compress") });
      if (!name) return;
      path = joinLogicalPath(active.logicalPath, ensureZipName(name));
    }
    await run(async () => {
      await api(`/api/shelves/${shelfId}/tasks`, { method: "POST", body: JSON.stringify({ type, destination: { rootSlug: active.rootSlug, path } }) });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast(t("Task created"));
    });
  }

  const where = (item: { root_slug: string; path: string }) => displayPath(roots?.find((root) => root.slug === item.root_slug)?.name ?? item.root_slug, item.path);

  async function remove(itemId: string) {
    await run(async () => {
      await api(`/api/shelves/${shelfId}/items/${itemId}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["shelves"] });
    });
  }

  return (
    <aside
      ref={element}
      aria-label={t("Shelf")}
      className={cn("absolute z-[600] kago-glass flex w-66 flex-col rounded-lg", dropActive && "ring-2 ring-accent")}
      style={style}
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setDropActive(false)}
      onDrop={(event) => void addDropped(event)}
    >
      <header className="flex h-10 shrink-0 touch-none items-center gap-2 pr-1.5 pl-3 select-none" {...dragHandlers}>
        <Inbox className="text-muted" />
        <strong className="flex-1 font-medium">{t("Shelf")}</strong>
        {itemCount > 0 ? <KagoBadge tone="accent">{itemCount}</KagoBadge> : null}
        <KagoIconButton label={collapsed ? t("Expand Shelf") : t("Collapse Shelf")} onClick={() => store().updateShelf({ collapsed: !collapsed })}>
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </KagoIconButton>
      </header>

      {collapsed && itemCount > 0 ? null : itemCount === 0 ? (
        <p className="m-2 mt-0 rounded-md border border-dashed border-line-strong px-3 py-5 text-center text-muted">
          {t("Drag files here to hold them")}
          <span className="mt-0.5 block text-xs text-faint">{t("Only their location is kept; nothing is copied")}</span>
        </p>
      ) : (
        <>
          <ul className="m-0 flex max-h-52 list-none flex-col overflow-y-auto border-t border-line p-1">
            {shelf.items.map((item) => (
              <li
                key={item.id}
                draggable
                className="group flex h-9 items-center gap-2 rounded-[calc(var(--kago-radius-md)+1px)] [corner-shape:squircle] px-2 hover:bg-hover"
                title={where(item)}
                onDragStart={(event) => {
                  event.dataTransfer.setData(KAGO_DRAG_TYPE, JSON.stringify([{ rootSlug: item.root_slug, path: item.path }]));
                  setDragDownload(event.dataTransfer, item.root_slug, [{ path: item.path, name: item.name, kind: item.kind === "folder" ? "folder" : "file" }]);
                  setDragPreview(event.dataTransfer, event.currentTarget, 1);
                }}
              >
                <FileIcon item={{ kind: item.kind === "folder" ? "folder" : "file", type: "", name: item.name }} />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate">{item.name}</span>
                  <span className="truncate text-xs text-faint">{where(item)}</span>
                </span>
                <button aria-label={t("Remove {name} from Shelf", { name: item.name })} className="rounded-sm p-1 text-muted opacity-0 group-hover:opacity-100 kago-flat hover:text-ink focus-visible:opacity-100" onClick={() => void remove(item.id)}>
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <footer className="flex flex-col gap-1.5 border-t border-line p-2">
            <span className="truncate text-xs text-muted">
              {active ? (activeList.data?.readonly ? t("The current window is read-only") : t("Send to “{title}”", { title: active.title })) : t("Pick a file window as the destination first")}
            </span>
            <div className="grid grid-cols-3 gap-1.5">
              <Button variant="default" disabled={!canSend} onClick={() => void send("copy")}>{t("Copy")}</Button>
              <Button disabled={!canSend} onClick={() => void send("move")}>{t("Move")}</Button>
              <Button disabled={!canSend} onClick={() => void send("compress")}>{t("Compress")}</Button>
            </div>
          </footer>
        </>
      )}
    </aside>
  );
}
