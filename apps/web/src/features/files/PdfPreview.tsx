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
        <KagoIconButton label="下載" className="size-6" onClick={download}>
          <Download />
        </KagoIconButton>
      }
    >
      {unreadable ? (
        <KagoEmptyState className="min-h-0 flex-1" icon={<FileWarning />} title="無法預覽這個檔案" description="檔案可能已損毀，或有密碼保護。">
          <Button onClick={download}>下載</Button>
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
            第 {state.page} / {state.pages} 頁
          </span>
          <span className="px-1 tabular-nums">{Math.round(state.scale * 100)}%</span>
          <KagoIconButton label="縮小" className="size-6" onClick={() => view.current?.zoomOut()}>
            <ZoomOut />
          </KagoIconButton>
          <KagoIconButton label="放大" className="size-6" onClick={() => view.current?.zoomIn()}>
            <ZoomIn />
          </KagoIconButton>
          <KagoIconButton label="符合視窗寬度" className="size-6" active={state.fitted} onClick={() => view.current?.fit()}>
            <MoveHorizontal />
          </KagoIconButton>
        </footer>
      ) : null}
    </KagoWindow>
  );
}
