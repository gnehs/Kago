import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Full-area page shown in place of the canvas for tasks, shares, trash and admin screens. */
export function Page({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <div className="min-w-0 flex-1 overflow-y-auto bg-surface">
      <div className="mx-auto flex max-w-3xl flex-col gap-5 px-6 py-8">
        <header>
          <h1 className="m-0 text-lg font-semibold">{title}</h1>
          {description ? <p className="m-0 mt-1 text-muted">{description}</p> : null}
        </header>
        {children}
      </div>
    </div>
  );
}

export function Card({ title, className, children }: { title?: string; className?: string; children: ReactNode }) {
  return (
    <section className={cn("rounded-lg border border-line p-4", className)}>
      {title ? <h2 className="m-0 mb-3 text-sm font-semibold">{title}</h2> : null}
      {children}
    </section>
  );
}

/** Bordered list whose rows are separated by hairlines. */
export function RowList({ children }: { children: ReactNode }) {
  return <ul className="m-0 flex list-none flex-col divide-y divide-line rounded-lg border border-line p-0">{children}</ul>;
}

export function Row({ icon, title, subtitle, children }: { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex min-h-12 items-center gap-3 px-4 py-2 [&>.lucide]:text-muted">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        {subtitle ? <span className="truncate text-xs text-muted">{subtitle}</span> : null}
      </div>
      {children}
    </li>
  );
}
