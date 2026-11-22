import { useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, ChevronLeft, Lock } from "lucide-react";
import { useMemo, useState } from "react";
import { useArchiveEntries } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { FileIcon } from "@/components/kago/file-icon";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoStatusBar } from "@/components/kago/status-bar";
import { errorMessage, formatDate, formatSize } from "@/lib/format";
import { locale, t } from "@/lib/i18n";
import { parentPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { cn } from "@/lib/utils";
import type { PreviewWindow } from "@/stores/workspace";
import type { ArchiveEntry } from "@/types/kago";
import { startExtract } from "./ArchivePassword";
import { PreviewFailure, PreviewWindowFrame, usePreviewFile } from "./PreviewWindowFrame";

/** A file or folder as one folder of the archive shows it. */
type ArchiveNode = { name: string; path: string; folder: boolean; size: number; mtime: number | null; locked: boolean };

const byName = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });

/** Groups the flat entries by the folder each lies in, making up the folders a zip names only through the paths under them. */
function folderTree(entries: ArchiveEntry[]) {
  const folders = new Map<string, Map<string, ArchiveNode>>([["", new Map()]]);
  const folderOf = (folderPath: string): Map<string, ArchiveNode> => {
    let children = folders.get(folderPath);
    if (!children) {
      children = new Map();
      folders.set(folderPath, children);
      const slash = folderPath.lastIndexOf("/");
      const parent = folderOf(slash < 0 ? "" : folderPath.slice(0, slash));
      const name = folderPath.slice(slash + 1);
      if (!parent.has(name)) parent.set(name, { name, path: folderPath, folder: true, size: 0, mtime: null, locked: false });
    }
    return children;
  };
  for (const entry of entries) {
    if (!entry.path) continue;
    const slash = entry.path.lastIndexOf("/");
    const parentPath = slash < 0 ? "" : entry.path.slice(0, slash);
    const name = entry.path.slice(slash + 1);
    const siblings = folderOf(parentPath);
    if (entry.folder) {
      folderOf(entry.path);
      siblings.get(name)!.mtime = entry.mtime;
    } else {
      siblings.set(name, { name, path: entry.path, folder: false, size: entry.size, mtime: entry.mtime, locked: entry.locked });
    }
  }
  const sorted = new Map<string, ArchiveNode[]>();
  for (const [folderPath, children] of folders) {
    sorted.set(folderPath, [...children.values()].sort((a, b) => Number(b.folder) - Number(a.folder) || byName.compare(a.name, b.name)));
  }
  return sorted;
}

