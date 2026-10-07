import { Download, FileQuestion, ImageOff } from "lucide-react";
import { useState } from "react";
import { downloadUrl, imageUrl, previewUrl } from "@/api/client";
import { KagoEmptyState, KagoSpinner } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { formatSize, hasTextName, isAudioType, isConvertedImage, isImageType, isSqliteFile, isTextFile, isVideoType, kindLabel, MAX_TEXT_BYTES, officeKind } from "@/lib/format";
import { triggerDownload } from "@/lib/paths";
import type { PreviewWindow } from "@/stores/workspace";
import { FileIcon } from "./FileIcon";
import { OfficePreviewWindow } from "./OfficePreview";
import { PdfPreviewWindow } from "./PdfPreview";
import { SqlitePreviewWindow } from "./SqlitePreview";
import { TextPreviewWindow } from "./TextPreview";
import { VideoPreviewWindow } from "./VideoPreview";

/**
 * A file opened for viewing, in the same movable, resizable window chrome as a folder.
 * Only kinds with a viewer of their own get one: a file the browser is merely pointed at is downloaded
 * when the browser cannot show it, which is not what opening a preview should do.
 */
export function PreviewWindowView({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  if (isTextFile(item)) return <TextPreviewWindow window={window} />;
  if (isVideoType(item.type)) return <VideoPreviewWindow window={window} />;
  if (isSqliteFile(item)) return <SqlitePreviewWindow window={window} />;
  if (item.type === "application/pdf") return <PdfPreviewWindow window={window} />;
  const office = officeKind(item);
  if (office) return <OfficePreviewWindow window={window} kind={office} />;
  const source = previewUrl(rootSlug, item.path);
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
      <div className="flex min-h-0 flex-1 items-center justify-center bg-elevated">
        {isImageType(item.type) ? (
          <img alt={item.name} src={source} draggable={false} className="max-h-full max-w-full object-contain" />
        ) : isConvertedImage(item) ? (
          // Keyed by the file as it is now: one replaced on disk is converted and shown again.
          <ConvertedImage key={`${item.path}:${item.mtime}`} name={item.name} source={`${imageUrl(rootSlug, item.path)}&v=${Math.round(item.mtime)}`} onDownload={download} />
        ) : isAudioType(item.type) ? (
          <audio src={source} controls />
        ) : (
          <KagoEmptyState
            icon={<FileQuestion />}
            title="無法預覽這種檔案"
            description={hasTextName(item.name) || item.type.startsWith("text/") ? `超過 ${formatSize(MAX_TEXT_BYTES)} 的文字檔請下載後開啟。` : `${kindLabel(item)}沒有對應的檢視器，請下載後用其他程式開啟。`}
          >
            <Button onClick={download}>下載</Button>
          </KagoEmptyState>
        )}
      </div>
    </KagoWindow>
  );
}

/** A picture the server converts on request: HEIF and camera RAW take a moment the first time they are opened. */
function ConvertedImage({ name, source, onDownload }: { name: string; source: string; onDownload: () => void }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  if (state === "failed") {
    return (
      <KagoEmptyState icon={<ImageOff />} title="無法顯示這張影像" description="伺服器無法轉換這個檔案，請下載後用其他程式開啟。">
        <Button onClick={onDownload}>下載</Button>
      </KagoEmptyState>
    );
  }
  return (
    <>
      {state === "loading" ? <KagoSpinner className="absolute size-5" /> : null}
      <img alt={name} src={source} draggable={false} className={state === "loaded" ? "max-h-full max-w-full object-contain" : "size-0 opacity-0"} onLoad={() => setState("loaded")} onError={() => setState("failed")} />
    </>
  );
}
