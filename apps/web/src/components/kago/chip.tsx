import type { ReactNode } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/** The chips put on one thing, wrapping onto as many lines as they need. */
export function KagoChips({ children }: { children: ReactNode }) {
  return <ul className="m-0 flex list-none flex-wrap gap-1 p-0">{children}</ul>;
}

/** Something put on a thing, as a pill: a tag. `dot` is its colour; with `onRemove` it carries a cross that takes it off again. */
export function KagoChip({ dot, removeLabel, onRemove, children }: { dot?: ReactNode; /** What the cross does, for those who cannot see it. */ removeLabel?: string; onRemove?: () => void; children: ReactNode }) {
  return (
    <li className={cn("flex h-6 items-center gap-1.5 rounded-full bg-hover pl-2", onRemove ? "pr-1" : "pr-2")}>
      {dot}
      {children}
      {onRemove ? (
        <button type="button" aria-label={removeLabel} className="rounded-full p-0.5 text-muted hover:text-ink" onClick={onRemove}>
          <X className="size-3" />
        </button>
      ) : null}
    </li>
  );
}
