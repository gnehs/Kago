import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * One of a few, where each is worth a picture and a word about it: cards side by side, the icon above the name as it
 * is on the desktop, and the chosen one in the material of a selection. Every choice is in sight at once, which a
 * menu's are not. A choice that needs no explaining is a row of joined buttons instead (`KagoSegmented`).
 */
export function KagoChoice<T extends string>({
  label,
  options,
  value,
  onChange,
  className
}: {
  /** What is being chosen, for those who cannot see the cards. */
  label: string;
  options: ReadonlyArray<{ value: T; label: string; /** A few words on what choosing it means. */ description?: string; icon?: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div className={cn("grid auto-cols-fr grid-flow-col gap-2", className)} role="radiogroup" aria-label={label}>
      {options.map((item) => {
        const chosen = value === item.value;
        return (
          <button
            key={item.value}
            type="button"
            role="radio"
            aria-checked={chosen}
            className={cn(
              "flex min-w-0 flex-col items-center gap-0.5 rounded-lg px-2 pt-3 pb-2.5 text-center outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60 [&>.lucide]:mb-1 [&>.lucide]:size-5",
              chosen ? "kago-selection kago-selection-raised" : "kago-raised text-ink [&>.lucide]:text-muted"
            )}
            onClick={() => onChange(item.value)}
          >
            {item.icon}
            <span className="max-w-full font-medium text-balance">{item.label}</span>
            {item.description ? <span className={cn("max-w-full text-xs text-balance", chosen ? "text-white/80" : "text-muted")}>{item.description}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
