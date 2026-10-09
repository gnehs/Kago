import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** A rounded square whose corners ease into its sides instead of meeting them, on a 96px field. */
const TILE =
  "M94 48L93.9 65.3L93.7 70.8L93.4 74.8L92.9 77.9L92.2 80.6L91.4 82.9L90.5 84.8L89.3 86.5L88 88L86.5 89.3L84.8 90.5L82.9 91.4L80.6 92.2L77.9 92.9L74.8 93.4L70.8 93.7L65.3 93.9L48 94L30.7 93.9L25.2 93.7L21.2 93.4L18.1 92.9L15.4 92.2L13.1 91.4L11.2 90.5L9.5 89.3L8 88L6.7 86.5L5.5 84.8L4.6 82.9L3.8 80.6L3.1 77.9L2.6 74.8L2.3 70.8L2.1 65.3L2 48L2.1 30.7L2.3 25.2L2.6 21.2L3.1 18.1L3.8 15.4L4.6 13.1L5.5 11.2L6.7 9.5L8 8L9.5 6.7L11.2 5.5L13.1 4.6L15.4 3.8L18.1 3.1L21.2 2.6L25.2 2.3L30.7 2.1L48 2L65.3 2.1L70.8 2.3L74.8 2.6L77.9 3.1L80.6 3.8L82.9 4.6L84.8 5.5L86.5 6.7L88 8L89.3 9.5L90.5 11.2L91.4 13.1L92.2 15.4L92.9 18.1L93.4 21.2L93.7 25.2L93.9 30.7Z";

const tint = (amount: number) => `color-mix(in srgb, currentColor ${100 - amount}%, #ffffff)`;
const shade = (amount: number) => `color-mix(in srgb, currentColor ${100 - amount}%, #000000)`;

/** A basket weave across the tile: squares of two strips each, lying across in one square and upright in the next. */
const WEAVE = (() => {
  const cell = 8;
  let d = "";
  for (let row = 0; row * cell < 96; row += 1) {
    for (let column = 0; column * cell < 96; column += 1) {
      const x = column * cell;
      const y = row * cell;
      d += (row + column) % 2 === 0 ? `M${x + 1.5} ${y + 2.5}h5M${x + 1.5} ${y + 5.5}h5` : `M${x + 2.5} ${y + 1.5}v5M${x + 5.5} ${y + 1.5}v5`;
    }
  }
  return d;
})();

/** Points set out in rows and columns, as places on a map are. */
const DOTS = (() => {
  let d = "";
  for (let y = 4; y < 96; y += 8) for (let x = 4; x < 96; x += 8) d += `M${x - 1.1} ${y}a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0`;
  return d;
})();

/** What is printed on the tile behind the glyph, so that no two kinds of tile are the same surface. */
const TEXTURES = {
  /** Strips woven over and under each other, as the side of a basket (a kago) is. */
  weave: <path d={WEAVE} fill="none" stroke="#ffffff" strokeOpacity={0.17} strokeWidth={1.5} strokeLinecap="round" />,
  /** The slats of a bin. */
  slats: (
    <g fill="none">
      <path d="M12 0v96M28 0v96M44 0v96M60 0v96M76 0v96M92 0v96" stroke="#000000" strokeOpacity={0.13} strokeWidth={1.2} />
      <path d="M13.2 0v96M29.2 0v96M45.2 0v96M61.2 0v96M77.2 0v96M93.2 0v96" stroke="#ffffff" strokeOpacity={0.12} strokeWidth={1} />
    </g>
  ),
  /** A field of points: somewhere else, out on the network. */
  dots: <path d={DOTS} fill="#ffffff" fillOpacity={0.2} />,
  /** Rings going out from the middle, as of something being sent. */
  rings: (
    <g fill="none" stroke="#ffffff">
      <circle cx="48" cy="50" r="24" strokeOpacity={0.2} strokeWidth={1} />
      <circle cx="48" cy="50" r="36" strokeOpacity={0.15} strokeWidth={1} />
      <circle cx="48" cy="50" r="48" strokeOpacity={0.11} strokeWidth={1} />
      <circle cx="48" cy="50" r="60" strokeOpacity={0.08} strokeWidth={1} />
    </g>
  )
};

/**
 * An app icon: a tile of one colour with a surface of its own, holding a white glyph that has thickness.
 * The colour is `currentColor`; the glyph is drawn on a 24px field with no fill of its own,
 * since it is drawn three times over: its shadow, its side and its face.
 */
