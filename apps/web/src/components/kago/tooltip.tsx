import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "@base-ui/react/tooltip";

export function KagoTooltipProvider({ children }: { children: ReactNode }) {
  return (
    <Tooltip.Provider delay={500} closeDelay={80}>
      {children}
    </Tooltip.Provider>
  );
}

export function KagoTooltip({ label, disabled, children }: { label: ReactNode; /** Says nothing for now: what the button opens is open, and says it better. */ disabled?: boolean; children: ReactElement }) {
  return (
    <Tooltip.Root disabled={disabled}>
      <Tooltip.Trigger render={children} />
      <Tooltip.Portal>
        <Tooltip.Positioner sideOffset={6} className="z-[1000]">
          <Tooltip.Popup className="kago-pop rounded-md bg-ink/90 px-2 py-1 text-xs text-surface shadow-popup backdrop-blur-md">{label}</Tooltip.Popup>
        </Tooltip.Positioner>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
