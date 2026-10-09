import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { KagoTooltip } from "./tooltip";

const tones = {
  neutral: "text-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger"
};

/**
 * The icon at the head of a row of a list, saying what state the thing is in: a round plate tinted with the colour
 * of the state, holding a glyph for it. It takes the place of a badge beside the name. The state is put into words
 * for whoever points at it or cannot see it, and anything that has to be read without doing either belongs in the
 * line under the name as well.
 */
export function KagoStatusIcon({ tone = "neutral", label, large, className, children }: { tone?: keyof typeof tones; /** The state in words. */ label?: string; /** As big as an app's icon, where it stands for the thing itself: what a dialog asks about. */ large?: boolean; className?: string; children: ReactNode }) {
  const plate = (
    <span role="img" aria-label={label} className={cn("kago-badge flex shrink-0 items-center justify-center rounded-full", large ? "size-12 [&>.lucide]:size-5" : "size-7", tones[tone], className)}>
      {children}
    </span>
  );
  return label ? <KagoTooltip label={label}>{plate}</KagoTooltip> : plate;
}
