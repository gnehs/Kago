import type { ReactNode } from "react";

/** A titled part of a panel that tells about one thing (the inspector, a picture's info), ruled off from the part above it. */
export function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-line p-4">
      <h3 className="m-0 mb-2.5 font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** What is known about something: what each figure is down the left, the figure beside it. Holds `Detail`s. */
export function DetailList({ children }: { children: ReactNode }) {
  return <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">{children}</dl>;
}

export function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="m-0 min-w-0 break-words">{children}</dd>
    </>
  );
}
