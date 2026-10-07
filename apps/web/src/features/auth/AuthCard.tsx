import { useEffect, useRef, type ReactNode } from "react";
import { motionAllowed } from "@/lib/motion";

export function BrandMark({ className = "size-7" }: { className?: string }) {
  return <img src="/icon.svg" alt="" draggable={false} className={`shrink-0 drop-shadow-sm ${className}`} />;
}

/** Centered card used by the sign-in, first-run setup and public share screens. */
export function AuthCard({ title, subtitle, refused, children }: { title: string; subtitle: string; /** Changes each time what was entered is turned down, and the card shakes its head. */ refused?: number; children: ReactNode }) {
  const card = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!refused || !motionAllowed()) return;
    card.current?.animate({ translate: ["0", "-6px 0", "6px 0", "-6px 0", "6px 0", "0"] }, { duration: 320, easing: "ease-in-out" });
  }, [refused]);

  return (
    <main className="kago-canvas flex h-full items-center justify-center overflow-auto p-4">
      <section ref={card} className="w-full max-w-sm rounded-lg bg-surface p-6 shadow-window ring-1 ring-(--kago-window-edge)">
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
