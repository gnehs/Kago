import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** The strip along the foot of a window: where in the file it stands, in a few words, and the small controls that go with that. */
export function KagoStatusBar({ className, children }: { className?: string; children: ReactNode }) {
  return <footer className={cn("flex h-7 shrink-0 items-center gap-1 border-t border-line bg-elevated px-3 text-muted", className)}>{children}</footer>;
}
