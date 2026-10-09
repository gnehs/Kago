import { cn } from "@/lib/utils";

/**
 * How far along something is, where there is only room for a glyph: a faint ring, drawn over from twelve o'clock
 * in the colour of the text it sits in. `value` runs from 0 to 1. It only moves when the figure does, so
 * whatever it stands for has to be named beside it or in a label.
 */
export function KagoProgressRing({ value, className }: { value: number; className?: string }) {
  const done = Math.min(1, Math.max(0, value));
  return (
    <svg aria-hidden className={cn("kago-icon", className)} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3}>
      <circle cx={12} cy={12} r={9} opacity={0.25} />
      {/* A round end drawn on nothing is still a dot, so with nothing done there is no arc at all. */}
      <circle
        cx={12}
        cy={12}
        r={9}
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - done}
        strokeLinecap="round"
        className={cn("origin-center -rotate-90 transition-[stroke-dashoffset] duration-300 ease-linear", done === 0 && "opacity-0")}
      />
    </svg>
  );
}
