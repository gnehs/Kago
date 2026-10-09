import type { ReactNode } from "react";
import { Popover } from "@base-ui/react/popover";
import { cn } from "@/lib/utils";
import { KagoTooltip } from "./tooltip";

/**
 * A panel of glass opened from a button, for what is more than a list of things to do (the latest tasks).
 * `children` is what the button shows; `panel` is what it opens.
 */
export function KagoPopover({
  label,
  open,
  onOpenChange,
  panel,
  className,
  panelClassName,
  sideOffset = 4,
  align = "end",
  children
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panel: ReactNode;
  className?: string;
  panelClassName?: string;
  /** How far from its button the panel hangs. */
  sideOffset?: number;
  /** Which edge of the button the panel lines up with. */
  align?: "start" | "end";
  children: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {/* With its panel open the button needs no name beside it. */}
      <KagoTooltip label={label} disabled={open}>
        <Popover.Trigger
          aria-label={label}
          className={cn("flex size-(--kago-control-h) shrink-0 items-center justify-center kago-flat rounded-md text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50", className)}
        >
          {children}
        </Popover.Trigger>
      </KagoTooltip>
      <Popover.Portal>
        {/* Under the menus, which may be opened from inside it. */}
        <Popover.Positioner sideOffset={sideOffset} align={align} collisionPadding={8} className="z-[700]">
          <Popover.Popup className={cn("kago-glass kago-pop max-w-[calc(100vw-16px)] rounded-lg p-2 outline-none", panelClassName)}>{panel}</Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
