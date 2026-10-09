import { cn } from "@/lib/utils";

/** Kago's own mark, at whatever size the place it is put in asks for. */
export function BrandMark({ className = "size-7" }: { className?: string }) {
  return <img src="/icon.svg" alt="" draggable={false} className={cn("shrink-0 drop-shadow-sm", className)} />;
}
