import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArrowDownToLine, ChevronDown, ChevronUp, Copy, Ellipsis, FolderInput, ListX, X } from "lucide-react";
import { api, thumbnailUrl } from "@/api/client";
import { useFileList, useRoots, useShelves } from "@/api/hooks";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { setDragDownload, setDragPreview } from "@/features/files/dragOut";
import { FileTile } from "@/features/files/FileIcon";
import { extensionOf, kindOfExtension, thumbnailKind, type FileKind } from "@/features/files/fileKind";
import { KAGO_DRAG_TYPE, readDraggedFiles } from "@/features/files/useFileActions";
import { displayPath, ensureZipName, joinLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { useCompact } from "@/lib/useCompact";
import { isInteractiveTarget, usePointerDrag } from "@/lib/usePointerDrag";
import { cn } from "@/lib/utils";
import { promptCompress, type CompressChoice } from "@/features/files/CompressDialog";
import { toast } from "@/stores/toast";
import { getCanvasSize, useWorkspaceStore } from "@/stores/workspace";
import { t } from "@/lib/i18n";
import type { Shelf as ShelfData } from "@/types/kago";

type ShelfItem = ShelfData["items"][number];

const MARGIN = 12;
/** A collapsed shelf is a pile of its newest items: the top one square, the ones under it turned a little either way. */
const PILE = ["", "-translate-x-2.5 translate-y-0.5 -rotate-[8deg]", "translate-x-2.5 translate-y-1 rotate-[7deg]"];
/** The shelf keeps the name of a file and not its type, so the ending of the name stands in for one where a type is what tells a kind. */
const TYPES: Partial<Record<FileKind, string>> = { image: "image/*", video: "video/*", pdf: "application/pdf" };

/**
 * Workspace-level holding area. It stores references only; nothing is copied until the
 * user drags them out to a window or sends the whole shelf there, which enqueues a server task.
 */
export function Shelf() {
  const queryClient = useQueryClient();
  const compact = useCompact();
  const shelves = useShelves();
  const roots = useRoots().data;
  const shelfState = useWorkspaceStore((state) => state.shelf);
  const active = useWorkspaceStore((state) => state.windows.find((window) => window.id === state.activeWindowId && !window.minimized));
  const activeList = useFileList(active?.rootSlug ?? "", active?.logicalPath ?? "/", Boolean(active));
  const element = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 264, height: 40 });
  const [dropActive, setDropActive] = useState(false);
  const [dragging, setDragging] = useState(false);
  // What is dragged off the shelf is already on it, so it cannot be dropped back.
  const draggingOut = useRef(false);
  const store = useWorkspaceStore.getState;
  const shelf = shelves.data?.[0];
  const collapsed = Boolean(shelfState.collapsed);
  const itemCount = shelf?.items.length ?? 0;

  // The shelf stays out of the way until there is something to drop on it.
  useEffect(() => {
    const onDragStart = (event: DragEvent) => setDragging(Boolean(event.dataTransfer?.types.includes(KAGO_DRAG_TYPE)));
    const onDragEnd = () => {
      draggingOut.current = false;
      setDragging(false);
      setDropActive(false);
    };
    window.addEventListener("dragstart", onDragStart);
    window.addEventListener("dragend", onDragEnd);
    window.addEventListener("drop", onDragEnd);
    // A drag dropped outside the browser, onto the desktop or a Finder window, does not always report its end.
    // The pointer is silent for as long as a drag lasts, so hearing from it again means the drag is over.
    window.addEventListener("pointermove", onDragEnd);
    window.addEventListener("pointerdown", onDragEnd);
    return () => {
      window.removeEventListener("dragstart", onDragStart);
      window.removeEventListener("dragend", onDragEnd);
      window.removeEventListener("drop", onDragEnd);
      window.removeEventListener("pointermove", onDragEnd);
      window.removeEventListener("pointerdown", onDragEnd);
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
  // Until the user drags it, the shelf rests in the bottom-right corner of the canvas. On a phone every window
  // reaches that corner, so it rests a bar higher, clear of the actions at the foot of the window.
  const placed = shelfState.x !== undefined && shelfState.y !== undefined;
  const style = placed ? (({ x, y }) => ({ left: x, top: y }))(clamp(shelfState.x!, shelfState.y!)) : { right: MARGIN, bottom: compact ? MARGIN + 32 : MARGIN };

  // The shelf is moved by whatever part of it does nothing else: not its controls, nor the items, which are dragged out of it.
  // Its menu is mounted elsewhere in the document, and what happens there still reaches these handlers.
  const dragHandlers = usePointerDrag(
    (event) => {
      const target = event.target as Element;
      if (!element.current?.contains(target) || isInteractiveTarget(target) || target.closest("[draggable=true], ul")) return null;
      return { x: element.current.offsetLeft, y: element.current.offsetTop };
    },
    (origin, dx, dy) => store().updateShelf(clamp(origin.x + dx, origin.y + dy))
  );

  if (!shelf || (itemCount === 0 && !dragging)) return null;
  const shelfId = shelf.id;
  const items = shelf.items;
  const canSend = Boolean(active) && !activeList.data?.readonly && itemCount > 0;

  async function addDropped(event: React.DragEvent) {
    event.preventDefault();
    setDropActive(false);
    const dropped = readDraggedFiles(event.dataTransfer);
    if (dropped.length === 0) return;
    await run(async () => {
      await Promise.all(dropped.map((item) => api(`/api/shelves/${shelfId}/items`, { method: "POST", body: JSON.stringify(item) })));
      await queryClient.invalidateQueries({ queryKey: ["shelves"] });
    }, t("Couldn’t add to Shelf"));
  }

  async function send(type: "copy" | "move" | "compress") {
    if (!active) return;
    let path = active.logicalPath;
    let options: CompressChoice["options"] | undefined;
    if (type === "compress") {
      const choice = await promptCompress({ title: t("Compress the Shelf to zip"), defaultName: "shelf.zip" });
      if (!choice) return;
      path = joinLogicalPath(active.logicalPath, ensureZipName(choice.name));
      options = choice.options;
    }
    await run(async () => {
      await api(`/api/shelves/${shelfId}/tasks`, { method: "POST", body: JSON.stringify({ type, destination: { rootSlug: active.rootSlug, path }, options }) });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast(t("Task created"));
    });
  }

  const where = (item: ShelfItem) => displayPath(roots?.find((root) => root.slug === item.root_slug)?.name ?? item.root_slug, item.path);

  async function remove(removed: ShelfItem[]) {
    await run(async () => {
      await Promise.all(removed.map((item) => api(`/api/shelves/${shelfId}/items/${item.id}`, { method: "DELETE" })));
      await queryClient.invalidateQueries({ queryKey: ["shelves"] });
    });
  }

  /** Dragged out, items are what they would be coming from a file window: dropped on one they are copied or moved, outside the browser downloaded. */
  function dragOut(event: React.DragEvent<HTMLElement>, dragged: ShelfItem[]) {
    draggingOut.current = true;
    event.dataTransfer.setData(KAGO_DRAG_TYPE, JSON.stringify(dragged.map((item) => ({ rootSlug: item.root_slug, path: item.path }))));
    // One address downloads from one place, so items gathered from several only go to file windows.
    const rootSlug = dragged[0]!.root_slug;
    if (dragged.every((item) => item.root_slug === rootSlug)) setDragDownload(event.dataTransfer, rootSlug, dragged.map((item) => ({ path: item.path, name: item.name, kind: item.kind === "folder" ? "folder" : "file" })));
    setDragPreview(event.dataTransfer, event.currentTarget, dragged.length);
  }

  // Sending the whole shelf somewhere is asked for now and then, and waits in the menu; dragging is what the shelf is for.
  const menu = (
    <KagoDropdownMenu
      label={t("More actions")}
      menu={
        <>
          <div className="max-w-60 truncate px-2 py-1 text-xs text-muted">
            {active ? (activeList.data?.readonly ? t("The current window is read-only") : t("Send to “{title}”", { title: active.title })) : t("Pick a file window as the destination first")}
          </div>
          <KagoMenuItem icon={<Copy />} disabled={!canSend} onClick={() => void send("copy")}>{t("Copy")}</KagoMenuItem>
          <KagoMenuItem icon={<FolderInput />} disabled={!canSend} onClick={() => void send("move")}>{t("Move")}</KagoMenuItem>
          <KagoMenuItem icon={<Archive />} disabled={!canSend} onClick={() => void send("compress")}>{t("Compress")}</KagoMenuItem>
          <KagoMenuSeparator />
          <KagoMenuItem icon={<ListX />} onClick={() => void remove(items)}>{t("Clear Shelf")}</KagoMenuItem>
        </>
      }
    >
      <Ellipsis />
    </KagoDropdownMenu>
  );

  return (
    <aside
      ref={element}
      aria-label={t("Shelf")}
      className={cn("absolute z-[600] kago-glass flex flex-col rounded-lg select-none", dropActive && "outline-2 -outline-offset-1 outline-accent")}
      style={style}
      onDragOver={(event) => {
        if (draggingOut.current) return;
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setDropActive(false)}
      onDrop={(event) => void addDropped(event)}
      {...dragHandlers}
    >
      {itemCount === 0 ? (
        <p className={cn("m-2 flex w-48 flex-col items-center rounded-md border border-dashed border-line-strong px-3 py-5 text-center text-muted", dropActive && "border-accent bg-accent/10 text-accent")}>
          <ArrowDownToLine className="mb-2 size-5" />
          {t("Drag files here to hold them")}
          <span className={cn("mt-0.5 text-xs", dropActive ? "opacity-70" : "text-faint")}>{t("Only their location is kept; nothing is copied")}</span>
        </p>
      ) : collapsed ? (
        <div className="relative flex w-32 touch-none flex-col items-center px-2 pt-4 pb-1.5">
          <div className="absolute top-1 right-1">{menu}</div>
          {/* The pile is the whole shelf in one hand: dragged, everything on it goes along. */}
          <div
            role="button"
            tabIndex={0}
            draggable
            aria-label={t("Expand Shelf")}
            className="relative flex size-20 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            onClick={() => store().updateShelf({ collapsed: false })}
            onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && store().updateShelf({ collapsed: false })}
            onDragStart={(event) => dragOut(event, items)}
          >
            {items.slice(0, PILE.length).map((item, index) => (
              <span key={item.id} className={cn("absolute flex size-15 items-center justify-center overflow-hidden rounded-md bg-elevated shadow-md ring-2 ring-white", PILE[index])} style={{ zIndex: PILE.length - index }}>
                <Preview item={item} icon="size-10" />
              </span>
            ))}
          </div>
          <button className="mt-1 flex h-6 items-center gap-0.5 rounded-full pr-1.5 pl-2.5 text-xs text-muted kago-flat hover:text-ink" onClick={() => store().updateShelf({ collapsed: false })}>
            {t("{count} item | {count} items", { count: itemCount })}
            <ChevronUp className="size-3.5" />
          </button>
        </div>
      ) : (
        <>
          <header className="flex h-10 w-64 shrink-0 touch-none items-center gap-1.5 pr-1.5 pl-3">
            <strong className="font-medium">{t("Shelf")}</strong>
            <span className="flex-1 text-faint tabular-nums">{itemCount}</span>
            {menu}
            <KagoIconButton label={t("Collapse Shelf")} onClick={() => store().updateShelf({ collapsed: true })}>
              <ChevronDown />
            </KagoIconButton>
          </header>
          <ul className={cn("m-0 grid max-h-80 w-64 list-none gap-2 overflow-y-auto p-2 pt-0", itemCount === 1 ? "grid-cols-1" : "grid-cols-2")}>
            {items.map((item) => (
              <li key={item.id} draggable className="group relative flex min-w-0 flex-col gap-1" title={where(item)} onDragStart={(event) => dragOut(event, [item])}>
                <span className="relative flex aspect-[4/3] items-center justify-center overflow-hidden rounded-md bg-hover after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-ink/10 after:ring-inset">
                  <Preview item={item} icon="size-12" />
                </span>
                <span className="truncate px-0.5 text-center text-xs">{item.name}</span>
                <button
                  aria-label={t("Remove {name} from Shelf", { name: item.name })}
                  className="absolute top-1 right-1 flex size-5 items-center justify-center rounded-full bg-black/55 text-white opacity-0 backdrop-blur-sm group-hover:opacity-100 hover:bg-black/75 focus-visible:opacity-100 pointer-coarse:opacity-100"
                  onClick={() => void remove([item])}
                >
                  <X className="size-3" />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </aside>
  );
}

/**
 * What an item holds, filling the frame it is in: a picture, a frame of a video or the first page of a document, cropped to fit.
 * Everything else is its icon, as is anything whose thumbnail has not arrived or cannot be made.
 */
function Preview({ item, icon }: { item: ShelfItem; icon: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  const file = { kind: item.kind === "folder" ? ("folder" as const) : ("file" as const), type: TYPES[kindOfExtension(extensionOf(item.name))] ?? "", name: item.name, size: item.size };
  const shows = thumbnailKind(file);
  const pictured = shows !== null && shows !== "text" && state !== "failed";
  return (
    <>
      {pictured && state === "loaded" ? null : <FileTile item={file} className={icon} />}
      {pictured ? (
        <img
          alt=""
          loading="lazy"
          draggable={false}
          src={thumbnailUrl(item.root_slug, item.path)}
          // Until it has loaded it sits unseen over the icon, since a hidden image is never fetched. A page is read from its top.
          className={cn("absolute inset-0 size-full object-cover", shows === "page" && "object-top", state !== "loaded" && "opacity-0")}
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      ) : null}
    </>
  );
}
