import type { ReactNode } from "react";
import { isInteractiveTarget, usePointerDrag } from "@/lib/usePointerDrag";
import { cn } from "@/lib/utils";
import { clampWindowPosition, getCanvasSize, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, useWorkspaceStore, type WindowFrame } from "@/stores/workspace";

type ResizeEdge = "e" | "s" | "se";

/** Window chrome: title bar, traffic-light controls, drag-to-move and edge resize. */
export function KagoWindow({ window, icon, titleExtra, className, children, ...props }: Omit<React.ComponentProps<"section">, "title"> & { window: WindowFrame; icon?: ReactNode; titleExtra?: ReactNode }) {
  const store = useWorkspaceStore.getState;
  const update = (patch: Partial<WindowFrame>) => store().updateWindow(window.id, patch);

  const moveHandlers = usePointerDrag(
    (event) => (window.maximized || isInteractiveTarget(event.target) ? null : { x: window.x, y: window.y }),
    (origin, dx, dy) => update(clampWindowPosition(origin.x + dx, origin.y + dy, window.width))
  );

  if (window.minimized) return null;

  return (
    <section
      data-window={window.id}
      className={cn(
        "absolute flex flex-col overflow-hidden bg-surface",
        window.maximized ? "inset-0" : "rounded-lg",
        window.focused ? "shadow-window-active" : "shadow-window",
        className
      )}
      style={window.maximized ? { zIndex: window.zIndex } : { left: window.x, top: window.y, width: window.width, height: window.height, zIndex: window.zIndex }}
      onPointerDownCapture={() => store().focusWindow(window.id)}
      {...props}
    >
      <header
        className="group/titlebar flex h-9 shrink-0 touch-none items-center gap-2 border-b border-line bg-elevated px-3 select-none"
        onDoubleClick={(event) => !isInteractiveTarget(event.target) && update({ maximized: !window.maximized })}
        {...moveHandlers}
      >
        <div className="flex items-center gap-2">
          <TrafficLight label="關閉視窗" tone="bg-danger" hoverTone="group-hover/titlebar:bg-danger" focused={window.focused} onClick={() => store().closeWindow(window.id)} />
          <TrafficLight label="最小化" tone="bg-warning" hoverTone="group-hover/titlebar:bg-warning" focused={window.focused} onClick={() => update({ minimized: true })} />
          <TrafficLight label={window.maximized ? "還原大小" : "最大化"} tone="bg-success" hoverTone="group-hover/titlebar:bg-success" focused={window.focused} onClick={() => update({ maximized: !window.maximized })} />
        </div>
        <div className={cn("flex min-w-0 flex-1 items-center justify-center gap-1.5 font-medium", !window.focused && "text-muted")}>
          {icon}
          <span className="truncate">{window.title}</span>
        </div>
        {/* Balances the traffic lights so the title stays centred. */}
        <div className="flex min-w-13 justify-end">{titleExtra}</div>
      </header>
      {children}
      {window.maximized ? null : (
        <>
          <ResizeHandle window={window} edge="e" className="top-9 right-0 bottom-3 w-1.5 cursor-ew-resize" />
          <ResizeHandle window={window} edge="s" className="right-3 bottom-0 left-0 h-1.5 cursor-ns-resize" />
          <ResizeHandle window={window} edge="se" className="right-0 bottom-0 size-3 cursor-nwse-resize" />
        </>
      )}
    </section>
  );
}

function TrafficLight({ label, tone, hoverTone, focused, onClick }: { label: string; tone: string; hoverTone: string; focused: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={cn("size-3 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/50", focused ? tone : ["bg-line-strong", hoverTone])}
      onClick={onClick}
    />
  );
}

function ResizeHandle({ window, edge, className }: { window: WindowFrame; edge: ResizeEdge; className: string }) {
  const handlers = usePointerDrag(
    () => ({ width: window.width, height: window.height }),
    (origin, dx, dy) => {
      const canvas = getCanvasSize();
      useWorkspaceStore.getState().updateWindow(window.id, {
        width: edge === "s" ? origin.width : Math.round(Math.max(MIN_WINDOW_WIDTH, Math.min(origin.width + dx, canvas.width - window.x))),
        height: edge === "e" ? origin.height : Math.round(Math.max(MIN_WINDOW_HEIGHT, Math.min(origin.height + dy, canvas.height - window.y)))
      });
    }
  );
  return <div className={cn("absolute z-10 touch-none", className)} {...handlers} />;
}
