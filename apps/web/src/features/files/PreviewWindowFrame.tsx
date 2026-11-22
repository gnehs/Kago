import { Download } from "lucide-react";
import { useState, type ReactNode } from "react";
import { downloadUrl } from "@/api/client";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { FileIcon } from "@/components/kago/file-icon";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoWindow } from "@/components/kago/window";
import { Button } from "@/components/ui/button";
import { t } from "@/lib/i18n";
import { triggerDownload } from "@/lib/paths";
import type { PreviewWindow } from "@/stores/workspace";

/** A file as it is now: the same file written again is another version of it. */
export const previewVersion = (item: { path: string; mtime: number }) => `${item.path}:${item.mtime}`;

export const downloadPreview = ({ rootSlug, item }: PreviewWindow["preview"]) => triggerDownload(downloadUrl(rootSlug, item.path));

/**
 * The file a preview window shows. The window stays open when the file is opened again as it is now; `onReset`
 * is where a preview lets go of what it was told about the last version. A preview that has to keep its state
 * across versions, as an editor that has just saved does, leaves it out.
 */
export function usePreviewFile(window: PreviewWindow, onReset?: () => void) {
  const { rootSlug, item } = window.preview;
  const version = previewVersion(item);
  const [shown, setShown] = useState(version);
  if (shown !== version) {
    setShown(version);
    onReset?.();
  }
  return { rootSlug, item, version, download: () => downloadPreview(window.preview) };
}

/** A preview's window: the file's icon and a download button in the title bar, after whatever else the preview puts there. */
export function PreviewWindowFrame({ window, extra, keepMounted, children }: { window: PreviewWindow; extra?: ReactNode; keepMounted?: boolean; children: ReactNode }) {
  return (
    <KagoWindow
      window={window}
      icon={<FileIcon item={window.preview.item} />}
      keepMounted={keepMounted}
      titleExtra={
        <>
          {extra}
          <KagoIconButton label={t("Download")} className="size-6" onClick={() => downloadPreview(window.preview)}>
            <Download />
          </KagoIconButton>
        </>
      }
    >
      {children}
    </KagoWindow>
  );
}

/** What a preview says when it cannot show the file, with the way to open it elsewhere. */
export function PreviewFailure({ icon, title, description, className, onDownload }: { icon: ReactNode; title: string; description: string; className?: string; onDownload: () => void }) {
  return (
    <KagoEmptyState className={className} icon={icon} title={title} description={description}>
      <Button variant="default" onClick={onDownload}>{t("Download")}</Button>
    </KagoEmptyState>
  );
}
