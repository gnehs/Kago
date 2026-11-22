import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { KagoTooltip } from "./tooltip";

/** Icon-only button. The label is both the tooltip and the accessible name. `size="sm"` is the compact 24px square. */
export function KagoIconButton({ label, active, size, className, children, ...props }: Omit<ComponentProps<typeof Button>, "aria-label" | "size"> & { label: string; active?: boolean; size?: "sm"; children: ReactNode }) {
  return (
    <KagoTooltip label={label}>
      <Button variant="ghost" size="icon" aria-label={label} aria-pressed={active} className={cn(active && "kago-pressed text-ink", size === "sm" && "size-6", className)} {...props}>
        {children}
      </Button>
    </KagoTooltip>
  );
}
