import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { FileItem } from "@/types/kago";
import { extensionOf, fileKind, KIND_TONES, type FileKind } from "./fileKind";

export function isArchive(item: Pick<FileItem, "kind" | "name">) {
  return item.kind === "file" && item.name.toLowerCase().endsWith(".zip");
}

type IconItem = Pick<FileItem, "kind" | "type" | "name">;

/*
 * Kago's file icons are drawn here rather than taken from an icon set, as two sizes of one system:
 * a sheet with a cut corner (or a folder) in the colour of the kind, carrying a mark that says what is inside.
 * The colour of a kind is `currentColor`; its lighter and darker shades are mixed from it, so one token colours a whole icon.
 * Paper stays white in either theme, which is also what keeps an icon readable on a selected row.
 */

/** What a kind holds, on a 10×10 field. Drawn inside the sheet at either size. */
const MARKS: Partial<Record<FileKind, ReactNode>> = {
  image: (
    <>
      <path d="M0.5 9.5 3.7 5.2 6 7.8 7.4 6.4 9.5 9.5" />
      <circle cx="7.3" cy="2.4" r="1.1" />
    </>
  ),
  video: <path d="M2.6 1.4 8.6 5 2.6 8.6Z" fill="currentColor" />,
  audio: <path d="M1 4v2M3.7 1.5v7M6.3 3.2v3.6M9 2v6" />,
  archive: (
    <>
      <path d="M5 0.3v4.2" strokeDasharray="1.4 1.4" strokeLinecap="butt" />
      <rect x="3" y="5.4" width="4" height="4" rx="1" />
    </>
  ),
  pdf: <path d="M1 1.5h8M1 5h8M1 8.5h4.5" />,
  document: <path d="M1 1.5h8M1 5h8M1 8.5h4.5" />,
  text: <path d="M1 1.5h8M1 5h8M1 8.5h4.5" />,
  sheet: (
    <>
      <rect x="0.7" y="0.7" width="8.6" height="8.6" rx="1" />
      <path d="M0.7 4h8.6M4 0.7v8.6" />
    </>
  ),
  slides: (
    <>
      <rect x="0.7" y="1" width="8.6" height="5.6" rx="1" />
      <path d="M5 6.6v2.6M3 9.3h4" />
    </>
  ),
  code: <path d="M3.4 1.8 0.6 5l2.8 3.2M6.6 1.8 9.4 5 6.6 8.2" />,
  database: (
    <>
      <ellipse cx="5" cy="2.3" rx="4" ry="1.6" />
      <path d="M1 2.3v5.4c0 .9 1.8 1.6 4 1.6s4-.7 4-1.6V2.3M1 5c0 .9 1.8 1.6 4 1.6S9 5.9 9 5" />
    </>
  )
};

const STROKE = { fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" } as const;

/** The colour of the kind, lit from above: a lighter shade at the top running down to a darker one. */
function Tone({ id, light = 30, dark = 0 }: { id: string; light?: number; dark?: number }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style={{ stopColor: `color-mix(in srgb, currentColor ${100 - light}%, #ffffff)` }} />
      <stop offset="1" style={{ stopColor: `color-mix(in srgb, currentColor ${100 - dark}%, #000000)` }} />
    </linearGradient>
  );
}

/** Paper is white in either theme, a little greyer towards the bottom. */
function Paper({ id }: { id: string }) {
  return (
    <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" style={{ stopColor: "var(--kago-paper-from)" }} />
      <stop offset="1" style={{ stopColor: "var(--kago-paper-to)" }} />
    </linearGradient>
  );
}

/**
 * Light caught along the inside of an edge: the shape's own outline, stroked in white that fades towards the bottom
 * and clipped to the shape, so it follows every corner the shape has. `width` is how far it reaches in.
 */
