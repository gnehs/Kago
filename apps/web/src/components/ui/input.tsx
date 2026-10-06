import * as React from "react";
import { cn } from "@/lib/utils";

export function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-10 w-full min-w-0 rounded-[var(--kago-radius-md)] border border-[var(--kago-border)] bg-[var(--kago-surface-elevated)] px-3 py-2 text-sm text-[var(--kago-text)] outline-none transition-colors placeholder:text-[var(--kago-text-tertiary)] focus:border-[var(--kago-accent)] focus:ring-2 focus:ring-[rgba(94,106,210,0.42)] disabled:cursor-not-allowed disabled:opacity-45",
        className
      )}
      {...props}
    />
  );
}
