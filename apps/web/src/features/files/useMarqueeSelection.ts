import { useState } from "react";
import { useWorkspaceStore } from "@/stores/workspace";

type Marquee = { pointerId: number; startX: number; startY: number; x: number; y: number };

function localPoint(event: React.PointerEvent<HTMLElement>) {
  const element = event.currentTarget;
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left + element.scrollLeft, y: event.clientY - rect.top + element.scrollTop };
}

const bounds = (marquee: Marquee) => ({
  left: Math.min(marquee.startX, marquee.x),
  top: Math.min(marquee.startY, marquee.y),
  right: Math.max(marquee.startX, marquee.x),
  bottom: Math.max(marquee.startY, marquee.y)
});

/**
 * Rubber-band selection that starts on the blank area of a file list.
 * `pathsInArea` answers which items an area of the scrolled content covers; rows outside the viewport are not in the DOM to be measured.
 */
export function useMarqueeSelection(windowId: string, pathsInArea: (area: ReturnType<typeof bounds>) => string[]) {
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const select = (paths: string[]) => useWorkspaceStore.getState().selectItems(windowId, paths);

  function end(event: React.PointerEvent<HTMLElement>) {
    if (marquee?.pointerId === event.pointerId) setMarquee(null);
  }

  const box = marquee ? bounds(marquee) : null;

  return {
    style: box ? { left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top } : null,
    handlers: {
      onPointerDown(event: React.PointerEvent<HTMLElement>) {
        if (!event.isPrimary || event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest("[data-file-path], button, a, input")) return;
        const point = localPoint(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        setMarquee({ pointerId: event.pointerId, startX: point.x, startY: point.y, ...point });
        select([]);
      },
      onPointerMove(event: React.PointerEvent<HTMLElement>) {
        if (marquee?.pointerId !== event.pointerId) return;
        const next = { ...marquee, ...localPoint(event) };
        setMarquee(next);
        select(pathsInArea(bounds(next)));
      },
      onPointerUp: end,
      onPointerCancel: end
    }
  };
}