function Rim({ id, d, width, opacity = 0.8 }: { id: string; d: string; width: number; opacity?: number }) {
  return (
    <>
      <linearGradient id={`${id}-light`} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor="#ffffff" stopOpacity={opacity} />
        <stop offset="0.7" stopColor="#ffffff" stopOpacity={0} />
      </linearGradient>
      <clipPath id={id}>
        <path d={d} />
      </clipPath>
      <path d={d} fill="none" stroke={`url(#${id}-light)`} strokeWidth={width * 2} clipPath={`url(#${id})`} />
    </>
  );
}

const BACK = { stroke: "none", style: { fill: "color-mix(in srgb, currentColor 76%, #000000)" } } as const;

const FOLDER_FRONT_16 = "M2 11a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v6.8a2.2 2.2 0 0 1-2.2 2.2H4.2A2.2 2.2 0 0 1 2 17.8z";

/** The icon of a row: 16px beside a name, in the colour of its kind. */
export function FileIcon({ item, className }: { item: IconItem; className?: string }) {
  const kind = fileKind(item);
  const id = useId();
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("kago-icon", KIND_TONES[kind], className)} {...STROKE} strokeWidth={1.5}>
      {kind === "folder" ? (
        <>
          <Tone id={id} light={34} />
          <path d="M2 6.2a2.2 2.2 0 0 1 2.2-2.2h3.9a2.2 2.2 0 0 1 1.8 1l.8 1.2a2.2 2.2 0 0 0 1.8 1h7.3A2.2 2.2 0 0 1 22 9.4v8.4a2.2 2.2 0 0 1-2.2 2.2H4.2A2.2 2.2 0 0 1 2 17.8z" {...BACK} />
          <path d={FOLDER_FRONT_16} fill={`url(#${id})`} stroke="none" />
          <Rim id={`${id}-rim`} d={FOLDER_FRONT_16} width={0.9} opacity={0.7} />
        </>
      ) : (
        <>
          <Paper id={id} />
          <path d="M6.5 2.5h7.7l5.3 5.3v11.7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z" className="kago-icon-sheet" fill={`url(#${id})`} />
          {MARKS[kind] ? (
            <g transform="translate(8.2 10.4) scale(0.76)" strokeWidth={1.7}>
              {MARKS[kind]}
            </g>
          ) : null}
        </>
      )}
    </svg>
  );
}

const tint = (amount: number) => `color-mix(in srgb, currentColor ${100 - amount}%, #ffffff)`;
const shade = (amount: number) => `color-mix(in srgb, currentColor ${100 - amount}%, #000000)`;
const NONE = { stroke: "none" } as const;

/**
 * What a kind holds, at the size of a tile: a small object in the shades of the kind rather than a line drawing.
 * Drawn on a 24×24 field; `tone` is the gradient of the kind and `clip` an id the emblem may use.
 */
