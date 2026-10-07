import { cn } from "@/lib/utils";

/** Stands for a person where there is no picture of them: the first letter of their name on a plate. */
export function KagoAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span aria-hidden className={cn("kago-badge flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-accent", className)}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
