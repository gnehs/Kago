import type { ReactNode } from "react";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * One of a few, each shown as a small picture of what choosing it looks like, with its name underneath.
 * The chosen picture is ringed and carries a check.
 */
export function KagoPreviewPicker<T extends string>({
  label,
  options,
  value,
  onChange
}: {
  /** What is being chosen, for those who cannot see the pictures. */
  label: string;
  options: ReadonlyArray<{ value: T; label: string; preview: ReactNode }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 @md:grid-cols-3" role="radiogroup" aria-label={label}>
      {options.map((item) => {
        const chosen = value === item.value;
        return (
          <button
            key={item.value}
            role="radio"
            aria-checked={chosen}
            className="group flex min-w-0 flex-col items-center gap-2 outline-none"
            onClick={() => onChange(item.value)}
          >
            <span
              className={cn(
                "relative block w-full rounded-lg p-0.75 ring-2 transition-shadow",
                chosen ? "ring-ink" : "ring-transparent group-hover:ring-line-strong group-focus-visible:ring-accent"
              )}
            >
              <span className="relative block aspect-[16/10] overflow-hidden rounded-md ring-1 ring-line">{item.preview}</span>
              {chosen ? (
                <span className="absolute bottom-2 left-2 flex size-5 items-center justify-center rounded-full bg-ink text-surface ring-2 ring-surface">
                  <Check className="size-3" strokeWidth={3} />
                </span>
              ) : null}
            </span>
            <span className={cn("truncate text-xs", chosen ? "font-semibold" : "text-muted")}>{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