const EMBLEMS: Partial<Record<FileKind, (tone: string, clip: string) => ReactNode>> = {
  image: (tone, clip) => (
    <>
      <clipPath id={clip}>
        <rect x="1.5" y="3.5" width="21" height="17" rx="2.6" />
      </clipPath>
      <g clipPath={`url(#${clip})`} {...NONE}>
        <rect x="1.5" y="3.5" width="21" height="17" style={{ fill: tint(72) }} />
        <circle cx="16.8" cy="8.6" r="2.3" fill="#ffffff" />
        <path d="M-1 22 8.4 10.6l5 6.2 2.6-2.8L23 22z" style={{ fill: tint(18) }} />
        <path d="M-1 22 8.4 10.6l3 3.7L5 22z" style={{ fill: shade(12) }} />
      </g>
      <rect x="1.5" y="3.5" width="21" height="17" rx="2.6" fill="none" style={{ stroke: shade(6) }} strokeWidth={0.8} strokeOpacity={0.75} />
    </>
  ),
  video: (tone) => (
    <>
      <rect x="1.5" y="4" width="21" height="16" rx="3.6" fill={tone} {...NONE} />
      <path d="M5.1 4.6h13.8a3 3 0 0 1 3 3v3.6H2.1V7.6a3 3 0 0 1 3-3z" fill="#ffffff" fillOpacity={0.16} {...NONE} />
      <path d="M9.9 8.5v7l6-3.5z" fill="#ffffff" stroke="#ffffff" strokeWidth={1.3} />
    </>
  ),
  audio: (tone) => (
    <g fill={tone} {...NONE}>
      <rect x="1.6" y="9" width="2.8" height="6" rx="1.4" />
      <rect x="6.1" y="5" width="2.8" height="14" rx="1.4" />
      <rect x="10.6" y="2" width="2.8" height="20" rx="1.4" />
      <rect x="15.1" y="6.5" width="2.8" height="11" rx="1.4" />
      <rect x="19.6" y="9.5" width="2.8" height="5" rx="1.4" />
    </g>
  ),
  archive: (tone) => (
    <>
      <path d="M9.4 0.5h2.6v2.3H9.4zM12 2.8h2.6v2.3H12zM9.4 5.1h2.6v2.3H9.4zM12 7.4h2.6v2.3H12zM9.4 9.7h2.6V12H9.4z" style={{ fill: shade(10) }} fillOpacity={0.8} {...NONE} />
      <rect x="7.6" y="12.6" width="8.8" height="10.4" rx="2.4" fill={tone} {...NONE} />
      <rect x="10" y="16.3" width="4" height="4.2" rx="1" style={{ fill: "var(--kago-paper-from)" }} {...NONE} />
    </>
  ),
  pdf: (tone) => LINES(tone),
  document: (tone) => LINES(tone),
  text: (tone) => LINES(tone),
  sheet: (tone, clip) => (
    <>
      <clipPath id={clip}>
        <rect x="1.5" y="3" width="21" height="18" rx="2.4" />
      </clipPath>
      <g clipPath={`url(#${clip})`} {...NONE}>
        <rect x="1.5" y="3" width="21" height="18" style={{ fill: tint(86) }} />
        <rect x="1.5" y="3" width="21" height="5" fill={tone} />
        <rect x="1.5" y="8" width="6" height="13" style={{ fill: tint(62) }} />
      </g>
      <path d="M1.5 8h21M1.5 12.3h21M1.5 16.7h21M7.5 3v18M15 3v18" style={{ stroke: shade(4) }} strokeWidth={0.7} strokeOpacity={0.45} />
      <rect x="1.5" y="3" width="21" height="18" rx="2.4" fill="none" style={{ stroke: shade(6) }} strokeWidth={0.8} strokeOpacity={0.75} />
    </>
  ),
  slides: (tone) => (
    <>
      <path d="M12 16v4M8 21.5h8" style={{ stroke: shade(10) }} strokeWidth={1.7} />
      <rect x="1.5" y="2.5" width="21" height="14.5" rx="2.6" fill={tone} {...NONE} />
      <g fill="#ffffff" {...NONE}>
        <rect x="5.2" y="10" width="3" height="4" rx="0.8" fillOpacity={0.75} />
        <rect x="10.5" y="6" width="3" height="8" rx="0.8" />
        <rect x="15.8" y="8.2" width="3" height="5.8" rx="0.8" fillOpacity={0.85} />
      </g>
    </>
  ),
  code: (tone) => (
    <>
      <path d="M8.2 5.5 2.2 12l6 6.5M15.8 5.5l6 6.5-6 6.5" stroke={tone} strokeWidth={2.6} />
    </>
  ),
  database: (tone) => (
    <g {...NONE}>
      {[13.4, 8.2, 3].map((y, index) => (
        <g key={y}>
          <path d={`M3 ${y + 2.4}v3.6c0 1.7 4 3 9 3s9-1.3 9-3v-3.6z`} fill={tone} />
          <ellipse cx="12" cy={y + 2.4} rx="9" ry="3" style={{ fill: tint(index === 2 ? 55 : 30) }} />
        </g>
      ))}
    </g>
  )
};

