import { CircleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatDuration, formatSize } from "@/lib/format";
import { useToastStore } from "@/stores/toast";
import { useUploadStore, type Upload } from "@/stores/uploads";
import { t } from "@/lib/i18n";

/** The shape of a notification that counts: a card with a bar in it, where one that only says something is a pill. */
const card = "flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-1.5 rounded-lg py-2 pr-1.5 pl-3";

export function KagoToaster() {
  const { toasts, dismiss, hold, release } = useToastStore();
  const uploads = useUploadStore((state) => state.uploads);
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[1000] flex w-max max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {uploads.map((upload) => <UploadCard key={upload.id} upload={upload} />)}
      {toasts.map((toast) => (
        // One element whichever shape it has, so a count that turns into its outcome changes where it is and does not arrive again.
        <div
          key={toast.id}
          data-leaving={toast.leaving ? "" : undefined}
          className={cn("kago-toast pointer-events-auto kago-glass", toast.progress ? card : "flex max-w-full items-center gap-2 rounded-md py-1.5 pr-1.5 pl-3 sm:max-w-md", toast.kind === "error" && "text-danger")}
          // A count changes too often to be read out each time; what it ends as is.
          aria-live={toast.progress ? "off" : undefined}
          // Still being read: it does not go while the pointer is on it.
          onPointerEnter={() => hold(toast.id)}
          onPointerLeave={() => release(toast.id)}
        >
          {toast.progress ? (
            <Count title={toast.message} speed={toast.progress.speed} value={toast.progress.value} max={toast.progress.max} details={toast.progress.detail} close={<Close label={t("Dismiss notification")} onClick={() => dismiss(toast.id)} />} />
          ) : (
            <>
              {toast.kind === "error" ? <CircleAlert /> : null}
              <span className="min-w-0 wrap-anywhere">{toast.message}</span>
              <Close label={t("Dismiss notification")} onClick={() => dismiss(toast.id)} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function Close({ label, hint, onClick }: { label: string; hint?: string; onClick: () => void }) {
  return (
    <button className="shrink-0 rounded-sm p-1 text-muted outline-none kago-flat focus-visible:ring-2 focus-visible:ring-accent/50" aria-label={label} title={hint} onClick={onClick}>
      <X className="size-3.5" />
    </button>
  );
}

/**
 * What a card that counts holds: what is being done, a bar, and under it the figures, ending in how far along it is where the bar ends.
 * How fast it goes sits across from its name, where there is room for it whatever the figures run to.
 */
function Count({ title, speed, value, max, details, close }: { title: string; speed?: string; value: number; max: number; details: string; close: React.ReactNode }) {
  return (
    <>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {speed ? <span className="shrink-0 text-xs text-muted tabular-nums">{speed}</span> : null}
        {close}
      </div>
      <progress className="mr-1.5 w-auto" value={value} max={Math.max(max, 1)} />
      <div className="mr-1.5 flex items-baseline gap-2 text-xs text-muted tabular-nums">
        <span className="min-w-0 flex-1 truncate">{details}</span>
        <span className="shrink-0">{max > 0 ? Math.min(100, Math.floor((value / max) * 100)) : 0}%</span>
      </div>
    </>
  );
}

/** Stays up for as long as the upload runs; the request has no server task to follow instead. */
function UploadCard({ upload }: { upload: Upload }) {
  const sent = upload.total > 0 && upload.loaded >= upload.total;
  const details = sent
    ? t("Processing…")
    : [
        `${formatSize(upload.loaded)} / ${formatSize(upload.total)}`,
        upload.speed > 0 ? `${formatSize(upload.speed)}/s` : null,
        upload.speed > 0 ? t("{duration} left", { duration: formatDuration((upload.total - upload.loaded) / upload.speed) }) : null
      ].filter(Boolean).join(" · ");
  return (
    <div className={cn("kago-toast pointer-events-auto kago-glass", card)} aria-live="off">
      <Count title={t("Uploading {name}", { name: upload.label })} value={upload.loaded} max={upload.total} details={details} close={<Close label={t("Cancel upload")} hint={t("Cancel upload")} onClick={upload.cancel} />} />
    </div>
  );
}
