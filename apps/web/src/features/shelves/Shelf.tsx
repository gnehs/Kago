import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, Inbox, X } from "lucide-react";
import { api } from "@/api/client";
import { useFileList, useShelves } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { FileIcon } from "@/features/files/FileIcon";
import { KAGO_DRAG_TYPE, readDraggedFiles } from "@/features/files/useFileActions";
import { ensureZipName, joinLogicalPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { isInteractiveTarget, usePointerDrag } from "@/lib/usePointerDrag";
import { cn } from "@/lib/utils";
import { promptText } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import { getCanvasSize, useWorkspaceStore } from "@/stores/workspace";

const MARGIN = 12;

/**
 * Workspace-level holding area. It stores references only; nothing is copied until the
 * user sends the shelf to a window, which enqueues a server task.
 */
export function Shelf() {
  const queryClient = useQueryClient();
  const shelves = useShelves();
  const shelfState = useWorkspaceStore((state) => state.shelf);
  const active = useWorkspaceStore((state) => state.windows.find((window) => window.id === state.activeWindowId && !window.minimized));
  const activeList = useFileList(active?.rootSlug ?? "", active?.logicalPath ?? "/", Boolean(active));
  const element = useRef<HTMLElement>(null);
  const [size, setSize] = useState({ width: 264, height: 40 });
  const [dropActive, setDropActive] = useState(false);
  const store = useWorkspaceStore.getState;
  const shelf = shelves.data?.[0];
  const collapsed = Boolean(shelfState.collapsed);
  const itemCount = shelf?.items.length ?? 0;

  useLayoutEffect(() => {
    if (element.current) setSize({ width: element.current.offsetWidth, height: element.current.offsetHeight });
  }, [collapsed, itemCount, Boolean(shelf)]);

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

  if (!shelf) return null;
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
    }, "無法加入中轉區");
  }

  async function send(type: "copy" | "move" | "compress") {
    if (!active) return;
    let path = active.logicalPath;
    if (type === "compress") {
      const name = await promptText({ title: "將中轉區壓縮成 zip", defaultValue: "shelf.zip", confirmLabel: "壓縮" });
      if (!name) return;
      path = joinLogicalPath(active.logicalPath, ensureZipName(name));
    }
    await run(async () => {
      await api(`/api/shelves/${shelfId}/tasks`, { method: "POST", body: JSON.stringify({ type, destination: { rootSlug: active.rootSlug, path } }) });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast("已建立任務");
    });
  }

  async function remove(itemId: string) {
    await run(async () => {
      await api(`/api/shelves/${shelfId}/items/${itemId}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["shelves"] });
    });
  }

  return (
    <aside
      ref={element}
      aria-label="中轉區"
      className={cn("absolute z-[600] flex w-66 flex-col rounded-lg bg-surface shadow-popup", dropActive && "ring-2 ring-accent")}
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
        <strong className="flex-1 font-medium">中轉區</strong>
        {itemCount > 0 ? <KagoBadge tone="accent">{itemCount}</KagoBadge> : null}
        <KagoIconButton label={collapsed ? "展開中轉區" : "收合中轉區"} onClick={() => store().updateShelf({ collapsed: !collapsed })}>
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </KagoIconButton>
      </header>

      {collapsed ? null : itemCount === 0 ? (
        <p className="m-2 mt-0 rounded-md border border-dashed border-line-strong px-3 py-5 text-center text-muted">
          把檔案拖到這裡暫放
          <span className="mt-0.5 block text-xs text-faint">只記錄位置，不會複製檔案</span>
        </p>
      ) : (
        <>
          <ul className="m-0 flex max-h-52 list-none flex-col overflow-y-auto border-t border-line p-1">
            {shelf.items.map((item) => (
              <li
                key={item.id}
                draggable
                className="group flex h-9 items-center gap-2 rounded-md px-2 hover:bg-hover"
                title={`${item.root_slug}:${item.path}`}
                onDragStart={(event) => event.dataTransfer.setData(KAGO_DRAG_TYPE, JSON.stringify([{ rootSlug: item.root_slug, path: item.path }]))}
              >
                <FileIcon item={{ kind: item.kind === "folder" ? "folder" : "file", type: "", name: item.name }} />
                <span className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate">{item.name}</span>
                  <span className="truncate text-xs text-faint">{item.root_slug}:{item.path}</span>
                </span>
                <button aria-label={`從中轉區移除 ${item.name}`} className="rounded-sm p-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100" onClick={() => void remove(item.id)}>
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <footer className="flex flex-col gap-1.5 border-t border-line p-2">
            <span className="truncate text-xs text-muted">
              {active ? (activeList.data?.readonly ? "目前視窗是唯讀的" : `送到「${active.title}」`) : "先選一個檔案視窗作為目的地"}
            </span>
            <div className="grid grid-cols-3 gap-1.5">
              <Button variant="default" disabled={!canSend} onClick={() => void send("copy")}>複製</Button>
              <Button disabled={!canSend} onClick={() => void send("move")}>搬移</Button>
              <Button disabled={!canSend} onClick={() => void send("compress")}>壓縮</Button>
            </div>
          </footer>
        </>
      )}
    </aside>
  );
}
