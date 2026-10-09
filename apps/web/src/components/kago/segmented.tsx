import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { KagoTooltip } from "./tooltip";

/**
 * One of a few, as a row of joined buttons where the chosen one stays pressed in (`kago-segments`).
 * `onChange` hears of every press, the chosen one's too: a segment may do something more when pressed again.
 */
export function KagoSegmented<T extends string>({
  label,
  options,
  value,
  onChange,
  iconOnly,
  className
}: {
  /** What is being chosen, for those who cannot see the row. */
  label: string;
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  /** Only the icons are drawn, a little smaller, as on a toolbar; each segment's label is its tooltip. */
  iconOnly?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("kago-segments", className)} role="radiogroup" aria-label={label}>
      {options.map((item) => {
        const segment = (
          <button
            key={item.value}
            role="radio"
            aria-checked={value === item.value}
            aria-label={iconOnly ? item.label : undefined}
            className={cn(
              "flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset",
              iconOnly ? "h-6 w-7.5" : "h-[calc(var(--kago-control-h)-4px)] gap-1.5 px-2.5"
            )}
            onClick={() => onChange(item.value)}
          >
            {item.icon}
            {iconOnly ? null : item.label}
          </button>
        );
        return iconOnly ? <KagoTooltip key={item.value} label={item.label}>{segment}</KagoTooltip> : segment;
      })}
    </div>
  );
}
