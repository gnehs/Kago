import type { ComponentProps, ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
import { Menu } from "@base-ui/react/menu";
import { cn } from "@/lib/utils";

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
        <ContextMenu.Positioner className="z-[800] outline-none">
          <ContextMenu.Popup className="kago-glass kago-pop min-w-44 rounded-lg p-1 outline-none">{menu}</ContextMenu.Popup>
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
  align = "end",
  container,
  onOpenChange,
  children
}: {
  label: string;
  menu: ReactNode;
  className?: string;
  side?: "top" | "bottom";
  /** Which edge of the button the popup lines up with. */
  align?: "start" | "end";
  /** Where the popup is mounted. An element shown fullscreen has to hold its own menu. */
  container?: HTMLElement | null;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Menu.Root onOpenChange={onOpenChange}>
      <Menu.Trigger
        aria-label={label}
        title={label}
        className={cn(
          "flex size-(--kago-control-h) shrink-0 items-center justify-center kago-flat rounded-md text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50 data-[popup-open]:text-ink",
          className
        )}
      >
        {children}
      </Menu.Trigger>
      <Menu.Portal container={container ?? undefined}>
        <Menu.Positioner side={side} sideOffset={4} align={align} className="z-[800] outline-none">
          <Menu.Popup className="kago-glass kago-pop min-w-44 rounded-lg p-1 outline-none">{menu}</Menu.Popup>
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
      {shortcut ? <kbd className="ml-auto pl-6 font-sans text-xs tracking-wide opacity-55">{shortcut}</kbd> : null}
    </ContextMenu.Item>
  );
}

export function KagoMenuSeparator() {
  return <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />;
}
