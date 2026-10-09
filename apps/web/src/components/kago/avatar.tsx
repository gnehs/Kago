import { useState } from "react";
import { cn } from "@/lib/utils";

/** Where the profile picture a person set at `version` is read from. Nothing for someone who has none. */
export const avatarUrl = (userId: string, version: number | null | undefined) => (version ? `/api/users/${userId}/avatar?v=${version}` : null);

/** Stands for a person: their profile picture, or where there is none the first letter of their name on a plate. */
export function KagoAvatar({ name, picture, className }: { name: string; /** From `avatarUrl`. */ picture?: string | null; className?: string }) {
  // A picture that does not load gives its place back to the letter.
  const [failed, setFailed] = useState<string | null>(null);
  if (picture && picture !== failed) {
    return <img alt="" aria-hidden draggable={false} src={picture} className={cn("size-7 shrink-0 rounded-full object-cover ring-1 ring-line select-none", className)} onError={() => setFailed(picture)} />;
  }
  return (
    <span aria-hidden className={cn("kago-badge flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-accent", className)}>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}
