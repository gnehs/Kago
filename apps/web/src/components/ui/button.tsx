import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** A disabled button is dimmed in opaque colours: opacity would stack the alpha of an icon's overlapping strokes. */
const DISABLED_RAISED = "disabled:[background:color-mix(in_srgb,var(--kago-bg)_55%,var(--kago-surface))]";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-[color,background-color,filter] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60 disabled:pointer-events-none",
  {
    variants: {
      variant: {
        default: "kago-primary",
        outline: `kago-raised text-ink ${DISABLED_RAISED} disabled:text-[color-mix(in_srgb,var(--kago-text)_40%,var(--kago-surface))]`,
        ghost: "kago-flat text-muted hover:text-ink disabled:text-[color-mix(in_srgb,var(--kago-text)_40%,var(--kago-surface))]",
        destructive: `kago-raised text-danger ${DISABLED_RAISED} disabled:text-[color-mix(in_srgb,var(--kago-danger)_40%,var(--kago-surface))]`,
        "destructive-primary": "kago-primary kago-destructive"
      },
      size: {
        default: "h-(--kago-control-h) px-3",
        lg: "h-9 px-4",
        icon: "size-(--kago-control-h)"
      }
    },
    defaultVariants: { variant: "outline", size: "default" }
  }
);

export function Button({ className, variant, size, type = "button", ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
