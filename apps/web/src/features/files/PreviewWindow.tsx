import { FileQuestion } from "lucide-react";
import { usePluginPreviewers } from "@/api/hooks";
import { KagoLoading } from "@/components/kago/empty-state";
import { formatSize, hasTextName, isCueSheet, isMusicFile, isSqliteFile, isTextFile, isVideoType, kindLabel, MAX_TEXT_BYTES, officeKind } from "@/lib/format";
import { extensionOf, isArchive } from "@/lib/fileKind";
import type { PreviewWindow } from "@/stores/workspace";
import { ArchivePreviewWindow } from "./ArchivePreview";
import { AudioPreviewWindow } from "./AudioPreview";
import { ImagePreviewWindow, isViewableImage } from "./ImagePreview";
import { OfficePreviewWindow } from "./OfficePreview";
import { PdfPreviewWindow } from "./PdfPreview";
import { downloadPreview, PreviewFailure, PreviewWindowFrame } from "./PreviewWindowFrame";
import { SqlitePreviewWindow } from "./SqlitePreview";
import { TextPreviewWindow } from "./TextPreview";
import { VideoPreviewWindow } from "./VideoPreview";
import { PluginPreviewWindow } from "@/features/plugins/PluginPreviewWindow";
import { t } from "@/lib/i18n";

/**
 * A file opened for viewing, in the same movable, resizable window chrome as a folder.
 * Only kinds with a viewer of their own get one: a file the browser is merely pointed at is downloaded
 * when the browser cannot show it, which is not what opening a preview should do. A kind none of the interface's
 * own viewers takes may still have a plugin's.
 */
export function PreviewWindowView({ window }: { window: PreviewWindow }) {
  const { item } = window.preview;
  const plugins = usePluginPreviewers();
  if (isTextFile(item)) return <TextPreviewWindow window={window} />;
  if (isVideoType(item.type)) return <VideoPreviewWindow window={window} />;
  if (isSqliteFile(item)) return <SqlitePreviewWindow window={window} />;
  if (isArchive(item)) return <ArchivePreviewWindow window={window} />;
  if (item.type === "application/pdf") return <PdfPreviewWindow window={window} />;
  const office = officeKind(item);
  if (office) return <OfficePreviewWindow window={window} kind={office} />;
  if (isViewableImage(item)) return <ImagePreviewWindow window={window} />;
  if (isMusicFile(item) || isCueSheet(item)) return <AudioPreviewWindow window={window} />;
  const plugin = item.kind === "file" ? plugins.data?.get(extensionOf(item.name)) : undefined;
  if (plugin) return <PluginPreviewWindow window={window} previewer={plugin} />;
  return (
    <PreviewWindowFrame window={window}>
      <div className="flex min-h-0 flex-1 items-center justify-center bg-elevated">
        {/* Whether a plugin opens it is not known until the plugins are. */}
        {plugins.isPending ? (
          <KagoLoading />
        ) : (
          <PreviewFailure
            icon={<FileQuestion />}
            title={t("This kind of file can’t be previewed")}
            description={hasTextName(item.name) || item.type.startsWith("text/") ? t("Text files over {size} have to be downloaded to open.", { size: formatSize(MAX_TEXT_BYTES) }) : t("There is no viewer for this kind of file ({kind}). Download it and open it in another app.", { kind: kindLabel(item) })}
            onDownload={() => downloadPreview(window.preview)}
          />
        )}
      </div>
    </PreviewWindowFrame>
  );
}
