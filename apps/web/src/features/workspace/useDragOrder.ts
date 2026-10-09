import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** How far the pointer has to travel before a press is a drag and not a click. */
const SLOP = 6;
/** Half the space between two items, which belongs to neither. */
const GAP = 2;

type Rect = { left: number; right: number; top: number; bottom: number };
type Drag = { id: string; order: string[]; x: number; y: number };

/** Whether a point comes before an item, in a column that runs down and wraps to the right. */
const comesBefore = (x: number, y: number, rect: Rect) => (x < rect.left - GAP ? true : x > rect.right + GAP ? false : y < (rect.top + rect.bottom) / 2);

/**
 * Lets the items of a column that wraps be put in another order by dragging one of them. The item follows the
 * pointer and the others make room as it passes; nothing is decided until it is let go, and a press that goes
 * nowhere is still a click. `order` is what to draw: the given order, or the one being tried while a drag is on.
 */
export function useDragOrder(ids: string[], onDrop: (ids: string[]) => void) {
  const [drag, setDrag] = useState<Drag | null>(null);
  // The drag as the pointer last left it. What is drawn follows a moment behind, and letting go must not wait for it.
  const latest = useRef<Drag | null>(null);
  const update = (next: Drag | null) => {
    latest.current = next;
    setDrag(next);
  };
  const press = useRef<{ id: string; x: number; y: number; grabX: number; grabY: number } | null>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  /** Set by a drag, so that the click its release brings about opens nothing. */
  const dragged = useRef(false);

  // The dragged item is drawn where the pointer holds it, wherever the order being tried has put it.
  useLayoutEffect(() => {
    if (!drag || !press.current) return;
    const element = elements.current.get(drag.id);
    if (!element) return;
    element.style.transform = "";
    const rect = element.getBoundingClientRect();
    element.style.transform = `translate(${drag.x - press.current.grabX - rect.left}px, ${drag.y - press.current.grabY - rect.top}px)`;
    return () => {
      element.style.transform = "";
    };
  }, [drag]);

  /** Where among the others the pointer is: after every one it does not come before. */
  function orderAt(id: string, order: string[], x: number, y: number) {
    const others = order.filter((other) => other !== id);
    let index = 0;
    for (const other of others) {
      const rect = elements.current.get(other)?.getBoundingClientRect();
      if (rect && !comesBefore(x, y, rect)) index += 1;
    }
    const next = [...others.slice(0, index), id, ...others.slice(index)];
    return next.every((value, at) => value === order[at]) ? order : next;
  }

  // Read as they are when the pointer moves, not as they were when it was pressed.
  const given = useRef({ ids, onDrop });
  given.current = { ids, onDrop };
  /** Stops listening for the pointer, when a press is on. */
  const release = useRef<(() => void) | null>(null);
  useEffect(() => () => release.current?.(), []);

  return {
    order: drag?.order ?? ids,
    draggingId: drag?.id ?? null,
    /** What an item is given to take part: where it is, and what happens to it under the pointer. */
    item: (id: string) => ({
      ref: (element: HTMLElement | null) => {
        if (element) elements.current.set(id, element);
        else elements.current.delete(id);
      },
      "data-dragging": drag?.id === id ? "" : undefined,
      onPointerDown: (event: React.PointerEvent<HTMLElement>) => {
        dragged.current = false;
        if (!event.isPrimary || event.button !== 0) return;
        release.current?.();
        const element = event.currentTarget;
        const pointerId = event.pointerId;
        const rect = element.getBoundingClientRect();
        press.current = { id, x: event.clientX, y: event.clientY, grabX: event.clientX - rect.left, grabY: event.clientY - rect.top };
        // The pointer is followed across the whole window: a quick hand is off the icon before the press has become a drag.
        const move = (moved: PointerEvent) => {
          const held = press.current;
          if (moved.pointerId !== pointerId || !held) return;
          if (!latest.current) {
            if (Math.hypot(moved.clientX - held.x, moved.clientY - held.y) < SLOP) return;
            dragged.current = true;
            // From here on the item has the pointer, so nothing else answers to it on the way.
            if (element.isConnected) element.setPointerCapture(pointerId);
          }
          update({ id, order: orderAt(id, latest.current?.order ?? given.current.ids, moved.clientX, moved.clientY), x: moved.clientX, y: moved.clientY });
        };
        const finish = (ended: PointerEvent) => {
          if (ended.pointerId !== pointerId) return;
          release.current?.();
          const order = latest.current?.order;
          press.current = null;
          update(null);
          if (order && ended.type === "pointerup" && order.some((item, index) => item !== given.current.ids[index])) given.current.onDrop(order);
        };
        release.current = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", finish);
          window.removeEventListener("pointercancel", finish);
          release.current = null;
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", finish);
        window.addEventListener("pointercancel", finish);
      },
      onClickCapture: (event: React.MouseEvent<HTMLElement>) => {
        if (!dragged.current) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    })
  };
}
