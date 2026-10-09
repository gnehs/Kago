import { useState } from "react";
import { History } from "lucide-react";
import { useSyncRuns } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { taskErrorLabel, taskStatus } from "@/features/tasks/taskUtils";
import { formatDuration, formatSize, formatUnixDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import type { FileTask, SyncJob, SyncRun } from "@/types/kago";
import { describeTrial } from "./TrialDialog";

/** What there is to say of a run beyond when it was and how it ended. */
function describeRun(run: SyncRun) {
  return [
    run.scheduled ? t("On schedule") : t("Started by hand"),
    run.finished_at ? t("Took {duration}", { duration: formatDuration(run.finished_at - run.started_at) }) : null,
    // rsync does not always say how much it sent, so nothing is said of a run that reports none.
    !run.dry_run && run.bytes > 0 ? t("{size} transferred", { size: formatSize(run.bytes) }) : null
  ].filter(Boolean).join(" · ");
}

/** The job's last runs: when each was, how it ended, and what it brought across. */
export function RunsDialog({ job, onClose }: { job: SyncJob | null; onClose: () => void }) {
  // The last job stays on show while its dialog fades out, and so do its runs.
  const [shown, setShown] = useState(job);
  if (job && job !== shown) setShown(job);
  const runs = useSyncRuns(shown, job !== null);
  return (
    <KagoDialog open={job !== null} onClose={onClose} title={t("Runs of {name}", { name: shown?.name ?? "" })} className="w-[min(560px,calc(100vw-32px))]">
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pt-3">
        {runs.isLoading ? <KagoLoading /> : null}
        {runs.isError ? <p className="m-0 text-danger">{t("Couldn’t load the runs")}</p> : null}
        {runs.data?.length === 0 ? <KagoEmptyState icon={<History />} title={t("No runs yet")} description={t("Each run of this sync is listed here once it has started.")} /> : null}
        {runs.data?.length ? (
          <ul className="kago-well m-0 list-none divide-y divide-line rounded-md p-0">
            {runs.data.map((run) => {
              const status = taskStatus({ status: run.status } as FileTask);
              return (
                <li key={run.task_id} className="flex items-start gap-3 px-3 py-2">
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium tabular-nums">{formatUnixDate(run.started_at)}</span>
                    <span className="text-xs text-muted">{describeRun(run)}</span>
                    {run.summary ? <span className="text-xs text-muted">{describeTrial(run.summary)}</span> : null}
                    {run.error_message ? <span className="text-xs break-words text-danger">{taskErrorLabel(run.error_message)}</span> : null}
                  </div>
                  {run.dry_run ? <KagoBadge tone="neutral">{t("Trial run")}</KagoBadge> : null}
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
