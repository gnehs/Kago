import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[var(--kago-radius-md)] text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(94,106,210,0.42)] disabled:pointer-events-none disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-[var(--kago-accent)] text-white hover:bg-[var(--kago-accent-hover)]",
        secondary: "bg-[var(--kago-surface-strong)] text-[var(--kago-text)] hover:bg-[var(--kago-surface-elevated)]",
        outline:
          "border border-[var(--kago-border)] bg-[var(--kago-surface-elevated)] text-[var(--kago-text-muted)] hover:bg-[var(--kago-surface-strong)] hover:text-[var(--kago-text)]",
        ghost: "text-[var(--kago-text-muted)] hover:bg-[var(--kago-surface-elevated)] hover:text-[var(--kago-text)]",
        destructive: "bg-[rgba(255,107,104,0.14)] text-[#ffaaa8] hover:bg-[rgba(255,107,104,0.2)]"
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-8 px-3 text-xs",
        icon: "size-9"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export function Button({
  className,
  variant,
  size,
  ...props
}: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}