/** Writing: a heading and the lines under it. */
function LINES(tone: string) {
  return (
    <g fill={tone} {...NONE}>
      <rect x="2" y="3" width="11" height="3" rx="1.5" />
      <rect x="2" y="9" width="20" height="2" rx="1" fillOpacity={0.55} />
      <rect x="2" y="13" width="20" height="2" rx="1" fillOpacity={0.55} />
      <rect x="2" y="17" width="20" height="2" rx="1" fillOpacity={0.55} />
      <rect x="2" y="21" width="12" height="2" rx="1" fillOpacity={0.55} />
    </g>
  );
}

const FOLDER_BACK = "M5 14.5a4.5 4.5 0 0 1 4.5-4.5h11.3a4.5 4.5 0 0 1 3.7 2l2 3a4.5 4.5 0 0 0 3.7 2h20.3a4.5 4.5 0 0 1 4.5 4.5v25a4.5 4.5 0 0 1-4.5 4.5h-41a4.5 4.5 0 0 1-4.5-4.5z";
const FOLDER_FRONT = "M5 27a4 4 0 0 1 4-4h42a4 4 0 0 1 4 4v19.5a4.5 4.5 0 0 1-4.5 4.5h-41a4.5 4.5 0 0 1-4.5-4.5z";
const LABEL = "M17.7 41.5h24.6a3.2 3.2 0 0 1 3.2 3.2v4.1a3.2 3.2 0 0 1-3.2 3.2H17.7a3.2 3.2 0 0 1-3.2-3.2v-4.1a3.2 3.2 0 0 1 3.2-3.2z";
const FOLD = "M36 3.5V13a4 4 0 0 0 4 4h9.5z";
const SHEET = "M14.5 3.5H36L49.5 17v35.5a4 4 0 0 1-4 4h-31a4 4 0 0 1-4-4v-45a4 4 0 0 1 4-4z";
/** Lines of text that fit on a sheet above its label, and the characters that fit across it. */
const SHEET_LINES = 7;
const SHEET_COLUMNS = 17;
const EDGE = { stroke: "var(--kago-paper-edge)", strokeWidth: 0.7 } as const;

/**
 * The icon at the size of a tile: the same sheet, with room for the extension as a label
 * and, for text, the opening lines of the file in place of the emblem.
 */
