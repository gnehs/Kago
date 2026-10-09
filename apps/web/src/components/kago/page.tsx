import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Scrollable content area of an app window (tasks, shares, trash, settings sections).
 * The title is for sections of a window; a window with a single page is already named by its title bar.
 */
export function Page({ title, description, actions, children }: { title?: string; description?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="@container min-h-0 min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full max-w-3xl flex-col gap-4 p-5 [&>[data-empty]]:flex-1">
        {title || description || actions ? (
          <header className="flex min-h-(--kago-control-h) items-center gap-4">
            <div className="min-w-0 flex-1">
              {title ? <h1 className="m-0 text-base font-semibold">{title}</h1> : null}
              {description ? <p className={cn("m-0 text-muted", title && "mt-0.5")}>{description}</p> : null}
            </div>
            {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
          </header>
        ) : null}
        {children}
      </div>
    </div>
  );
}

/** A titled group of settings or a form. `action` sits at the right of the title. */
export function Card({ title, description, action, className, children }: { title?: string; description?: string; action?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn("kago-card rounded-lg border border-line", className)}>
      {title ? (
        <header className="flex min-h-11 items-center gap-3 rounded-t-[inherit] border-b border-line bg-elevated/60 py-1.5 pr-2 pl-4">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 font-semibold">{title}</h2>
            {description ? <p className="m-0 text-xs text-muted">{description}</p> : null}
          </div>
          {action}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A titled part of a page that lists more than one kind of thing. `action` sits at the right of the title. */
export function Section({ title, description, action, children }: { title: string; description?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3 not-first-of-type:mt-2">
      <header className="flex min-h-(--kago-control-h) items-center gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="m-0 font-semibold">{title}</h2>
          {description ? <p className="m-0 text-xs text-muted">{description}</p> : null}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

/** One setting inside a card: what it is on the left, its control on the right. */
export function SettingRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="min-w-40 flex-1">
        <div className="font-medium">{label}</div>
        {description ? <div className="text-xs text-muted">{description}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** Bordered list whose rows are separated by hairlines. Inside a card it is `bare`: the card is already its frame, and its rows keep to the card's own edges. */
export function RowList({ bare, children }: { bare?: boolean; children: ReactNode }) {
  return <ul data-bare={bare ? "" : undefined} className={cn("group/rows m-0 flex list-none flex-col divide-y divide-line p-0", !bare && "kago-card rounded-lg border border-line")}>{children}</ul>;
}

/**
 * One thing in a list. What it is stands on the left: an icon, which is also where its state is shown
 * (`KagoStatusIcon`), its name, and a line or two about it underneath. What can be done to it stands on the right
 * (`children`), and that end holds nothing but buttons, all of one kind: a badge among them reads as one more thing
 * to press, and one beside the name competes with the name.
 */
export function Row({ icon, title, subtitle, children }: { icon?: ReactNode; title: ReactNode; subtitle?: ReactNode; children?: ReactNode }) {
  return (
    <li className="flex min-h-12 items-center gap-3 px-4 py-2 group-data-bare/rows:min-h-0 group-data-bare/rows:px-0 group-data-bare/rows:first:pt-0 [&>.lucide]:text-muted group-data-bare/rows:[&>.lucide]:size-4">
      {icon}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-medium">{title}</span>
        {subtitle ? <span className="truncate text-xs text-muted">{subtitle}</span> : null}
      </div>
      {children}
    </li>
  );
}
