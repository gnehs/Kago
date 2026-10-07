import { CircleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, formatSize } from "@/lib/format";
import { useToastStore } from "@/stores/toast";
import { useUploadStore, type Upload } from "@/stores/uploads";

export function KagoToaster() {
  const { toasts, dismiss } = useToastStore();
  const uploads = useUploadStore((state) => state.uploads);
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[1000] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {uploads.map((upload) => <UploadCard key={upload.id} upload={upload} />)}
      {toasts.map((toast) => (
        <div key={toast.id} className={cn("pointer-events-auto flex max-w-md items-center gap-2 kago-glass rounded-md py-1.5 pr-1.5 pl-3", toast.kind === "error" && "text-danger")}>
          {toast.kind === "error" ? <CircleAlert /> : null}
          <span>{toast.message}</span>
          <button className="rounded-sm p-1 text-muted kago-flat" aria-label="關閉通知" onClick={() => dismiss(toast.id)}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

/** Stays up for as long as the upload runs; the request has no server task to follow instead. */
function UploadCard({ upload }: { upload: Upload }) {
  const sent = upload.total > 0 && upload.loaded >= upload.total;
  const percent = upload.total > 0 ? Math.min(100, Math.floor((upload.loaded / upload.total) * 100)) : 0;
  const details = sent
    ? "處理中…"
    : [
        `${formatSize(upload.loaded)} / ${formatSize(upload.total)}`,
        upload.speed > 0 ? `${formatSize(upload.speed)}/s` : null,
        upload.speed > 0 ? `剩餘 ${formatDuration((upload.total - upload.loaded) / upload.speed)}` : null
      ].filter(Boolean).join(" · ");
  return (
    <div className="pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5 kago-glass rounded-lg py-2 pr-1.5 pl-3" aria-live="off">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">正在上傳 {upload.label}</span>
        <span className="text-xs text-muted tabular-nums">{percent}%</span>
        <button className="rounded-sm p-1 text-muted kago-flat" aria-label="取消上傳" title="取消上傳" onClick={upload.cancel}>
          <X className="size-3.5" />
        </button>
      </div>
      <progress className="mr-1.5 w-auto" value={upload.loaded} max={Math.max(upload.total, 1)} />
      <span className="truncate text-xs text-muted tabular-nums">{details}</span>
    </div>
  );
}
