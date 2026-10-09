import type { ComponentProps, CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * One of a range, picked by sliding: a groove filled with the accent as far as the knob. It is the browser's own
 * range input underneath, so the keyboard moves it the way it moves any other.
 */
export function KagoSlider({ value, min = 0, max, className, style, ...props }: Omit<ComponentProps<"input">, "type" | "value" | "min" | "max"> & { value: number; min?: number; max: number }) {
  // How far along the knob is, which is all the groove needs to know to fill itself.
  const part = max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0;
  return <input type="range" className={cn("kago-slider", className)} style={{ "--value": part, ...style } as CSSProperties} min={min} max={max} value={value} {...props} />;
}
