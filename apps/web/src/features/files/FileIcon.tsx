import type { ReactNode } from "react";
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
 * Everything is stroked and tinted with `currentColor`, so a selected row can recolour its icon by setting the text colour.
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

/** The icon of a row: 16px beside a name, in the colour of its kind. */
export function FileIcon({ item, className }: { item: IconItem; className?: string }) {
  const kind = fileKind(item);
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={cn("kago-icon", KIND_TONES[kind], className)} {...STROKE} strokeWidth={1.75}>
      {kind === "folder" ? (
        <>
          <path d="M2.5 6.5a2 2 0 0 1 2-2h3.7a2 2 0 0 1 1.7.9l.9 1.4a2 2 0 0 0 1.7.9h7a2 2 0 0 1 2 2v8.8a2 2 0 0 1-2 2h-15a2 2 0 0 1-2-2z" fill="currentColor" fillOpacity={0.25} />
          <path d="M2.5 11h19" />
        </>
      ) : (
        <>
          <path d="M6.5 2.5h7.7l5.3 5.3v11.7a2 2 0 0 1-2 2h-11a2 2 0 0 1-2-2v-15a2 2 0 0 1 2-2z" fill="currentColor" fillOpacity={0.14} />
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

const SHEET = "M14.5 3.5H36L49.5 17v35.5a4 4 0 0 1-4 4h-31a4 4 0 0 1-4-4v-45a4 4 0 0 1 4-4z";
/** Lines of text that fit on a sheet above its label, and the characters that fit across it. */
const SHEET_LINES = 7;
const SHEET_COLUMNS = 17;

/**
 * The icon at the size of a tile: the same sheet, with room for the extension as a label
 * and, for text, the opening lines of the file in place of the mark.
 */
export function FileTile({ item, text, className }: { item: IconItem; text?: string; className?: string }) {
  const kind = fileKind(item);
  if (kind === "folder") {
    return (
      <svg viewBox="0 0 60 60" aria-hidden className={cn("kago-tile shrink-0", KIND_TONES.folder, className)} {...STROKE} strokeWidth={1.5}>
        <path d="M6.5 15.5a4 4 0 0 1 4-4h11.2a4 4 0 0 1 3.3 1.8l1.9 2.9a4 4 0 0 0 3.3 1.8h19.3a4 4 0 0 1 4 4v24.5a4 4 0 0 1-4 4h-39a4 4 0 0 1-4-4z" fill="currentColor" fillOpacity={0.14} />
        <path d="M6.5 25.5h47v21a4 4 0 0 1-4 4h-39a4 4 0 0 1-4-4z" fill="currentColor" fillOpacity={0.2} />
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
  const clip = `kago-sheet-${label ? "labelled" : "plain"}`;
  return (
    <svg viewBox="0 0 60 60" aria-hidden className={cn("kago-tile shrink-0", KIND_TONES[kind], className)} {...STROKE} strokeWidth={1.5}>
      <path d={SHEET} strokeOpacity={0.6} style={{ fill: "color-mix(in srgb, currentColor 8%, var(--kago-surface))" }} />
      {written ? (
        <>
          <clipPath id={clip}>
            <rect x="11" y="4" width="33.5" height={label ? 35.5 : 50} />
          </clipPath>
          <text clipPath={`url(#${clip})`} stroke="none" fontSize={3.3} fontFamily="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" style={{ fill: "var(--kago-text-muted)", whiteSpace: "pre" }}>
            {lines.map((line, index) => (
              <tspan key={index} x={14.5} y={12 + index * 4.1}>
                {line}
              </tspan>
            ))}
          </text>
        </>
      ) : MARKS[kind] ? (
        <g transform={`translate(21 ${label ? 19.5 : 25}) scale(1.8)`}>
          {MARKS[kind]}
        </g>
      ) : null}
      {/* Drawn over the text, so lines that reach the corner run under the fold. */}
      <path d="M36 3.5V13a4 4 0 0 0 4 4h9.5z" strokeOpacity={0.6} style={{ fill: "color-mix(in srgb, currentColor 22%, var(--kago-surface))" }} />
      {label ? (
        <>
          <rect x="15" y="41.5" width="30" height="10" rx="3" fill="currentColor" stroke="none" />
          <text x="30" y="48.9" textAnchor="middle" stroke="none" fontSize={label.length > 4 ? 5.6 : 6.6} fontWeight={700} letterSpacing={0.2} style={{ fill: "var(--kago-surface)" }}>
            {label}
          </text>
        </>
      ) : null}
    </svg>
  );
}