/** A zip, listed on the server from its central directory: its folders can be walked through without extracting anything. */
export function ArchivePreviewWindow({ window }: { window: PreviewWindow }) {
  const [folder, setFolder] = useState("");
  // The archive opened again as it is now starts at its top again.
  const { rootSlug, item, download } = usePreviewFile(window, () => setFolder(""));
  const listing = useArchiveEntries(rootSlug, item);
  const tree = useMemo(() => folderTree(listing.data?.entries ?? []), [listing.data]);
  const here = tree.has(folder) ? folder : "";
  const children = tree.get(here) ?? [];
  const files = listing.data?.entries.filter((entry) => !entry.folder) ?? [];
  const queryClient = useQueryClient();
  const extract = () => void run(() => startExtract(queryClient, { sources: [{ rootSlug, path: item.path }], destination: { rootSlug, path: parentPath(item.path) } }, undefined, window.id));
  const crumbs = here ? here.split("/") : [];
  const up = () => setFolder(crumbs.slice(0, -1).join("/"));

  return (
    <PreviewWindowFrame
      window={window}
      extra={
        item.readonly ? null : (
          <KagoIconButton label={t("Extract here")} size="sm" disabled={!listing.data} onClick={extract}>
            <ArchiveRestore />
          </KagoIconButton>
        )
      }
    >
      {listing.isPending ? (
        <KagoLoading />
      ) : listing.error ? (
        <PreviewFailure className="min-h-0 flex-1" icon={<Archive />} title={t("Couldn’t open the archive")} description={errorMessage(listing.error, t("Please try again later."))} onDownload={download} />
      ) : files.length === 0 && tree.get("")!.length === 0 ? (
        <KagoEmptyState className="min-h-0 flex-1" icon={<Archive />} title={t("This archive is empty")} />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col bg-surface">
          <nav aria-label={t("Folders in the archive")} className="flex h-9 shrink-0 items-center gap-1 border-b border-line bg-elevated px-1.5">
            <KagoIconButton label={t("Back")} size="sm" disabled={!here} onClick={up}>
              <ChevronLeft />
            </KagoIconButton>
            <ol className="flex min-w-0 items-center gap-0.5 overflow-hidden">
              {[item.name, ...crumbs].map((name, index) => {
                const target = crumbs.slice(0, index).join("/");
                const current = target === here;
                return (
                  <li key={index} className="flex min-w-0 items-center gap-0.5">
                    {index > 0 ? <span className="text-faint">/</span> : null}
                    <button
                      type="button"
                      aria-current={current ? "location" : undefined}
                      title={name}
                      className={cn("truncate rounded-sm px-1.5 py-0.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/50", current ? "font-medium" : "text-muted hover:bg-hover")}
                      onClick={() => setFolder(target)}
                    >
                      {name}
                    </button>
                  </li>
                );
              })}
            </ol>
          </nav>
          <div className="min-h-0 flex-1 overflow-auto">
            <table className="w-full border-separate border-spacing-0 whitespace-nowrap">
              <thead>
                <tr>
                  <th className="sticky top-0 z-10 h-(--kago-row-h) border-b border-line bg-elevated px-3 text-left font-medium">{t("Name")}</th>
                  <th className="sticky top-0 z-10 w-28 border-b border-line bg-elevated px-3 text-right font-medium">{t("Size")}</th>
                  <th className="sticky top-0 z-10 w-44 border-b border-line bg-elevated px-3 text-left font-medium">{t("Modified")}</th>
                </tr>
              </thead>
              <tbody>
                {children.map((node) => (
                  <tr
                    key={node.path}
                    className={cn("hover:bg-hover", node.folder && "cursor-default")}
                    onDoubleClick={node.folder ? () => setFolder(node.path) : undefined}
                  >
                    <td className="h-(--kago-row-h) max-w-0 border-b border-line px-3">
                      {node.folder ? (
                        <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50" title={node.name} onClick={() => setFolder(node.path)}>
                          <FileIcon item={{ kind: "folder", type: "", name: node.name }} className="size-4 shrink-0" />
                          <span className="truncate">{node.name}</span>
                        </button>
                      ) : (
                        <span className="flex min-w-0 items-center gap-2" title={node.name}>
                          <FileIcon item={{ kind: "file", type: "", name: node.name }} className="size-4 shrink-0" />
                          <span className="truncate">{node.name}</span>
                          {node.locked ? <Lock aria-label={t("Encrypted")} className="size-3 shrink-0 text-muted" /> : null}
                        </span>
                      )}
                    </td>
                    <td className="border-b border-line px-3 text-right text-muted tabular-nums">
                      {node.folder ? t("{count} item | {count} items", { count: tree.get(node.path)?.length ?? 0 }) : formatSize(node.size)}
                    </td>
                    <td className="border-b border-line px-3 text-muted tabular-nums">{node.mtime === null ? "" : formatDate(node.mtime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {children.length === 0 ? <KagoEmptyState title={t("This folder is empty")} /> : null}
          </div>
          <KagoStatusBar>
            <span className="mr-auto truncate tabular-nums">
              {t("{count} file, {size} uncompressed | {count} files, {size} uncompressed", { count: files.length, size: formatSize(files.reduce((sum, entry) => sum + entry.size, 0)) })}
            </span>
            {listing.data?.truncated ? <span className="truncate">{t("Only the first {count} entries are shown", { count: listing.data.entries.length })}</span> : null}
          </KagoStatusBar>
        </div>
      )}
    </PreviewWindowFrame>
  );
}