export function KagoAppIcon({ texture, className, children }: { texture: keyof typeof TEXTURES; className?: string; children: ReactNode }) {
  const id = useId();
  const glyph = (paint: string, dy: number, extra?: React.SVGProps<SVGGElement>) => (
    <g transform={`translate(19.2 ${19.2 + dy}) scale(2.4)`} fill={paint} stroke={paint} strokeWidth={0} strokeLinecap="round" strokeLinejoin="round" {...extra}>
      {children}
    </g>
  );
  return (
    <svg viewBox="0 0 96 96" aria-hidden className={cn("kago-app-icon shrink-0", className)}>
      <defs>
        <linearGradient id={`${id}-tile`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: tint(16) }} />
          <stop offset="0.5" style={{ stopColor: "currentColor" }} />
          <stop offset="1" style={{ stopColor: shade(30) }} />
        </linearGradient>
        <radialGradient id={`${id}-floor`} cx="0.5" cy="1.1" r="0.7">
          <stop offset="0" style={{ stopColor: tint(40) }} stopOpacity={0.55} />
          <stop offset="1" style={{ stopColor: tint(45) }} stopOpacity={0} />
        </radialGradient>
        <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.85} />
          <stop offset="0.3" stopColor="#ffffff" stopOpacity={0.1} />
          <stop offset="0.75" stopColor="#ffffff" stopOpacity={0.06} />
          <stop offset="1" stopColor="#ffffff" stopOpacity={0.4} />
        </linearGradient>
        <linearGradient id={`${id}-face`} gradientUnits="userSpaceOnUse" x1="0" y1="22" x2="0" y2="72">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" style={{ stopColor: tint(84) }} />
        </linearGradient>
        <filter id={`${id}-grain`}>
          <feTurbulence type="fractalNoise" baseFrequency="1.1" numOctaves="2" seed="7" />
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  1.4 0 0 0 -0.62" />
        </filter>
        <filter id={`${id}-shadow`} x="-30%" y="-30%" width="160%" height="170%">
          <feGaussianBlur stdDeviation="2.2" />
        </filter>
        <clipPath id={`${id}-clip`}>
          <path d={TILE} />
        </clipPath>
      </defs>
      <path d={TILE} fill={`url(#${id}-tile)`} />
      <g clipPath={`url(#${id}-clip)`}>
        {TEXTURES[texture]}
        <rect width="96" height="96" fill={`url(#${id}-floor)`} />
        <rect width="96" height="96" filter={`url(#${id}-grain)`} opacity={0.12} />
      </g>
      <path d={TILE} fill="none" stroke={`url(#${id}-rim)`} strokeWidth={1.1} transform="translate(0.7 0.7) scale(0.9854)" />
      <path d={TILE} fill="none" stroke="#000000" strokeOpacity={0.22} strokeWidth={0.6} />
      {glyph(shade(60), 4.5, { filter: `url(#${id}-shadow)`, opacity: 0.55 })}
      {glyph(shade(18), 2.4)}
      {glyph(tint(50), 1.2)}
      {glyph(`url(#${id}-face)`, 0)}
    </svg>
  );
}

/**
 * An app icon made of a picture that is someone else's: the same tile, in white, in either theme, as a logo is
 * drawn for a light ground far more often than for a dark one. The white takes on the picture's own colour, evenly
 * and lightly: the picture blurred until nothing of its shapes is left, so that each shortcut has a tile of its
 * own and none is the bare white of a blank. The picture itself is left as it was made, with only a faint shadow
 * to lift it off the tile.
 */
export function KagoAppImage({ src, className, onError }: { src: string; className?: string; onError?: () => void }) {
  const id = useId();
  return (
    <svg viewBox="0 0 96 96" aria-hidden className={cn("kago-app-icon shrink-0", className)}>
      <defs>
        {/* What is left of a picture's colour once it is spread over the whole tile; the edges, where it thins out, are filled back in. */}
        <filter id={`${id}-tint`} x="-100%" y="-100%" width="300%" height="300%" colorInterpolationFilters="sRGB">
          <feGaussianBlur stdDeviation="46" />
          <feColorMatrix type="saturate" values="1.5" />
          <feComponentTransfer>
            <feFuncA type="linear" slope={6} />
          </feComponentTransfer>
        </filter>
        <filter id={`${id}-lift`} x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="1.6" stdDeviation="1.6" floodColor="#000000" floodOpacity={0.16} />
        </filter>
        <linearGradient id={`${id}-light`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.55} />
          <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </linearGradient>
        <clipPath id={`${id}-clip`}>
          <path d={TILE} />
        </clipPath>
      </defs>
      <path d={TILE} fill="#ffffff" />
      <g clipPath={`url(#${id}-clip)`}>
        <image href={src} x="8" y="8" width="80" height="80" filter={`url(#${id}-tint)`} opacity={0.28} />
        <rect width="96" height="96" fill={`url(#${id}-light)`} />
      </g>
      {/* Drawn as a picture, whatever it is: an SVG shown this way runs nothing and fetches nothing. */}
      <image href={src} x="14" y="14" width="68" height="68" preserveAspectRatio="xMidYMid meet" filter={`url(#${id}-lift)`} onError={onError} />
      <path d={TILE} fill="none" stroke="#000000" strokeOpacity={0.12} strokeWidth={0.6} />
    </svg>
  );
}

/**
 * The mark of a shortcut that leads out of Kago, worn on the corner of its icon the way Windows marks a shortcut:
 * a small white card with an arrow that turns and leaves. It is the same in either theme, like the card it is.
 */
export function KagoShortcutMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("kago-shortcut-mark", className)}>
      <rect x="1.5" y="1.5" width="21" height="21" rx="5" fill="#ffffff" stroke="#000000" strokeOpacity={0.28} strokeWidth={1} />
      <path d="M7.2 17.6c0-5.2 3-8.4 8.4-8.6" fill="none" stroke="#1d4ed8" strokeWidth={2.4} strokeLinecap="round" />
      <path d="M12.6 5.6l4.6 3.4-4 4.2" fill="none" stroke="#1d4ed8" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
