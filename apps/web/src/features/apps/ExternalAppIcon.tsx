import { useState } from "react";
import { KagoAppIcon, KagoAppImage } from "@/components/kago/app-icon";
import { locationTone } from "@/features/workspace/DesktopIcons";
import { cn } from "@/lib/utils";

/** What a shortcut without a picture of its own wears: the globe, for somewhere out on the network. */
const GLOBE = (
  <KagoAppIcon texture="dots">
    <circle cx="12" cy="12" r="8.6" fill="none" strokeWidth={2} />
    <path d="M3.4 12h17.2M12 3.4c2.5 2.3 3.8 5.2 3.8 8.6s-1.3 6.3-3.8 8.6c-2.5-2.3-3.8-5.2-3.8-8.6S9.5 5.7 12 3.4z" fill="none" strokeWidth={1.8} />
  </KagoAppIcon>
);

/**
 * The icon of a shortcut to another service, as a tile like Kago's own. Without a picture, or with one that does
 * not load, it is the default tile, in a colour that follows from the name so two of them can be told apart.
 */
export function ExternalAppIcon({ name, icon, className }: { name: string; icon: string | null; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const picture = icon && failed !== icon ? icon : null;
  return (
    <span className={cn("flex size-12 shrink-0", className)} style={picture ? undefined : { color: `var(--kago-app-${locationTone(name.trim().toLowerCase())})` }}>
      {picture ? <KagoAppImage src={picture} onError={() => setFailed(picture)} /> : GLOBE}
    </span>
  );
}
