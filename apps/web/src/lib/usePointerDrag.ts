import { useRef } from "react";

/**
 * Pointer-capture drag helper. `start` snapshots whatever the drag needs (return null to
 * ignore the gesture) and `move` receives that snapshot plus the pointer delta.
 */
export function usePointerDrag<T>(start: (event: React.PointerEvent<HTMLElement>) => T | null, move: (origin: T, dx: number, dy: number) => void) {
  const drag = useRef<{ pointerId: number; x: number; y: number; origin: T } | null>(null);

  function end(event: React.PointerEvent<HTMLElement>) {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }

  return {
    onPointerDown(event: React.PointerEvent<HTMLElement>) {
      if (!event.isPrimary || event.button !== 0) return;
      const origin = start(event);
      if (origin === null) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, origin };
    },
    onPointerMove(event: React.PointerEvent<HTMLElement>) {
      const current = drag.current;
      if (current?.pointerId === event.pointerId) move(current.origin, event.clientX - current.x, event.clientY - current.y);
    },
    onPointerUp: end,
    onPointerCancel: end
  };
}

export function isInteractiveTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && Boolean(target.closest("button, a, input, textarea, select, label"));
}

export function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
}
