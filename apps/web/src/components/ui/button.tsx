import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium outline-none transition-[color,background-color,filter] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60 disabled:pointer-events-none disabled:opacity-40",
  {
    variants: {
      variant: {
        default: "kago-primary",
        outline: "kago-raised text-ink",
        ghost: "kago-flat text-muted hover:text-ink",
        destructive: "kago-raised text-danger"
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
