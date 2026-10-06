import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-accent/50 disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "bg-accent text-accent-fg hover:brightness-110",
        outline: "border border-line bg-surface text-ink hover:bg-hover",
        ghost: "text-muted hover:bg-hover hover:text-ink",
        destructive: "border border-line bg-surface text-danger hover:bg-danger/10"
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
