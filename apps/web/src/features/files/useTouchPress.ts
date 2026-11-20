import { useEffect, useRef } from "react";
import type { FileItem } from "@/types/kago";

/** How long a finger rests on an item before it picks the item out instead of opening it, and how far it may drift meanwhile. */
const HOLD_MS = 450;
const HOLD_SLOP = 10;

type Press = { pointerId: number; x: number; y: number; timer: ReturnType<typeof setTimeout> | undefined; held: boolean };

export type TouchPress = ReturnType<typeof useTouchPress>;

/**
 * A finger on the items of a file list. Resting on an item is `onHold`, and the click that ends the hold is swallowed.
 * Mouse and pen are only told apart here, never handled: they go on clicking and double-clicking as before.
 */
export function useTouchPress(onHold: (item: FileItem) => void) {
  const press = useRef<Press | null>(null);
  const touch = useRef(false);
  useEffect(() => () => clearTimeout(press.current?.timer), []);

  const settle = (event: React.PointerEvent) => {
    if (press.current?.pointerId === event.pointerId) clearTimeout(press.current.timer);
  };

  return {
    handlers: (item: FileItem) => ({
      onPointerDown(event: React.PointerEvent) {
        clearTimeout(press.current?.timer);
        touch.current = event.pointerType === "touch";
        if (!touch.current || !event.isPrimary) return void (press.current = null);
        const current: Press = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, held: false, timer: undefined };
        current.timer = setTimeout(() => {
          current.held = true;
          onHold(item);
        }, HOLD_MS);
        press.current = current;
      },
      onPointerMove(event: React.PointerEvent) {
        const current = press.current;
        if (current?.pointerId === event.pointerId && Math.hypot(event.clientX - current.x, event.clientY - current.y) > HOLD_SLOP) clearTimeout(current.timer);
      },
      onPointerUp: settle,
      onPointerCancel: settle
    }),
    /** What made the click being handled: a mouse or pen, a tap of a finger, or a finger lifted after a hold. */
    click: (): "pointer" | "tap" | "held" => (!touch.current ? "pointer" : press.current?.held ? "held" : "tap"),
    /**
     * A context menu asked for by a finger (Android sends one for a long press) is a hold, whichever of the two comes
     * first. Answers whether it was a finger.
     */
    contextMenu(item: FileItem) {
      if (!touch.current) return false;
      clearTimeout(press.current?.timer);
      if (press.current) press.current.held = true;
      onHold(item);
      return true;
    }
  };
}
