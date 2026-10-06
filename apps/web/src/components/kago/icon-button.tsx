import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { KagoTooltip } from "./tooltip";

/** Icon-only button. The label is both the tooltip and the accessible name. */
export function KagoIconButton({ label, active, className, children, ...props }: Omit<ComponentProps<typeof Button>, "aria-label"> & { label: string; active?: boolean; children: ReactNode }) {
  return (
    <KagoTooltip label={label}>
      <Button variant="ghost" size="icon" aria-label={label} aria-pressed={active} className={cn(active && "bg-hover text-ink", className)} {...props}>
        {children}
      </Button>
    </KagoTooltip>
  );
}
