import * as React from "react";
import { cn } from "@/lib/utils";

export const controlClass =
  "h-(--kago-control-h) w-full min-w-0 rounded-md px-2.5 text-ink outline-none transition-shadow placeholder:text-faint disabled:opacity-50";

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(controlClass, "kago-well", className)} {...props} />;
}

export function Select({ className, ...props }: React.ComponentProps<"select">) {
  return <select className={cn(controlClass, "kago-raised pr-7 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent/60", className)} {...props} />;
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
      <input type="checkbox" className="kago-checkbox" {...props} />
      {label}
    </label>
  );
}
