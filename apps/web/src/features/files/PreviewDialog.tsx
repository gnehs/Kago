import { Download, X } from "lucide-react";
import { downloadUrl, previewUrl } from "@/api/client";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoIconButton } from "@/components/kago/icon-button";
import { triggerDownload } from "@/lib/paths";
import type { FileItem } from "@/types/kago";

export function PreviewDialog({ rootSlug, item, onClose }: { rootSlug: string; item: FileItem; onClose: () => void }) {
  const source = previewUrl(rootSlug, item.path);
  return (
    <KagoDialog
      open
      onClose={onClose}
      className="h-[min(720px,calc(100vh-48px))] w-[min(960px,calc(100vw-48px))] overflow-hidden"
      title={
        <span className="-mt-1.5 flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate">{item.name}</span>
          <KagoIconButton label="下載" onClick={() => triggerDownload(downloadUrl(rootSlug, item.path))}><Download /></KagoIconButton>
          <KagoIconButton label="關閉預覽" onClick={onClose}><X /></KagoIconButton>
        </span>
      }
    >
      <div className="mt-2 flex min-h-0 flex-1 items-center justify-center border-t border-line bg-elevated">
        {item.type.startsWith("image/") ? (
          <img alt={item.name} src={source} className="max-h-full max-w-full object-contain" />
        ) : item.type.startsWith("video/") ? (
          <video src={source} controls className="max-h-full max-w-full" />
        ) : item.type.startsWith("audio/") ? (
          <audio src={source} controls />
        ) : (
          <iframe title={item.name} src={source} className="size-full border-0 bg-surface" />
        )}
      </div>
    </KagoDialog>
  );
}
