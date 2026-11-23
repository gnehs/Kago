import { useMemo } from "react";
import { Archive, Download, Inbox, Trash2 } from "lucide-react";
import type { useFileList } from "@/api/hooks";
import { KagoIconButton } from "@/components/kago/icon-button";
import { t } from "@/lib/i18n";
import { formatSize } from "@/lib/format";
import type { FileItem } from "@/types/kago";
import { canTrash } from "./FileMenu";
import type { FileSearch } from "./useFileSearch";
import type { FileActions } from "./useFileActions";
import type { classifyFileWindowError } from "./WindowErrorState";

type FileStatusBarProps = {
  selectedItems: FileItem[];
  /** Everything the window's folder holds. */
  allItems: FileItem[];
  readonly: boolean;
  actions: FileActions;
  error: ReturnType<typeof classifyFileWindowError>;
  search: FileSearch;
  fileList: ReturnType<typeof useFileList>;
};

/** The strip under the window: what is selected and what can be done with it, or else what the folder (or the search) holds. */
export function FileStatusBar({ selectedItems, allItems, readonly, actions, error, search, fileList }: FileStatusBarProps) {
  const { searching, results, found, pending: searchPending, searched } = search;
  const selectedPaths = selectedItems.map((item) => item.path);
  // What the folder holds, for the status bar: how many of each, and how much the files weigh.
  const summary = useMemo(() => {
    const files = allItems.filter((item) => item.kind === "file");
    const folders = allItems.length - files.length;
    if (allItems.length === 0) return t("{count} item | {count} items", { count: 0 });
    const counts = [folders > 0 ? t("{count} folder | {count} folders", { count: folders }) : null, files.length > 0 ? t("{count} file | {count} files", { count: files.length }) : null].filter(Boolean).join(t(", "));
    return files.length > 0 ? `${counts} · ${formatSize(files.reduce((total, item) => total + item.size, 0))}` : counts;
  }, [allItems]);

  return (
    <footer className="kago-toolbar flex h-8 shrink-0 items-center gap-1 border-t pointer-coarse:gap-2 border-line-strong px-3 text-xs text-muted">
      {selectedItems.length > 0 ? (
        <>
          <span className="min-w-0 flex-1 truncate text-ink">
            {t("{count} selected", { count: selectedItems.length })}
            {selectedItems.every((item) => item.kind === "file") ? ` · ${formatSize(selectedItems.reduce((total, item) => total + item.size, 0))}` : ""}
          </span>
          <KagoIconButton label={t("Download")} className="kago-hit-slop size-6" onClick={() => void actions.download(selectedItems)}><Download /></KagoIconButton>
          <KagoIconButton label={t("Add to Shelf")} className="kago-hit-slop size-6" onClick={() => void actions.addToShelf(selectedPaths)}><Inbox /></KagoIconButton>
          <KagoIconButton label={t("Compress")} className="kago-hit-slop size-6" disabled={readonly} onClick={() => void actions.compress(selectedPaths)}><Archive /></KagoIconButton>
          <KagoIconButton label={t("Move to Trash")} className="kago-hit-slop size-6" disabled={!canTrash(readonly, selectedItems)} onClick={() => void actions.trash(selectedPaths)}><Trash2 /></KagoIconButton>
        </>
      ) : (
        <span className="truncate">{error ? t("Couldn’t load") : searching ? (results?.truncated ? t("Showing the first {count} matches", { count: found.length }) : t("{count} item found | {count} items found", { count: found.length })) : summary}{error ? "" : searching ? (searchPending ? ` · ${t("Searching…")}` : searched.isError && results ? ` · ${t("Couldn’t load")}` : "") : fileList.isError ? ` · ${t("Couldn’t load")}` : fileList.data?.partial ? ` · ${t("Loading…")}` : ""}</span>
      )}
    </footer>
  );
}
