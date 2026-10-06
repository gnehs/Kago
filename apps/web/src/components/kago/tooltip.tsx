import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";
import { cn } from "@/lib/utils";

export function KagoTooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delay={450} closeDelay={80}>
      {children}
    </Tooltip.Provider>
  );
}

export function KagoTooltip({
  label,
  children,
  className,
  disabled = false
}: {
  label: ReactNode;
  children: ReactElement;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Tooltip.Root disabled={disabled}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={8}>
          <Tooltip.Popup className={cn("kago-tooltip-popup", className)}>
            {label}
            <Tooltip.Arrow className="kago-tooltip-arrow" />
          </Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
