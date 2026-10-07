import type { ReactNode } from "react";

export function BrandMark({ className = "size-7" }: { className?: string }) {
  return <img src="/icon.svg" alt="" draggable={false} className={`shrink-0 drop-shadow-sm ${className}`} />;
}

/** Centered card used by the sign-in, first-run setup and public share screens. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <main className="kago-canvas flex h-full items-center justify-center overflow-auto p-4">
      <section className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-window ring-1 ring-(--kago-window-edge)">
        <header className="mb-5 flex items-center gap-3">
          <BrandMark className="size-10" />
          <div className="min-w-0">
            <h1 className="m-0 truncate text-base font-semibold">{title}</h1>
            <p className="m-0 truncate text-muted">{subtitle}</p>
          </div>
        </header>
        {children}
      </section>
    </main>
  );
}

export function FormError({ message }: { message: string }) {
  if (!message) return null;
  return <p className="m-0 rounded-md bg-danger/10 px-2.5 py-1.5 text-danger" role="alert">{message}</p>;
}
