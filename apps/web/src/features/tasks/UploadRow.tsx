import { Button } from "@/components/ui/button";
import { formatDuration, formatPercent, formatSize, formatWholeSize } from "@/lib/format";
import type { Upload } from "@/stores/uploads";
import { t } from "@/lib/i18n";

/** An upload from this tab, laid out as a task is: it has no server task to follow until the files have all gone. */
export function UploadRow({ upload }: { upload: Upload }) {
  const sent = upload.total > 0 && upload.loaded >= upload.total;
  const detail = sent
    ? t("Processing…")
    : [
        `${formatWholeSize(upload.loaded)} / ${formatWholeSize(upload.total)}`,
        upload.speed > 0 ? t("{duration} left", { duration: formatDuration((upload.total - upload.loaded) / upload.speed) }) : null
      ].filter(Boolean).join(" · ");
  const [percent, tenth] = formatPercent(upload.loaded, upload.total).split(".");

  return (
    <div className="kago-card flex shrink-0 overflow-hidden rounded-md border border-line text-accent">
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2.5 text-ink">
        <div className="flex items-baseline gap-2">
          <strong className="min-w-0 flex-1 truncate font-medium">{t("Uploading {name}", { name: upload.label })}</strong>
          {upload.speed > 0 && !sent ? <span className="shrink-0 text-xs text-muted tabular-nums">{formatSize(upload.speed)}/s</span> : null}
        </div>
        <progress value={upload.loaded} max={Math.max(upload.total, 1)} />
        <span className="truncate text-xs text-muted tabular-nums">{detail}</span>
        <div className="flex gap-1.5">
          <Button onClick={upload.cancel}>{t("Cancel upload")}</Button>
        </div>
      </div>
      <div aria-hidden className="kago-cap flex w-14 shrink-0 items-center justify-center">
        <span className="flex items-baseline font-semibold tabular-nums">
          <span className="text-lg leading-none">{percent}</span>
          <span className="ml-px text-[10px]">{tenth ? `.${tenth}` : ""}%</span>
        </span>
      </div>
    </div>
  );
}
