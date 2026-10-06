import type { ComponentProps, ReactNode } from "react";
import { ContextMenu } from "@base-ui/react/context-menu";
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
          <ContextMenu.Popup className="min-w-44 rounded-lg bg-surface p-1 shadow-popup outline-none">{menu}</ContextMenu.Popup>
        </ContextMenu.Positioner>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function KagoMenuItem({ icon, destructive, className, children, ...props }: ComponentProps<typeof ContextMenu.Item> & { icon?: ReactNode; destructive?: boolean }) {
  return (
    <ContextMenu.Item
      className={cn(
        "flex h-7 items-center gap-2 rounded-sm px-2 outline-none data-[disabled]:opacity-40 data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg",
        destructive && "text-danger",
        className
      )}
      {...props}
    >
      {icon}
      {children}
    </ContextMenu.Item>
  );
}

export function KagoMenuSeparator() {
  return <ContextMenu.Separator className="mx-1 my-1 h-px bg-line" />;
}
