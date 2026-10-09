import { cn } from "@/lib/utils";

/** Sets one group of controls on a bar apart from the next: a short upright line. */
export function KagoDivider({ className }: { className?: string }) {
  return <span aria-hidden className={cn("mx-1 h-4 w-px shrink-0 bg-line-strong/70", className)} />;
}
