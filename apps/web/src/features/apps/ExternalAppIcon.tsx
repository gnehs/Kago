import { useState } from "react";
import { Globe } from "lucide-react";
import { KagoAppIcon, KagoAppImage, KagoShortcutMark } from "@/components/kago/app-icon";
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
 * One that opens in a tab of its own, and so takes whoever clicks it out of Kago, wears the shortcut mark.
 */
export function ExternalAppIcon({ name, icon, leaves, className }: { name: string; icon: string | null; /** Whether it opens outside Kago. */ leaves?: boolean; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  const picture = icon && failed !== icon ? icon : null;
  return (
    <span className={cn("relative flex size-12 shrink-0", className)} style={picture ? undefined : { color: `var(--kago-app-${locationTone(name.trim().toLowerCase())})` }}>
      {picture ? <KagoAppImage src={picture} onError={() => setFailed(picture)} /> : GLOBE}
      {leaves ? <KagoShortcutMark className="absolute bottom-0 left-0 size-[36%]" /> : null}
    </span>
  );
}

/**
 * A shortcut's icon at the size of a line of text, where a tile would be a smudge: the picture as it is, the way a
 * browser's tab shows a site's. Without one it is the globe that stands for any place on the network.
 */
export function ExternalAppGlyph({ icon, className }: { icon: string | null; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!icon || failed === icon) return <Globe className={className} />;
  return <img src={icon} alt="" draggable={false} className={cn("size-4 shrink-0 object-contain", className)} onError={() => setFailed(icon)} />;
}
