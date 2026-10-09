import type { ReactNode } from "react";

/** A key of the keyboard, drawn as the small plate a badge is, where a line of text says what the key does. */
export function KagoKbd({ children }: { children: ReactNode }) {
  return <kbd className="kago-badge flex h-4.5 min-w-4.5 items-center justify-center rounded-[5px] px-1 font-sans text-[11px] text-muted">{children}</kbd>;
}
