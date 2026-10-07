import { Maximize2, Minimize2, Minus, X, type LucideIcon } from "lucide-react";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { animateWindowBox, animateWindowIn } from "@/lib/motion";
import { isInteractiveTarget, usePointerDrag } from "@/lib/usePointerDrag";
import { cn } from "@/lib/utils";
import { clampWindowPosition, fitAspectSize, getCanvasSize, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, minimizeWindows, requestCloseWindow, TITLEBAR_HEIGHT, useWorkspaceStore, type WindowFrame } from "@/stores/workspace";
import { t } from "@/lib/i18n";

type ResizeEdge = "e" | "s" | "se";

/** Window chrome: title bar, window controls, drag-to-move and edge resize. */
export function KagoWindow({
  window,
  icon,
  titleExtra,
  titleBar,
  keepMounted,
  className,
  children,
  ...props
}: Omit<React.ComponentProps<"section">, "title"> & { window: WindowFrame; icon?: ReactNode; titleExtra?: ReactNode; /** Takes the place of the icon and title in the middle of the title bar, for a window that has more to show there than its name. */ titleBar?: ReactNode; /** Hide rather than unmount while minimized, for content that holds unsaved work. */ keepMounted?: boolean }) {
  const store = useWorkspaceStore.getState;
  const update = (patch: Partial<WindowFrame>) => store().updateWindow(window.id, patch);

  const moveHandlers = usePointerDrag(
    (event) => (window.maximized || isInteractiveTarget(event.target) ? null : { x: window.x, y: window.y }),
    (origin, dx, dy) => update(clampWindowPosition(origin.x + dx, origin.y + dy, window.width))
  );

  const element = useRef<HTMLElement>(null);
  /** What the window looked like the last time it was drawn, to know what it is coming from. */
  const last = useRef<{ minimized: boolean; maximized: boolean; box: { left: number; top: number; width: number; height: number } | null } | null>(null);

  // A window is seen to arrive, to come back out of the top bar, and to grow or shrink when it is maximized.
  // Moving and resizing by hand are never animated: the window is under the pointer and has to stay there.
  useLayoutEffect(() => {
    const node = element.current;
    const shown = node && !window.minimized;
    const box = shown ? { left: node.offsetLeft, top: node.offsetTop, width: node.offsetWidth, height: node.offsetHeight } : null;
    const before = last.current;
    if (shown && (!before || before.minimized)) animateWindowIn(node, window.id, Boolean(before?.minimized));
    else if (shown && box && before?.box && before.maximized !== window.maximized) animateWindowBox(node, before.box, box, window.maximized);
    last.current = { minimized: window.minimized, maximized: window.maximized, box };
  });

  if (window.minimized && !keepMounted) return null;

  return (
    <section
      ref={element}
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
        className="kago-chrome flex h-9 shrink-0 touch-none items-center gap-2 border-b border-line-strong px-2 select-none"
        onDoubleClick={(event) => !isInteractiveTarget(event.target) && update({ maximized: !window.maximized })}
        {...moveHandlers}
      >
        <div className="kago-window-controls">
          <WindowControl label={t("Close window (⌥W)")} closes icon={X} onClick={() => void requestCloseWindow(window.id)} />
          <WindowControl label={t("Minimize")} icon={Minus} onClick={() => minimizeWindows([window.id])} />
          <WindowControl label={window.maximized ? t("Restore size") : t("Maximize")} icon={window.maximized ? Minimize2 : Maximize2} onClick={() => update({ maximized: !window.maximized })} />
        </div>
        {titleBar ?? (
          <div className={cn("flex min-w-0 flex-1 items-center justify-center gap-1.5 font-medium", !window.focused && "text-muted")}>
            {icon}
            <span className="truncate">{window.title}</span>
          </div>
        )}
        {/* Balances the window controls so the title stays centred. */}
        <div className="kago-window-extra items-center gap-1.5">{titleExtra}</div>
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

function WindowControl({ label, closes, icon: Icon, onClick }: { label: string; closes?: boolean; icon: LucideIcon; onClick: () => void }) {
  return (
    <button type="button" aria-label={label} title={label} data-closes={closes ? "" : undefined} className="kago-window-control outline-none focus-visible:ring-2 focus-visible:ring-accent/50" onClick={onClick}>
      <Icon aria-hidden className="size-3" strokeWidth={2.2} />
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
