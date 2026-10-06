import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";

export function KagoTooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delay={500} closeDelay={80}>
      {children}
    </Tooltip.Provider>
  );
}

export function KagoTooltip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6} className="z-[1000]">
          <Tooltip.Popup className="rounded-sm bg-ink px-1.5 py-1 text-xs text-surface shadow-popup">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
