import { useState } from "react";
import { ChevronRight, History } from "lucide-react";
import { useConvertRunFiles, useConvertRuns } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { taskErrorLabel, taskStatus } from "@/features/tasks/taskUtils";
import { formatDuration, formatSize, formatUnixDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ConvertJob, ConvertRun, FileTask } from "@/types/kago";

/** How much smaller, or larger, something came out than it went in. */
function describeChange(before: number, after: number) {
  const percent = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  return percent > 0 ? t("{percent}% smaller", { percent }) : percent < 0 ? t("{percent}% larger", { percent: -percent }) : t("Same size");
}

/** The files of one run, each with what it measured before and after. */
function RunFiles({ jobId, run }: { jobId: string; run: ConvertRun }) {
  const files = useConvertRunFiles(jobId, run);
  if (files.isLoading) return <span className="text-xs text-muted">{t("Loading")}</span>;
  if (files.isError) return <span className="text-xs text-danger">{t("Couldn’t load the files")}</span>;
  // A run from before its files were written down has only its counts.
  if (files.data?.length === 0) return <span className="text-xs text-faint">{t("The files of this run weren’t recorded.")}</span>;
  return (
    <>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 pt-1">
        {files.data?.map((file, index) => (
          <li key={index} className="flex items-baseline gap-3 text-xs">
            <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>
            <span className={cn("shrink-0 tabular-nums", file.status === "failed" ? "text-danger" : "text-muted")}>
              {file.status === "failed"
                ? t("Failed")
                : file.status === "copied" || file.size_out === null
                  ? `${formatSize(file.size_in)} · ${t("Copied as is")}`
                  : `${formatSize(file.size_in)} → ${formatSize(file.size_out)} · ${describeChange(file.size_in, file.size_out)}`}
            </span>
          </li>
        ))}
      </ul>
      {files.data?.length === 1000 ? <span className="text-xs text-faint">{t("Only the first {count} files are shown.", { count: 1000 })}</span> : null}
    </>
  );
}

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
  // What converting saved is said of the files it converted; one that was copied is as large as it was.
  if (run.converted && run.size_in > 0) parts.push(`${formatSize(run.size_in)} → ${formatSize(run.size_out)}`, describeChange(run.size_in, run.size_out));
  if (parts.length > 0) return parts.join(" · ");
  return run.status === "done" ? t("No files were waiting") : null;
}

/** The auto-convert's last runs: when each was, how it ended, and what it did. */
export function ConvertRunsDialog({ job, onClose }: { job: ConvertJob | null; onClose: () => void }) {
  // The last job stays on show while its dialog fades out, and so do its runs.
  const [shown, setShown] = useState(job);
  if (job && job !== shown) setShown(job);
  const runs = useConvertRuns(shown, job !== null);
  const [open, setOpen] = useState<string | null>(null);
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
                    {run.converted + run.copied + run.failed > 0 && shown ? (
                      <>
                        <button type="button" aria-expanded={open === run.task_id} className="flex items-center gap-1 self-start rounded-md text-xs font-medium text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50" onClick={() => setOpen(open === run.task_id ? null : run.task_id)}>
                          <ChevronRight className={cn("size-3.5 transition-transform", open === run.task_id && "rotate-90")} />
                          {t("Files")}
                        </button>
                        {open === run.task_id ? <RunFiles jobId={shown.id} run={run} /> : null}
                      </>
                    ) : null}
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
