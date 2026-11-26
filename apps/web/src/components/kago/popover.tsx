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
  raised,
  wide,
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
  /** Drawn as a button with a body, to stand beside other such buttons instead of on a bar. */
  raised?: boolean;
  /** A button with words on it, as wide as they are, not a square for an icon. Its words are its name. */
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      {/* With its panel open the button needs no name beside it. */}
      <KagoTooltip label={label} disabled={open || wide}>
        <Popover.Trigger
          aria-label={wide ? undefined : label}
          className={cn(
            "flex shrink-0 items-center justify-center rounded-md outline-none focus-ring",
            wide ? "h-(--kago-control-h) gap-1.5 px-2.5 whitespace-nowrap" : "size-(--kago-control-h)",
            raised ? "kago-raised text-ink" : "kago-flat text-muted hover:text-ink",
            className
          )}
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
