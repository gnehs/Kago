import { Download, FileWarning, MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { downloadUrl, previewUrl } from "@/api/client";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { triggerDownload } from "@/lib/paths";
import type { PreviewWindow } from "@/stores/workspace";
import { FileIcon } from "./FileIcon";
import type { PdfViewHandle, PdfViewState } from "./PdfView";
import { t } from "@/lib/i18n";

// pdf.js is only downloaded by someone who opens a PDF.
const PdfView = lazy(() => import("./PdfView"));

/** A PDF drawn by pdf.js rather than by whatever the browser has, so it reads the same on a phone as on a desktop. */
export function PdfPreviewWindow({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  const view = useRef<PdfViewHandle>(null);
  const [state, setState] = useState<PdfViewState>({ page: 0, pages: 0, scale: 1, fitted: true });
  const [unreadable, setUnreadable] = useState(false);
  const onState = useCallback((patch: Partial<PdfViewState>) => setState((previous) => ({ ...previous, ...patch })), []);
  const onError = useCallback(() => setUnreadable(true), []);
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
      {unreadable ? (
        <KagoEmptyState className="min-h-0 flex-1" icon={<FileWarning />} title={t("Couldn’t preview this file")} description={t("The file may be damaged or password-protected.")}>
          <Button onClick={download}>{t("Download")}</Button>
        </KagoEmptyState>
      ) : (
        <Suspense fallback={<KagoLoading />}>
          {/* Keyed by the file as it is now, so one that is replaced on disk is read again. */}
          <PdfView key={`${item.path}:${item.mtime}`} ref={view} url={previewUrl(rootSlug, item.path)} onState={onState} onError={onError} />
        </Suspense>
      )}
      {state.pages > 0 && !unreadable ? (
        <footer className="flex h-7 shrink-0 items-center gap-1 border-t border-line bg-elevated px-3 text-muted">
          <span className="mr-auto tabular-nums">
            {t("Page {page} of {pages}", { page: state.page, pages: state.pages })}
          </span>
          <span className="px-1 tabular-nums">{Math.round(state.scale * 100)}%</span>
          <KagoIconButton label={t("Zoom out")} className="size-6" onClick={() => view.current?.zoomOut()}>
            <ZoomOut />
          </KagoIconButton>
          <KagoIconButton label={t("Zoom in")} className="size-6" onClick={() => view.current?.zoomIn()}>
            <ZoomIn />
          </KagoIconButton>
          <KagoIconButton label={t("Fit to width")} className="size-6" active={state.fitted} onClick={() => view.current?.fit()}>
            <MoveHorizontal />
          </KagoIconButton>
        </footer>
      ) : null}
    </KagoWindow>
  );
}
