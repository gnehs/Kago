import { Download, FileQuestion } from "lucide-react";
import { downloadUrl } from "@/api/client";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { formatSize, hasTextName, isCueSheet, isMusicFile, isSplatFile, isSqliteFile, isTextFile, isVideoType, kindLabel, MAX_TEXT_BYTES, officeKind } from "@/lib/format";
import { triggerDownload } from "@/lib/paths";
import type { PreviewWindow } from "@/stores/workspace";
import { AudioPreviewWindow } from "./AudioPreview";
import { FileIcon } from "./FileIcon";
import { ImagePreviewWindow, isViewableImage } from "./ImagePreview";
import { OfficePreviewWindow } from "./OfficePreview";
import { PdfPreviewWindow } from "./PdfPreview";
import { SplatPreviewWindow } from "./SplatPreview";
import { SqlitePreviewWindow } from "./SqlitePreview";
import { TextPreviewWindow } from "./TextPreview";
import { VideoPreviewWindow } from "./VideoPreview";
import { t } from "@/lib/i18n";

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
  if (isSplatFile(item)) return <SplatPreviewWindow window={window} />;
  if (isMusicFile(item) || isCueSheet(item)) return <AudioPreviewWindow window={window} />;
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
      <div className="flex min-h-0 flex-1 items-center justify-center bg-elevated">
        <KagoEmptyState
          icon={<FileQuestion />}
          title={t("This kind of file can’t be previewed")}
          description={hasTextName(item.name) || item.type.startsWith("text/") ? t("Text files over {size} have to be downloaded to open.", { size: formatSize(MAX_TEXT_BYTES) }) : t("There is no viewer for this kind of file ({kind}). Download it and open it in another app.", { kind: kindLabel(item) })}
        >
          <Button onClick={download}>{t("Download")}</Button>
        </KagoEmptyState>
      </div>
    </KagoWindow>
  );
}