export function FileTile({ item, text, className }: { item: IconItem; text?: string; className?: string }) {
  const kind = fileKind(item);
  const id = useId();
  const tone = `url(#${id}-tone)`;
  if (kind === "folder") {
    return (
      <svg viewBox="0 0 60 60" aria-hidden className={cn("kago-tile shrink-0", KIND_TONES.folder, className)} {...STROKE}>
        <linearGradient id={`${id}-back`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: shade(8) }} />
          <stop offset="1" style={{ stopColor: shade(34) }} />
        </linearGradient>
        <linearGradient id={`${id}-tone`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" style={{ stopColor: tint(42) }} />
          <stop offset="0.55" style={{ stopColor: tint(12) }} />
          <stop offset="1" style={{ stopColor: shade(10) }} />
        </linearGradient>
        <radialGradient id={`${id}-sheen`} cx="0.2" cy="0" r="0.9">
          <stop offset="0" stopColor="#ffffff" stopOpacity={0.35} />
          <stop offset="1" stopColor="#ffffff" stopOpacity={0} />
        </radialGradient>
        <path d={FOLDER_BACK} fill={`url(#${id}-back)`} {...NONE} />
        <Rim id={`${id}-back-rim`} d={FOLDER_BACK} width={0.8} opacity={0.45} />
        {/* What the folder holds, just showing over its front. */}
        <path d="M8.5 20.5h43v9h-43z" style={{ fill: "var(--kago-paper-from)" }} {...NONE} />
        <path d="M8.5 21.5h43" stroke="#000000" strokeOpacity={0.12} strokeWidth={0.6} />
        <path d={FOLDER_FRONT} fill={tone} {...NONE} />
        <path d={FOLDER_FRONT} fill={`url(#${id}-sheen)`} {...NONE} />
        <Rim id={`${id}-front-rim`} d={FOLDER_FRONT} width={0.9} />
        {/* The front turns away from the light towards its bottom edge: a shade that fades in, kept inside the shape. */}
        <linearGradient id={`${id}-under`} gradientUnits="userSpaceOnUse" x1="0" y1="43" x2="0" y2="51">
          <stop offset="0" style={{ stopColor: shade(45) }} stopOpacity={0} />
          <stop offset="1" style={{ stopColor: shade(45) }} stopOpacity={0.5} />
        </linearGradient>
        <rect x="5" y="43" width="50" height="8" fill={`url(#${id}-under)`} clipPath={`url(#${id}-front-rim)`} {...NONE} />
      </svg>
    );
  }
  const extension = extensionOf(item.name);
  const label = extension.length > 0 && extension.length <= 6 ? extension.toUpperCase() : "";
  const lines = text
    ? text
        .replaceAll("\t", "  ")
        .split(/\r?\n/)
        .slice(0, SHEET_LINES + (label ? 0 : 3))
        .map((line) => line.slice(0, SHEET_COLUMNS))
    : [];
  const written = lines.some((line) => line.trim());
  const emblem = EMBLEMS[kind];
  return (
    <svg viewBox="0 0 60 60" aria-hidden className={cn("kago-tile shrink-0", KIND_TONES[kind], className)} {...STROKE}>
      <Paper id={`${id}-paper`} />
      <Tone id={`${id}-tone`} light={26} dark={16} />
      <linearGradient id={`${id}-fold`} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0.3" style={{ stopColor: "var(--kago-paper-from)" }} />
        <stop offset="1" style={{ stopColor: "color-mix(in srgb, currentColor 16%, var(--kago-paper-to))" }} />
      </linearGradient>
      <path d={SHEET} fill={`url(#${id}-paper)`} {...EDGE} />
      <Rim id={`${id}-paper-rim`} d={SHEET} width={1.5} opacity={1} />
      <path d={SHEET} fill="none" {...EDGE} />
      {written ? (
        <>
          <clipPath id={`${id}-clip`}>
            <rect x="11" y="4" width="33.5" height={label ? 35.5 : 50} />
          </clipPath>
          <text clipPath={`url(#${id}-clip)`} stroke="none" fontSize={3.3} fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" style={{ fill: "var(--kago-paper-ink)", whiteSpace: "pre" }}>
            {lines.map((line, index) => (
              <tspan key={index} x={14.5} y={12 + index * 4.1}>
                {line}
              </tspan>
            ))}
          </text>
        </>
      ) : emblem ? (
        <g transform={`translate(18 ${label ? 15.5 : 20})`}>{emblem(tone, `${id}-emblem`)}</g>
      ) : null}
      {/* Drawn over the text, so lines that reach the corner run under the fold. */}
      {/* The fold lifts off the sheet a little: its own shape, blurred, lying just under it. */}
      <filter id={`${id}-soften`} x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="1.1" />
      </filter>
      <path d={FOLD} transform="translate(-0.7 1.1)" fill="#000000" fillOpacity={0.3} filter={`url(#${id}-soften)`} clipPath={`url(#${id}-paper-rim)`} {...NONE} />
      <path d={FOLD} fill={`url(#${id}-fold)`} {...EDGE} />
      {label ? (
        <>
          <path d={LABEL} fill={tone} {...NONE} />
          <Rim id={`${id}-label-rim`} d={LABEL} width={0.9} opacity={0.65} />
          <path d={LABEL} fill="none" style={{ stroke: shade(30) }} strokeWidth={0.6} strokeOpacity={0.6} />
          <text x="30" y="49.2" textAnchor="middle" stroke="none" fontSize={label.length > 4 ? 5.6 : 6.6} fontWeight={700} letterSpacing={0.3} fill="#ffffff" style={{ paintOrder: "stroke" }}>
            {label}
          </text>
        </>
      ) : null}
    </svg>
  );
}
