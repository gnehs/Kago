import { Download } from "lucide-react";
import { downloadUrl, previewUrl } from "@/api/client";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { isVideoType } from "@/lib/format";
import { triggerDownload } from "@/lib/paths";
import type { PreviewWindow } from "@/stores/workspace";
import { FileIcon } from "./FileIcon";
import { VideoPreviewWindow } from "./VideoPreview";

/** A file opened for viewing, in the same movable, resizable window chrome as a folder. */
export function PreviewWindowView({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  if (isVideoType(item.type)) return <VideoPreviewWindow window={window} />;
  const source = previewUrl(rootSlug, item.path);
  return (
    <KagoWindow
      window={window}
      icon={<FileIcon item={item} />}
      titleExtra={<KagoIconButton label="下載" className="size-6" onClick={() => triggerDownload(downloadUrl(rootSlug, item.path))}><Download /></KagoIconButton>}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center bg-elevated">
        {item.type.startsWith("image/") ? (
          <img alt={item.name} src={source} draggable={false} className="max-h-full max-w-full object-contain" />
        ) : item.type.startsWith("audio/") ? (
          <audio src={source} controls />
        ) : (
          <iframe title={item.name} src={source} className="size-full border-0 bg-surface" />
        )}
      </div>
    </KagoWindow>
  );
}
