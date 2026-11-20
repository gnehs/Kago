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

/** `error` replaces `hint` while it is set: it is announced, and the control is marked invalid and described by it. */
export function Field({ label, hint, error, className, children }: { label: string; hint?: string; error?: string; className?: string; children: React.ReactNode }) {
  const messageId = React.useId();
  const control = error && React.isValidElement<React.HTMLAttributes<HTMLElement>>(children)
    ? React.cloneElement(children, { "aria-invalid": true, "aria-describedby": [children.props["aria-describedby"], messageId].filter(Boolean).join(" ") } as React.HTMLAttributes<HTMLElement>)
    : children;
  return (
    <label className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {control}
      {error ? <span id={messageId} role="alert" className="text-xs text-danger">{error}</span> : hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

/** A field made of more than one control (cards to choose from): named the same way, but not a `<label>`, which would press the first of them. */
export function FieldGroup({ label, hint, className, children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1", className)}>
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </div>
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
