import { ChevronLeft, ChevronRight, Database, Download, Eye, KeyRound, Table2 } from "lucide-react";
import { useState } from "react";
import { downloadUrl } from "@/api/client";
import { useSqliteOverview, useSqliteRows } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/components/kago/window";
import { errorMessage, formatSize } from "@/lib/format";
import { triggerDownload } from "@/lib/paths";
import { cn } from "@/lib/utils";
import type { PreviewWindow } from "@/stores/workspace";
import type { SqliteCell, SqliteTable } from "@/types/kago";
import { FileIcon } from "@/components/kago/file-icon";
import { KagoStatusBar } from "@/components/kago/status-bar";
import { locale, t } from "@/lib/i18n";

const PAGE_SIZE = 100;
const count = new Intl.NumberFormat(locale);

/** Which rows are on screen, and out of how many when the table could be counted. */
function rangeLabel(page: { offset: number; rows: unknown[]; total: number | null }) {
  const total = page.total === null ? null : count.format(page.total);
  if (page.rows.length === 0) return total === null ? "" : t("{total} rows", { total });
  const range = { from: count.format(page.offset + 1), to: count.format(page.offset + page.rows.length) };
  return total === null ? t("Rows {from}–{to}", range) : t("Rows {from}–{to} of {total}", { ...range, total });
}

/** A SQLite database, read on the server: its tables on the left, the rows of one of them on the right. */
export function SqlitePreviewWindow({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  const overview = useSqliteOverview(rootSlug, item.path);
  const tables = overview.data?.tables ?? [];
  const [selected, setSelected] = useState<{ table: string; offset: number } | null>(null);
  const table = tables.find((entry) => entry.name === selected?.table) ?? tables[0];
  const offset = table && table.name === selected?.table ? selected.offset : 0;
  const download = () => triggerDownload(downloadUrl(rootSlug, item.path));

  return (
    <KagoWindow
      window={window}
      icon={<FileIcon item={item} />}
      titleExtra={
        <KagoIconButton label={t("Download")} className="size-6" onClick={download}>
          <Download />
        </KagoIconButton>
      }
    >
      {overview.isPending ? (
        <KagoLoading />
      ) : overview.error ? (
        <KagoEmptyState className="min-h-0 flex-1" icon={<Database />} title={t("Couldn’t open the database")} description={errorMessage(overview.error, t("Please try again later."))}>
          <Button variant="default" onClick={download}>{t("Download")}</Button>
        </KagoEmptyState>
      ) : !table ? (
        <KagoEmptyState className="min-h-0 flex-1" icon={<Database />} title={t("This database has no tables")} />
      ) : (
        <div className="flex min-h-0 flex-1">
          <nav aria-label={t("Tables")} className="flex w-44 shrink-0 border-r border-line bg-elevated">
            <div className="flex min-w-0 flex-1 scroll-fade flex-col gap-px overflow-y-auto p-1.5">
              {tables.map((entry) => (
                <button
                  key={entry.name}
                  type="button"
                  aria-current={entry.name === table.name}
                  title={entry.name}
                  className={cn("flex h-(--kago-row-h) shrink-0 items-center gap-2 rounded-sm px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50", entry.name === table.name ? "bg-accent-soft" : "hover:bg-hover")}
                  onClick={() => setSelected({ table: entry.name, offset: 0 })}
                >
                  {entry.type === "view" ? <Eye className="text-muted" /> : <Table2 className="text-muted" />}
                  <span className="truncate">{entry.name}</span>
                </button>
              ))}
            </div>
          </nav>
          <SqliteRows key={table.name} rootSlug={rootSlug} path={item.path} table={table} offset={offset} onOffset={(next) => setSelected({ table: table.name, offset: next })} />
        </div>
      )}
    </KagoWindow>
  );
}

function SqliteRows({ rootSlug, path, table, offset, onOffset }: { rootSlug: string; path: string; table: SqliteTable; offset: number; onOffset: (offset: number) => void }) {
  const query = useSqliteRows(rootSlug, path, table.name, offset, PAGE_SIZE);
  const page = query.data;
  // The schema names the columns before the first page arrives, and says more about them than a result set does.
  const columns = page?.columns ?? table.columns.map((column) => column.name);
  const described = new Map(table.columns.map((column) => [column.name, column]));

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-surface">
      <div className="min-h-0 flex-1 overflow-auto">
        {query.error ? (
          <KagoEmptyState className="h-full" icon={<Database />} title={t("Couldn’t read the table")} description={errorMessage(query.error, t("Please try again later."))} />
        ) : (
          <table className="border-separate border-spacing-0 whitespace-nowrap">
            <thead>
              <tr>
                <th className="sticky top-0 left-0 z-20 border-r border-b border-line bg-elevated px-2" />
                {columns.map((name, index) => (
                  <th key={index} className="sticky top-0 z-10 h-(--kago-row-h) border-r border-b border-line bg-elevated px-2.5 text-left font-medium">
                    <span className="flex items-center gap-1.5">
                      {described.get(name)?.pk ? <KeyRound aria-label={t("Primary key")} className="size-3 text-muted" /> : null}
                      {name}
                      <span className="font-normal text-faint">{described.get(name)?.type}</span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={cn(query.isPlaceholderData && "opacity-60")}>
              {page?.rows.map((row, rowIndex) => (
                <tr key={page.offset + rowIndex} className="hover:bg-hover">
                  <td className="sticky left-0 border-r border-b border-line bg-elevated px-2 text-right text-faint tabular-nums">{page.offset + rowIndex + 1}</td>
                  {row.map((value, index) => (
                    <td key={index} className="h-7 max-w-80 truncate border-r border-b border-line px-2.5 tabular-nums" title={typeof value === "string" ? value : undefined}>
                      <Cell value={value} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {query.isPending ? <KagoLoading /> : page?.rows.length === 0 ? <KagoEmptyState title={offset > 0 ? t("No more rows") : t("This table is empty")} /> : null}
      </div>
      <KagoStatusBar>
        <span className="mr-auto tabular-nums">
          {page ? rangeLabel(page) : ""}
        </span>
        <KagoIconButton label={t("Back")} className="size-6" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - PAGE_SIZE))}>
          <ChevronLeft />
        </KagoIconButton>
        <KagoIconButton label={t("Forward")} className="size-6" disabled={!page?.hasMore} onClick={() => onOffset(offset + PAGE_SIZE)}>
          <ChevronRight />
        </KagoIconButton>
      </KagoStatusBar>
    </div>
  );
}

function Cell({ value }: { value: SqliteCell }) {
  if (value === null) return <span className="text-faint">NULL</span>;
  if (typeof value === "object") return <span className="text-faint">BLOB · {formatSize(value.blob)}</span>;
  return <>{value}</>;
}
