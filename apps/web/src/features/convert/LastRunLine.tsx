import { useConvertRunFiles, useConvertRuns } from "@/api/hooks";
import { KagoLineParts } from "@/components/kago/line-parts";
import { taskErrorLabel, taskStatus } from "@/features/tasks/taskUtils";
import { formatUnixDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { failureGroups, lastRunTrouble } from "@/lib/runModel";
import { failureTextOf, troubleText } from "@/lib/runText";
import type { ConvertJob, ConvertRun } from "@/types/kago";

/** How many files are failing, and why when the run that failed them says it was one reason. */
function FailedFiles({ jobId, run, count }: { jobId: string; run: ConvertRun | undefined; count: number }) {
  return run && run.failed > 0 ? <FailedFilesOf jobId={jobId} run={run} count={count} /> : <>{t("{count} file failed | {count} files failed", { count })}</>;
}

function FailedFilesOf({ jobId, run, count }: { jobId: string; run: ConvertRun; count: number }) {
  const files = useConvertRunFiles(jobId, run);
  const groups = failureGroups(files.data ?? []);
  // The count on the job is of the files left failing, which may be more than this run failed; a reason is told only where it covers them all.
  if (groups.length === 1 && groups[0]!.count === count) return <>{t("{count} file failed: {reason} | {count} files failed: {reason}", { count, reason: failureTextOf(groups[0]!.code).reason })}</>;
  if (groups.length > 1 && groups.reduce((sum, group) => sum + group.count, 0) === count) return <>{t("{count} file failed, for different reasons | {count} files failed, for different reasons", { count })}</>;
  return <>{t("{count} file failed | {count} files failed", { count })}</>;
}

/** How the job last went, in the line under its name: when it ran, that it failed and why, and how many of its files are failing, those in the danger colour. */
export function LastRunLine({ job, running }: { job: ConvertJob; running: boolean }) {
  const trouble = lastRunTrouble(job);
  const last = job.last_status ? taskStatus({ status: job.last_status }) : null;
  // Only a job with files failing needs its last run, to say why.
  const runs = useConvertRuns(job, job.failed > 0);
  // A run that ended with some of its files failing says only "some files couldn’t be converted" for itself; that is what the count says.
  const latest = runs.data?.[0];
  const partly = trouble === "failed" && latest !== undefined && latest.error_code === null && latest.failed > 0;
  const ended = !partly && (trouble === "failed" || trouble === "interrupted") ? troubleText(trouble, job.last_error ? taskErrorLabel(job.last_error) : null) : null;
  const parts = [
    running && last ? { text: last.label } : null,
    ended ? { text: ended, danger: true } : job.last_error && !partly ? { text: taskErrorLabel(job.last_error) } : job.last_run_at ? { text: t("Last run {date}", { date: formatUnixDate(job.last_run_at) }) } : null,
    job.failed > 0 ? { text: <FailedFiles jobId={job.id} run={runs.data?.find((run) => run.failed > 0)} count={job.failed} />, danger: true } : null
  ];
  return parts.some(Boolean) ? <KagoLineParts parts={parts} /> : <>{t("No runs yet")}</>;
}
