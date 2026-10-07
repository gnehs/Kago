import { useEffect, useMemo, useState } from "react";
import { read, utils, type WorkBook } from "xlsx";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { cn } from "@/lib/utils";
import { locale, t } from "@/lib/i18n";

// A sheet is drawn whole, so what is drawn is bounded; the file itself can hold far more.
const MAX_ROWS = 1000;
const MAX_COLUMNS = 100;
const count = new Intl.NumberFormat(locale);

type Grid = { rows: string[][]; columns: number; clipped: boolean };

function gridOf(book: WorkBook, name: string): Grid {
  const sheet = book.Sheets[name];
  const ref = sheet?.["!ref"];
  if (!sheet || !ref) return { rows: [], columns: 0, clipped: false };
  // The rows the parser was told to stop at are still counted in the full range.
  const full = utils.decode_range(sheet["!fullref"] ?? ref);
  const end = { r: Math.min(full.e.r, MAX_ROWS - 1), c: Math.min(full.e.c, MAX_COLUMNS - 1) };
  // From A1 rather than from the first used cell, so the row and column labels are the sheet's own.
  const rows = utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: "", blankrows: true, range: { s: { r: 0, c: 0 }, e: end } });
  return { rows, columns: end.c + 1, clipped: full.e.r > end.r || full.e.c > end.c };
}

/** A spreadsheet as a grid of what its cells display, one sheet at a time. */
export default function SheetView({ data, onError }: { data: ArrayBuffer; onError: () => void }) {
  const book = useMemo(() => {
    try {
      return read(data, { type: "array", sheetRows: MAX_ROWS });
    } catch {
      return null;
    }
  }, [data]);
  useEffect(() => {
    if (!book) onError();
  }, [book, onError]);

  const [selected, setSelected] = useState(0);
  const names = book?.SheetNames ?? [];
  const name = names[selected] ?? names[0];
  const grid = useMemo(() => (book && name !== undefined ? gridOf(book, name) : null), [book, name]);
  if (!book || !grid) return null;

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      <div className="min-h-0 flex-1 overflow-auto select-text">
        {grid.rows.length === 0 ? (
          <KagoEmptyState className="h-full" title={t("This sheet is empty")} />
        ) : (
          <table className="border-separate border-spacing-0 whitespace-nowrap">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-20 border-r border-b border-line bg-elevated" />
                {Array.from({ length: grid.columns }, (_, index) => (
                  <th key={index} className="sticky top-0 z-10 h-6 min-w-16 border-r border-b border-line bg-elevated px-2 text-center font-normal text-muted">
                    {utils.encode_col(index)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grid.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  <td className="sticky left-0 border-r border-b border-line bg-elevated px-2 text-right text-muted tabular-nums">{rowIndex + 1}</td>
                  {Array.from({ length: grid.columns }, (_, index) => (
                    <td key={index} className="h-6 max-w-80 truncate border-r border-b border-line px-2 tabular-nums" title={row[index] || undefined}>
                      {row[index]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <footer className="flex h-7 shrink-0 items-center gap-1 border-t border-line bg-elevated px-1.5 text-muted">
        <div role="tablist" aria-label={t("Sheets")} className="flex min-w-0 flex-1 gap-px overflow-x-auto">
          {names.map((sheet, index) => (
            <button
              key={sheet}
              type="button"
              role="tab"
              aria-selected={sheet === name}
              className={cn("h-6 shrink-0 rounded-sm px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/50", sheet === name ? "bg-accent-soft text-ink" : "hover:bg-hover hover:text-ink")}
              onClick={() => setSelected(index)}
            >
              {sheet}
            </button>
          ))}
        </div>
        {grid.clipped ? <span className="shrink-0 px-1.5">{t("Showing only the first {rows} rows and {columns} columns", { rows: count.format(MAX_ROWS), columns: MAX_COLUMNS })}</span> : null}
      </footer>
    </div>
  );
}
