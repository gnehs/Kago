import { useEffect, useRef, type ReactNode } from "react";
import { motionAllowed } from "@/lib/motion";

export function BrandMark({ className = "size-7" }: { className?: string }) {
  return <img src="/icon.svg" alt="" draggable={false} className={`shrink-0 drop-shadow-sm ${className}`} />;
}

/**
 * The screens there are before the desktop: signing in, the first-run setup and a public share. What it is stands
 * on the desktop itself, as an icon with its name under it does, and what is asked for is on a sheet below.
 */
export function AuthCard({ title, subtitle, icon, refused, children }: { title: string; subtitle: string; /** Takes the place of Kago's own mark, when the screen is about something else: a file that was shared. */ icon?: ReactNode; /** Changes each time what was entered is turned down, and the card shakes its head. */ refused?: number; children: ReactNode }) {
  const column = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);

  // It arrives the way a window does, in place and ready to be typed into.
  useEffect(() => {
    if (motionAllowed()) column.current?.animate([{ opacity: 0, transform: "scale(0.975)" }, { opacity: 1, transform: "none" }], { duration: 130, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
  }, []);

  useEffect(() => {
    if (!refused || !motionAllowed()) return;
    card.current?.animate({ translate: ["0", "-6px 0", "6px 0", "-6px 0", "6px 0", "0"] }, { duration: 320, easing: "ease-in-out" });
  }, [refused]);

  return (
    <main className="kago-canvas flex h-full flex-col items-center overflow-auto px-4 py-8">
      {/* Centred while there is room, and scrolled from its top when there is not. */}
      <div ref={column} className="my-auto flex w-full max-w-[340px] flex-col items-center">
        <span className="mb-4 flex size-16 items-center justify-center">{icon ?? <img src="/icon.svg" alt="" draggable={false} className="kago-app-icon select-none" />}</span>
        <h1 className="m-0 line-clamp-2 max-w-full text-center text-xl leading-tight font-semibold tracking-tight wrap-anywhere">{title}</h1>
        <p className="m-0 mt-1.5 max-w-full text-center text-muted">{subtitle}</p>
        {/* With nothing to ask for, there is no sheet. */}
        {children ? <section ref={card} className="mt-6 w-full rounded-lg bg-surface p-5 shadow-window ring-1 ring-(--kago-window-edge)">{children}</section> : null}
      </div>
    </main>
  );
}

export function FormError({ message }: { message: string }) {
  if (!message) return null;
  return <p className="m-0 rounded-md bg-danger/10 px-2.5 py-1.5 text-danger" role="alert">{message}</p>;
}
