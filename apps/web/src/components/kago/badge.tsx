import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

const tones = {
  neutral: "text-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger"
};

export function KagoBadge({ tone = "neutral", children }: { tone?: keyof typeof tones; children: ReactNode }) {
  return <span className={cn("kago-badge inline-flex h-5 shrink-0 items-center rounded-sm px-1.5 text-xs font-medium", tones[tone])}>{children}</span>;
}
