import { Download, FileWarning, Move3d, Rotate3d, RotateCcw, Scan } from "lucide-react";
import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { downloadUrl, previewUrl } from "@/api/client";
import { KagoEmptyState, KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/components/kago/window";
import { triggerDownload } from "@/lib/paths";
import type { PreviewWindow } from "@/stores/workspace";
import { FileIcon } from "./FileIcon";
import type { SplatError, SplatViewHandle, SplatViewState } from "./SplatView";
import { t } from "@/lib/i18n";

// The 3D engine is only downloaded by someone who opens a splat.
const SplatView = lazy(() => import("./SplatView"));

/** How the camera is moved, said once in the status bar instead of in a panel over the scene. */
const hint = (state: SplatViewState) => {
  if (!state.loaded) return t("Loading… {percent}%", { percent: state.progress });
  if (state.touch) return state.mode === "orbit" ? t("Drag to orbit, pinch to zoom") : "";
  return state.mode === "orbit" ? t("Drag to orbit, right-drag to pan, scroll to zoom") : state.mode === "fly" ? t("W A S D to move, drag to look around") : "";
};

/** A 3D Gaussian splat scene, drawn in the browser: orbit around it or fly through it. */
export function SplatPreviewWindow({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  const view = useRef<SplatViewHandle>(null);
  const [state, setState] = useState<SplatViewState>({ loaded: false, progress: 0, mode: null, touch: false });
  const [error, setError] = useState<SplatError | null>(null);
  const onState = useCallback((patch: Partial<SplatViewState>) => setState((previous) => ({ ...previous, ...patch })), []);
  const onError = useCallback((next: SplatError) => setError(next), []);
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
      {error ? (
        <KagoEmptyState
          className="min-h-0 flex-1"
          icon={<FileWarning />}
          title={t("Couldn’t preview this file")}
          description={error === "not-splat" ? t("This PLY file isn’t a Gaussian splat. Download it and open it in another app.") : t("The file may be damaged, or in an unsupported format.")}
        >
          <Button variant="default" onClick={download}>{t("Download")}</Button>
        </KagoEmptyState>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col bg-black">
          <Suspense fallback={<KagoLoading />}>
            {/* Keyed by the file as it is now, so one that is replaced on disk is read again. */}
            <SplatView key={`${item.path}:${item.mtime}`} ref={view} url={previewUrl(rootSlug, item.path)} name={item.name} focused={window.focused} onState={onState} onError={onError} />
          </Suspense>
          {state.loaded ? null : (
            <div className="kago-wait pointer-events-none absolute inset-0 flex items-center justify-center">
              <KagoSpinner className="size-5 text-white/70" />
            </div>
          )}
        </div>
      )}
      {error ? null : (
        <footer className="flex h-7 shrink-0 items-center gap-1 border-t border-line bg-elevated px-3 text-muted">
          <span className="mr-auto truncate tabular-nums">{hint(state)}</span>
          <KagoIconButton label={t("Orbit (1)")} className="size-6" disabled={!state.loaded} active={state.mode === "orbit"} onClick={() => view.current?.setMode("orbit")}>
            <Rotate3d />
          </KagoIconButton>
          {/* Flying is steered from the keyboard, which a touch screen does not have. */}
          {state.touch ? null : (
            <KagoIconButton label={t("Fly (2)")} className="size-6" disabled={!state.loaded} active={state.mode === "fly"} onClick={() => view.current?.setMode("fly")}>
              <Move3d />
            </KagoIconButton>
          )}
          <KagoIconButton label={t("Frame scene (F)")} className="size-6" disabled={!state.loaded} onClick={() => view.current?.frame()}>
            <Scan />
          </KagoIconButton>
          <KagoIconButton label={t("Reset camera (R)")} className="-mr-1.5 size-6" disabled={!state.loaded} onClick={() => view.current?.reset()}>
            <RotateCcw />
          </KagoIconButton>
        </footer>
      )}
    </KagoWindow>
  );
}
