import { Maximize2, Minimize2, Minus, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { isInteractiveTarget, usePointerDrag } from "@/lib/usePointerDrag";
import { cn } from "@/lib/utils";
import { clampWindowPosition, fitAspectSize, getCanvasSize, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, requestCloseWindow, TITLEBAR_HEIGHT, useWorkspaceStore, type WindowFrame } from "@/stores/workspace";

type ResizeEdge = "e" | "s" | "se";

/** Window chrome: title bar, traffic-light controls, drag-to-move and edge resize. */
export function KagoWindow({
  window,
  icon,
  titleExtra,
  keepMounted,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & { window: WindowFrame; icon?: ReactNode; titleExtra?: ReactNode; /** Hide rather than unmount while minimized, for content that holds unsaved work. */ keepMounted?: boolean }) {
  const store = useWorkspaceStore.getState;
  const update = (patch: Partial<WindowFrame>) => store().updateWindow(window.id, patch);

  const moveHandlers = usePointerDrag(
    (event) => (window.maximized || isInteractiveTarget(event.target) ? null : { x: window.x, y: window.y }),
    (origin, dx, dy) => update(clampWindowPosition(origin.x + dx, origin.y + dy, window.width))
  );

  if (window.minimized && !keepMounted) return null;

  return (
    <section
      data-window={window.id}
      hidden={window.minimized}
      data-inactive={window.focused ? undefined : ""}
      data-maximized={window.maximized ? "" : undefined}
      className={cn(
        "kago-window absolute flex flex-col overflow-hidden bg-surface",
        window.maximized ? "inset-0" : "rounded-lg",
        window.focused ? "shadow-window-active" : "shadow-window",
        className
      )}
      style={window.maximized ? { zIndex: window.zIndex } : { left: window.x, top: window.y, width: window.width, height: window.height, zIndex: window.zIndex }}
      onPointerDownCapture={() => store().focusWindow(window.id)}
      {...props}
    >
      <header
        className="kago-chrome flex h-9 shrink-0 touch-none items-center gap-2 border-b border-line px-3 select-none"
        onDoubleClick={(event) => !isInteractiveTarget(event.target) && update({ maximized: !window.maximized })}
        {...moveHandlers}
      >
        {/* Hovering any light reveals all three glyphs, and wakes the colours of an unfocused window. */}
        <div className="kago-lights group/lights flex items-center gap-2">
          <TrafficLight label="關閉視窗（⌥W）" tone="close" icon={X} focused={window.focused} onClick={() => void requestCloseWindow(window.id)} />
          <TrafficLight label="最小化" tone="minimize" icon={Minus} focused={window.focused} onClick={() => update({ minimized: true })} />
          <TrafficLight
            label={window.maximized ? "還原大小" : "最大化"}
            tone="zoom"
            icon={window.maximized ? Minimize2 : Maximize2}
            focused={window.focused}
            onClick={() => update({ maximized: !window.maximized })}
          />
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

function TrafficLight({ label, tone, icon: Icon, focused, onClick }: { label: string; tone: "close" | "minimize" | "zoom"; icon: LucideIcon; focused: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-on={focused || undefined}
      className="kago-light flex size-3 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
      style={{ "--tone": `var(--kago-light-${tone})` } as React.CSSProperties}
      onClick={onClick}
    >
      <Icon aria-hidden className="size-2 text-black/60 opacity-0 group-hover/lights:opacity-100 group-has-focus-visible/lights:opacity-100" strokeWidth={3.5} />
    </button>
  );
}

function ResizeHandle({ window, edge, className }: { window: WindowFrame; edge: ResizeEdge; className: string }) {
  const handlers = usePointerDrag(
    () => ({ width: window.width, height: window.height }),
    (origin, dx, dy) => {
      const canvas = getCanvasSize();
      if (window.aspect) {
        // Whichever edge is dragged, the other follows; the corner goes with the larger of the two.
        const byWidth = origin.width + dx;
        const byHeight = (origin.height + dy - TITLEBAR_HEIGHT) * window.aspect;
        const width = edge === "e" ? byWidth : edge === "s" ? byHeight : Math.max(byWidth, byHeight);
        useWorkspaceStore.getState().updateWindow(window.id, fitAspectSize(window.aspect, width, canvas.width - window.x, canvas.height - window.y));
        return;
      }
      useWorkspaceStore.getState().updateWindow(window.id, {
        width: edge === "s" ? origin.width : Math.round(Math.max(MIN_WINDOW_WIDTH, Math.min(origin.width + dx, canvas.width - window.x))),
        height: edge === "e" ? origin.height : Math.round(Math.max(MIN_WINDOW_HEIGHT, Math.min(origin.height + dy, canvas.height - window.y)))
      });
    }
  );
  return <div className={cn("absolute z-10 touch-none", className)} {...handlers} />;
}
