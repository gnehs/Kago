import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * One section of the settings window: a header that stays put, and the page scrolling under it. The header is the
 * same on every section: the title with what the page is for under it, then the search (beside the title where there
 * is room, under it where there is not), then the buttons. `toolbar` is a row of its own for filters and views.
 *
 * What the page is made of decides its width. A form, or a table of ticks, reads best narrow and sits in the middle
 * of a wide window. A list or a log is read across, so it is `wide` and uses what the window gives it.
 */
export function Page({ title, description, search, actions, toolbar, wide, scrollRef, children }: { title?: string; description?: string; search?: ReactNode; actions?: ReactNode; toolbar?: ReactNode; wide?: boolean; scrollRef?: Ref<HTMLDivElement>; children: ReactNode }) {
  const gutter = wide ? "px-4" : "mx-auto max-w-3xl px-5";
  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      {title || description || search || actions || toolbar ? (
        <header className="shrink-0 border-b border-line bg-elevated py-3">
          <div className={cn("flex flex-col gap-2.5", gutter)}>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="min-w-0 flex-1 basis-56">
                {title ? <h1 className="m-0 text-base font-semibold">{title}</h1> : null}
                {description ? <p className={cn("m-0 text-xs text-pretty text-muted", title && "mt-0.5")}>{description}</p> : null}
              </div>
              {search ? <div className="order-last flex basis-full @2xl:order-none @2xl:basis-60 @2xl:flex-none">{search}</div> : null}
              {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
            </div>
            {toolbar}
          </div>
        </header>
      ) : null}
      <div ref={scrollRef} className="min-h-0 flex-1 scroll-fade overflow-y-auto">
        <div className={cn("flex min-h-full flex-col gap-4 [&>[data-empty]]:flex-1", wide ? "p-4" : "mx-auto max-w-3xl p-5")}>{children}</div>
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

/** One part of a long form: what it is about as a small heading, then its fields, with a hairline between one part and the next. */
export function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-3 border-0 p-0 not-first:border-t not-first:border-line not-first:pt-4">
      <legend className="float-left mb-0 w-full p-0 text-xs font-semibold text-muted">{title}</legend>
      {children}
    </fieldset>
  );
}

/** One setting inside a card: what it is on the left, its control on the right. A `stacked` one has its control underneath, across the card. */
export function SettingRow({ label, description, stacked, children }: { label: string; description?: string; stacked?: boolean; children: ReactNode }) {
  return (
    <div className={stacked ? "flex flex-col gap-3" : "flex flex-wrap items-center gap-x-4 gap-y-2"}>
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
