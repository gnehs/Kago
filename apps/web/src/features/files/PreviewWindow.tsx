import { Download, FileQuestion } from "lucide-react";
import { downloadUrl, previewUrl } from "@/api/client";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { formatSize, hasTextName, isAudioType, isSqliteFile, isTextFile, isVideoType, kindLabel, MAX_TEXT_BYTES, officeKind } from "@/lib/format";
import { triggerDownload } from "@/lib/paths";
import type { PreviewWindow } from "@/stores/workspace";
import { FileIcon } from "./FileIcon";
import { ImagePreviewWindow, isViewableImage } from "./ImagePreview";
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
  if (isViewableImage(item)) return <ImagePreviewWindow window={window} />;
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
        {isAudioType(item.type) ? (
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
