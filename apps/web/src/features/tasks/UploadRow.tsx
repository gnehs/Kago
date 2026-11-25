import { Laptop } from "lucide-react";
import { formatDuration, formatSize, formatWholeSize } from "@/lib/format";
import type { Upload } from "@/stores/uploads";
import { ProgressCard } from "./TaskRow";
import { t } from "@/lib/i18n";

/** An upload from this tab, laid out as a running task is: it has no server task to follow until the files have all gone. Only this page carries it, so the card says to keep it open. */
export function UploadRow({ upload }: { upload: Upload }) {
  const sent = upload.total > 0 && upload.loaded >= upload.total;
  const remaining = !sent && upload.speed > 0 ? t("{duration} left", { duration: formatDuration((upload.total - upload.loaded) / upload.speed) }) : null;

  return (
    <ProgressCard
      title={<strong className="min-w-0 flex-1 truncate font-medium">{t("Uploading {name}", { name: upload.label })}</strong>}
      value={upload.loaded}
      max={Math.max(upload.total, 1)}
      left={
        <span className="flex items-start gap-1.5 whitespace-normal">
          <Laptop className="mt-px size-3.5 shrink-0" />
          {t("This computer is uploading it. Keep this page open until it finishes.")}
        </span>
      }
      right={sent ? t("Processing…") : remaining}
      cancel={{ label: t("Cancel upload"), onClick: upload.cancel }}
      detail={
        <>
          <div>{`${formatWholeSize(upload.loaded)} / ${formatWholeSize(upload.total)}`}</div>
          {upload.files > 1 ? <div>{t("{done} of {count} file | {done} of {count} files", { done: upload.done, count: upload.files })}</div> : null}
          {upload.speed > 0 && !sent ? <div>{formatSize(upload.speed)}/s</div> : null}
        </>
      }
    />
  );
}
