import { FileWarning, MoveHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { previewUrl } from "@/api/client";
import { KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import type { PreviewWindow } from "@/stores/workspace";
import { KagoStatusBar } from "@/components/kago/status-bar";
import type { PdfViewHandle, PdfViewState } from "./PdfView";
import { PreviewFailure, PreviewWindowFrame, usePreviewFile } from "./PreviewWindowFrame";
import { t } from "@/lib/i18n";

// pdf.js is only downloaded by someone who opens a PDF.
const PdfView = lazy(() => import("./PdfView"));
const INITIAL_STATE: PdfViewState = { page: 0, pages: 0, scale: 1, fitted: true };

/** A PDF drawn by pdf.js rather than by whatever the browser has, so it reads the same on a phone as on a desktop. */
export function PdfPreviewWindow({ window }: { window: PreviewWindow }) {
  const view = useRef<PdfViewHandle>(null);
  const [state, setState] = useState<PdfViewState>(INITIAL_STATE);
  const [unreadable, setUnreadable] = useState(false);
  const { rootSlug, item, version, download } = usePreviewFile(window, () => {
    setState(INITIAL_STATE);
    setUnreadable(false);
  });
  const onState = useCallback((patch: Partial<PdfViewState>) => setState((previous) => ({ ...previous, ...patch })), []);
  const onError = useCallback(() => setUnreadable(true), []);

  return (
    <PreviewWindowFrame window={window}>
      {unreadable ? (
        <PreviewFailure className="min-h-0 flex-1" icon={<FileWarning />} title={t("Couldn’t preview this file")} description={t("The file may be damaged or password-protected.")} onDownload={download} />
      ) : (
        <Suspense fallback={<KagoLoading />}>
          {/* Keyed by the file as it is now, so one that is replaced on disk is read again. */}
          <PdfView key={version} ref={view} url={previewUrl(rootSlug, item.path)} onState={onState} onError={onError} />
        </Suspense>
      )}
      {state.pages > 0 && !unreadable ? (
        <KagoStatusBar>
          <span className="mr-auto tabular-nums">
            {t("Page {page} of {pages}", { page: state.page, pages: state.pages })}
          </span>
          <span className="px-1 tabular-nums">{Math.round(state.scale * 100)}%</span>
          <KagoIconButton label={t("Zoom out")} size="sm" onClick={() => view.current?.zoomOut()}>
            <ZoomOut />
          </KagoIconButton>
          <KagoIconButton label={t("Zoom in")} size="sm" onClick={() => view.current?.zoomIn()}>
            <ZoomIn />
          </KagoIconButton>
          <KagoIconButton label={t("Fit to width")} size="sm" active={state.fitted} onClick={() => view.current?.fit()}>
            <MoveHorizontal />
          </KagoIconButton>
        </KagoStatusBar>
      ) : null}
    </PreviewWindowFrame>
  );
}
