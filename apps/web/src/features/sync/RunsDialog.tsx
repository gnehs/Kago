import { useState } from "react";
import { History } from "lucide-react";
import { useSyncRuns } from "@/api/hooks";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoFailureHelp } from "@/components/kago/run-failure";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { Button } from "@/components/ui/button";
import { statusGlyph } from "@/features/tasks/statusGlyph";
import { taskErrorLabel, taskStatus } from "@/features/tasks/taskUtils";
import { formatDuration, formatSize, formatUnixDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { runSeconds } from "@/lib/runModel";
import { failureTextOf } from "@/lib/runText";
import type { SyncJob, SyncRun, SyncTrialSummary } from "@/types/kago";
import { describeTrial } from "./TrialDialog";

/** Where a run came from and what it moved, under its headline. */
function describeRun(run: SyncRun) {
  return [
    formatUnixDate(run.started_at),
    run.scheduled ? t("On schedule") : t("Started by hand"),
    // What a run changed says how much it copied; of one that left no such count, only what it sent is known, if that.
    !run.summary && !run.dry_run && run.bytes > 0 ? t("{size} transferred", { size: formatSize(run.bytes) }) : null
  ].filter(Boolean).join(" · ");
}

/** How much a run that was not a trial changed, in a few words. */
function describeChanges(summary: SyncTrialSummary) {
  const parts = [
    summary.copy ? t("{count} copied ({size})", { count: summary.copy, size: formatSize(summary.bytes) }) : null,
    summary.touch ? t("{count} re-dated", { count: summary.touch }) : null,
    summary.delete ? t("{count} deleted", { count: summary.delete }) : null,
    summary.mkdir ? t("{count} folder made | {count} folders made", { count: summary.mkdir }) : null,
    summary.rmdir ? t("{count} folder removed | {count} folders removed", { count: summary.rmdir }) : null
  ].filter(Boolean);
  // A sync between two locations does not say what folders it made or which times it set.
  return parts.length > 0 ? parts.join(" · ") : t("Nothing was copied or deleted");
}

/** What a run did, as its headline: why, for one that failed with a reason; what it changed; or where it left no count, how it ended. */
function headlineOf(run: SyncRun) {
  if (run.error_code) return failureTextOf(run.error_code).reason;
  if (run.summary) return run.dry_run ? describeTrial(run.summary) : describeChanges(run.summary);
  return taskStatus({ status: run.status }).label;
}

/** The job's last runs: what each did and how long it took, and under that when it was and what started it. */
export function RunsDialog({ job, onClose }: { job: SyncJob | null; onClose: () => void }) {
  // The last job stays on show while its dialog fades out, and so do its runs.
  const [shown, setShown] = useState(job);
  if (job && job !== shown) setShown(job);
  const runs = useSyncRuns(shown, job !== null);
  return (
    <KagoDialog open={job !== null} onClose={onClose} title={t("Runs of {name}", { name: shown?.name ?? "" })} className="w-[min(560px,calc(100%-32px))]">
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pt-3">
        {runs.isLoading ? <KagoLoading /> : null}
        {runs.isError ? <p className="m-0 text-danger">{t("Couldn’t load the runs")}</p> : null}
        {runs.data?.length === 0 ? <KagoEmptyState icon={<History />} title={t("No runs yet")} description={t("Each run of this sync is listed here once it has started.")} /> : null}
        {runs.data?.length ? (
          <ul className="kago-well m-0 list-none divide-y divide-line rounded-md p-0">
            {runs.data.map((run) => {
              const status = taskStatus({ status: run.status });
              const seconds = runSeconds(run);
              return (
                <li key={run.task_id} className="flex items-start gap-3 px-3 py-2">
                  <KagoStatusIcon tone={status.tone} label={status.label}>{statusGlyph(run.status)}</KagoStatusIcon>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium">
                      <span className={run.error_code ? "text-danger" : undefined}>{headlineOf(run)}</span>
                      {seconds !== null ? <span className="font-normal text-muted"> · {formatDuration(seconds)}</span> : null}
                    </span>
                    <span className="text-xs text-muted tabular-nums">{describeRun(run)}</span>
                    {run.error_code ? <KagoFailureHelp code={run.error_code} detail={run.error_detail} /> : run.error_message ? <span className="text-xs break-words text-danger">{taskErrorLabel(run.error_message)}</span> : null}
                  </div>
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
