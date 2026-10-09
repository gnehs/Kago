import { useState, type ComponentProps, type ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";
import { KagoTooltip } from "./tooltip";

/**
 * Kago's context menu. `children` is the right-click target; `menu` is rendered lazily
 * so callers can build it from whatever was under the pointer.
 */
export function KagoContextMenu({ menu, children, className, ...props }: Omit<ComponentProps<typeof ContextMenu.Trigger>, "children"> & { menu: ReactNode; children: ReactNode }) {
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger className={className} {...props}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Positioner collisionPadding={8} className="z-[800] outline-none">
          <ContextMenu.Popup className="kago-glass kago-pop max-h-(--available-height) min-w-44 cursor-default overflow-y-auto overscroll-contain rounded-lg p-1 outline-none select-none">{menu}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * The same menu opened from a button, for pointers without a right click. Takes the
 * `KagoMenuItem`s a context menu would, so both entrances always offer identical actions.
 */
export function KagoDropdownMenu({
  label,
  menu,
  className,
  side,
  sideOffset = 4,
  align = "end",
  raised,
  container,
  onOpenChange,
  children
}: {
  label: string;
  menu: ReactNode;
  className?: string;
  side?: "top" | "bottom";
  /** How far from its button the popup hangs. */
  sideOffset?: number;
  /** Drawn as a button with a body, to stand beside other such buttons (at the end of a row of a list) instead of on a bar. */
  raised?: boolean;
  /** Which edge of the button the popup lines up with. */
  align?: "start" | "end";
  /** Where the popup is mounted. An element shown fullscreen has to hold its own menu. */
  container?: HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  // With its menu open the button needs no name beside it.
  const [open, setOpen] = useState(false);
  const trigger = (
    <Menu.Trigger
      aria-label={label}
      // Shown fullscreen, the element holds its own menu but not the tooltips, which are drawn on the page behind it.
      title={container ? label : undefined}
      className={cn(
        "flex size-(--kago-control-h) shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        raised ? "kago-raised text-ink" : "kago-flat text-muted hover:text-ink data-[popup-open]:text-ink",
        className
      )}
    >
      {children}
    </Menu.Trigger>
  );
  return (
    <Menu.Root
      onOpenChange={(next) => {
        setOpen(next);
        onOpenChange?.(next);
      }}
    >
      {container ? trigger : <KagoTooltip label={label} disabled={open}>{trigger}</KagoTooltip>}
      <Menu.Portal container={container ?? undefined}>
        <Menu.Positioner side={side} sideOffset={sideOffset} align={align} collisionPadding={8} className="z-[800] outline-none">
          <Menu.Popup className="kago-glass kago-pop max-h-(--available-height) min-w-44 cursor-default overflow-y-auto overscroll-contain rounded-lg p-1 outline-none select-none">{menu}</Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function KagoMenuItem({ icon, shortcut, destructive, className, children, ...props }: ComponentProps<typeof ContextMenu.Item> & { icon?: ReactNode; /** The keys that do the same, shown at the far end. */ shortcut?: string; destructive?: boolean }) {
  return (
    <ContextMenu.Item
      className={cn(
        "kago-menu-item flex h-7 items-center gap-2 rounded-[calc(var(--kago-radius-md)+1px)] [corner-shape:squircle] px-2 outline-none data-[disabled]:opacity-40",
        destructive && "text-danger data-[highlighted]:text-white",
        className
      )}
      {...props}
    >
      {icon}
      {children}
      {shortcut ? <kbd className="ml-auto pl-6 font-mono text-xs tracking-wide opacity-55">{shortcut}</kbd> : null}
    </ContextMenu.Item>
  );
}

/**
 * The same row as a button of its own, for the few menus that are not opened from a button or a right click
 * (the choice shown where something was dropped). It is lit while it holds the focus, and the pointer moves the
 * focus to it, so the keyboard and the pointer always agree on which row is chosen.
 */
export function KagoMenuButton({ icon, className, children, ...props }: ComponentProps<"button"> & { icon?: ReactNode }) {
  return (
    <button type="button" role="menuitem" className={cn("kago-menu-item flex h-7 items-center gap-2 rounded-[calc(var(--kago-radius-md)+1px)] [corner-shape:squircle] px-2 text-left outline-none", className)} onPointerMove={(event) => event.currentTarget.focus()} {...props}>
      {icon}
      {children}
    </button>
  );
}

export function KagoMenuSeparator() {
  return <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />;
}
