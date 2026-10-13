import { useState } from "react";
import { History } from "lucide-react";
import { useConvertRuns } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { taskErrorLabel, taskStatus } from "@/features/tasks/taskUtils";
import { formatDuration, formatSize, formatUnixDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { ConvertJob, ConvertRun, FileTask } from "@/types/kago";

/** What there is to say of a run beyond when it was and how it ended. */
function describeRun(run: ConvertRun) {
  return [
    run.scheduled ? t("Started by watching the folder") : t("Started by hand"),
    run.finished_at ? t("Took {duration}", { duration: formatDuration(run.finished_at - run.started_at) }) : null,
    run.bytes > 0 ? t("{size} processed", { size: formatSize(run.bytes) }) : null
  ].filter(Boolean).join(" · ");
}

/** How many files a run dealt with, by what became of them. Nothing while it has yet to say. */
function describeFiles(run: ConvertRun) {
  const parts = [
    run.converted ? t("{count} converted", { count: run.converted }) : null,
    run.copied ? t("{count} copied as is", { count: run.copied }) : null,
    run.failed ? t("{count} failed", { count: run.failed }) : null
  ].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  return run.status === "done" ? t("No files were waiting") : null;
}

/** The auto-convert's last runs: when each was, how it ended, and what it did. */
export function ConvertRunsDialog({ job, onClose }: { job: ConvertJob | null; onClose: () => void }) {
  // The last job stays on show while its dialog fades out, and so do its runs.
  const [shown, setShown] = useState(job);
  if (job && job !== shown) setShown(job);
  const runs = useConvertRuns(shown, job !== null);
  return (
    <KagoDialog open={job !== null} onClose={onClose} title={t("Runs of {name}", { name: shown?.name ?? "" })} className="w-[min(560px,calc(100vw-32px))]">
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pt-3">
        {runs.isLoading ? <KagoLoading /> : null}
        {runs.isError ? <p className="m-0 text-danger">{t("Couldn’t load the runs")}</p> : null}
        {runs.data?.length === 0 ? <KagoEmptyState icon={<History />} title={t("No runs yet")} description={t("Each run of this auto-convert is listed here once it has started.")} /> : null}
        {runs.data?.length ? (
          <ul className="kago-well m-0 list-none divide-y divide-line rounded-md p-0">
            {runs.data.map((run) => {
              const status = taskStatus({ status: run.status } as FileTask);
              const files = describeFiles(run);
              return (
                <li key={run.task_id} className="flex items-start gap-3 px-3 py-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium tabular-nums">{formatUnixDate(run.started_at)}</span>
                    <span className="text-xs text-muted">{describeRun(run)}</span>
                    {files ? <span className="text-xs text-muted">{files}</span> : null}
                    {run.error_message ? <span className="text-xs break-words text-danger">{taskErrorLabel(run.error_message)}</span> : null}
                  </div>
                  <KagoBadge tone={status.tone}>{status.label}</KagoBadge>
                </li>
              );
            })}
          </ul>
        ) : null}
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-faint">{t("The last {count} runs are kept.", { count: 20 })}</span>
          <Button onClick={onClose}>{t("Close")}</Button>
        </div>
      </div>
    </KagoDialog>
  );
}
