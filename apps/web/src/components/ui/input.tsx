import * as React from "react";
import { cn } from "@/lib/utils";

export const controlClass =
  "h-(--kago-control-h) w-full min-w-0 rounded-md border border-line bg-surface px-2.5 text-ink outline-none transition-colors placeholder:text-faint focus:border-accent focus:ring-2 focus:ring-accent/25 disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(controlClass, "pr-7", className)} {...props} />;
}

export function Field({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="text-xs text-faint">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({ label, className, ...props }: Omit<React.ComponentProps<"input">, "type"> & { label: React.ReactNode }) {
  return (
    <label className={cn("inline-flex items-center gap-1.5 text-ink", className)}>
      <input type="checkbox" className="size-3.5 accent-(--kago-accent)" {...props} />
      {label}
    </label>
  );
}
