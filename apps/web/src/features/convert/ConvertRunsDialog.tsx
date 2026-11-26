import { useState, type ReactNode } from "react";
import { ChevronRight, History } from "lucide-react";
import { useConvertRunFiles, useConvertRuns } from "@/api/hooks";
import { KagoCopyField } from "@/components/kago/copy-field";
import { KagoDialog } from "@/components/kago/dialog";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoFailureHelp } from "@/components/kago/run-failure";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { Button } from "@/components/ui/button";
import { statusGlyph } from "@/features/tasks/statusGlyph";
import { taskErrorLabel, taskStatus } from "@/features/tasks/taskUtils";
import { formatDuration, formatSize, formatUnixDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { convertParts, failureGroups, FILES_FIRST, FILES_MORE, runSeconds, skipGroups } from "@/lib/runModel";
import { failureTextOf, skipText, skipUnknownText } from "@/lib/runText";
import { cn } from "@/lib/utils";
import type { ConvertJob, ConvertRun, ConvertRunFile } from "@/types/kago";

/** How much smaller, or larger, something came out than it went in. */
function describeChange(before: number, after: number) {
  const percent = before > 0 ? Math.round((1 - after / before) * 100) : 0;
  return percent > 0 ? t("{percent}% smaller", { percent }) : percent < 0 ? t("{percent}% larger", { percent: -percent }) : t("Same size");
}

/** The files of a group that is told in a few, with a button for more where there are more. */
function FileList({ files, render }: { files: ConvertRunFile[]; render: (file: ConvertRunFile) => ReactNode }) {
  const [shown, setShown] = useState(FILES_FIRST);
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {files.slice(0, shown).map((file, index) => <li key={index} className="flex items-baseline gap-3 text-xs">{render(file)}</li>)}
      {files.length > shown ? (
        <li>
          <Button className="h-5 px-2 text-xs" onClick={() => setShown((count) => count + FILES_MORE)}>{t("{count} more…", { count: files.length - shown })}</Button>
        </li>
      ) : null}
    </ul>
  );
}

const nameOf = (file: ConvertRunFile) => <span className="min-w-0 flex-1 truncate" title={file.path}>{file.path}</span>;

/** How many files a group holds, beside the line that says what is the matter with them. */
const countOf = (count: number) => t("{count} file | {count} files", { count });

/** The files of one run: the ones that failed under what went wrong with them, what a run passed over under why, then what it did. */
function RunFiles({ jobId, run }: { jobId: string; run: ConvertRun }) {
  const files = useConvertRunFiles(jobId, run);
  if (files.isLoading) return <span className="text-xs text-muted">{t("Loading")}</span>;
  if (files.isError) return <span className="text-xs text-danger">{t("Couldn’t load the files")}</span>;
  // A run from before its files were written down has only its counts.
  if (files.data?.length === 0) return <span className="text-xs text-faint">{t("The files of this run weren’t recorded.")}</span>;
  const all = files.data ?? [];
  const done = all.filter((file) => file.status === "converted" || file.status === "copied");
  return (
    <div className="flex flex-col gap-3 pt-1">
      {failureGroups(all).map((group) => (
        <section key={group.code ?? "unrecorded"} className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2 text-xs">
            <span className="min-w-0 font-medium text-danger">{failureTextOf(group.code).reason}</span>
            <span className="shrink-0 text-muted tabular-nums">· {countOf(group.count)}</span>
          </div>
          <KagoFailureHelp code={group.code} detail={null} />
          {group.clusters.map((cluster) => (
            <div key={cluster.detail ?? ""} className="flex flex-col gap-1">
              {cluster.detail ? <KagoCopyField wrap value={cluster.detail} /> : null}
              <FileList files={cluster.files} render={nameOf} />
            </div>
          ))}
        </section>
      ))}
      {skipGroups(all).map((group) => (
        <section key={group.reason ?? "unrecorded"} className="flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2 text-xs text-muted">
            <span className="min-w-0 font-medium">{group.reason ? skipText[group.reason] : skipUnknownText}</span>
            <span className="shrink-0 tabular-nums">· {countOf(group.files.length)}</span>
          </div>
          <FileList files={group.files} render={nameOf} />
        </section>
      ))}
      {done.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {done.map((file, index) => (
            <li key={index} className="flex items-baseline gap-3 text-xs">
              {nameOf(file)}
              <span className="shrink-0 text-muted tabular-nums">
                {file.status === "copied" || file.size_out === null
                  ? `${formatSize(file.size_in)} · ${t("Copied as is")}`
                  : `${formatSize(file.size_in)} → ${formatSize(file.size_out)} · ${describeChange(file.size_in, file.size_out)}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {files.data?.length === 1000 ? <span className="text-xs text-faint">{t("Only the first {count} files are shown.", { count: 1000 })}</span> : null}
    </div>
  );
}

/** Where a run came from and what it processed, under its headline. */
function describeRun(run: ConvertRun) {
  return [
    formatUnixDate(run.started_at),
    run.scheduled ? t("Started by watching the folder") : t("Started by hand"),
    run.bytes > 0 ? t("{size} processed", { size: formatSize(run.bytes) }) : null
  ].filter(Boolean).join(" · ");
}

const partText = { converted: (count: number) => t("Converted {count}", { count }), copied: (count: number) => t("Copied {count} as is", { count }), failed: (count: number) => t("{count} failed", { count }), skipped: (count: number) => t("{count} skipped", { count }) };

/** What a run did, as its headline ("Converted 12, 3 failed, 2 skipped"), with the saving in the line under it. A run that failed as a whole says why instead; one with nothing to count, how it ended. */
function Headline({ run }: { run: ConvertRun }) {
  if (run.error_code) return <span className="text-danger">{failureTextOf(run.error_code).reason}</span>;
  const parts = convertParts(run);
  if (parts.length === 0) return <>{run.status === "done" ? t("No files were waiting") : taskStatus({ status: run.status }).label}</>;
  return (
    <>
      {parts.map((part, index) => (
        <span key={part.kind} className={part.kind === "failed" ? "text-danger" : undefined}>{index > 0 ? t("{first}, {second}", { first: "", second: "" }) : ""}{partText[part.kind](part.count)}</span>
      ))}
    </>
  );
}

/** What converting saved, of the files a run converted; one that was copied is as large as it was. */
const describeSaving = (run: ConvertRun) => (run.converted > 0 && run.size_in > 0 ? `${formatSize(run.size_in)} → ${formatSize(run.size_out)} · ${describeChange(run.size_in, run.size_out)}` : null);

/** The auto-convert's last runs: when each was, how it ended, and what it did. */
export function ConvertRunsDialog({ job, onClose }: { job: ConvertJob | null; onClose: () => void }) {
  // The last job stays on show while its dialog fades out, and so do its runs.
  const [shown, setShown] = useState(job);
  if (job && job !== shown) setShown(job);
  const runs = useConvertRuns(shown, job !== null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <KagoDialog open={job !== null} onClose={onClose} title={t("Runs of {name}", { name: shown?.name ?? "" })} className="w-[min(560px,calc(100%-32px))]">
      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 pt-3">
        {runs.isLoading ? <KagoLoading /> : null}
        {runs.isError ? <p className="m-0 text-danger">{t("Couldn’t load the runs")}</p> : null}
        {runs.data?.length === 0 ? <KagoEmptyState icon={<History />} title={t("No runs yet")} description={t("Each run of this auto-convert is listed here once it has started.")} /> : null}
        {runs.data?.length ? (
          <ul className="kago-well m-0 list-none divide-y divide-line rounded-md p-0">
            {runs.data.map((run) => {
              const status = taskStatus({ status: run.status });
              const seconds = runSeconds(run);
              const saving = describeSaving(run);
              const count = run.converted + run.copied + run.failed + run.skipped;
              return (
                <li key={run.task_id} className="flex items-start gap-3 px-3 py-2">
                  <KagoStatusIcon tone={status.tone} label={status.label}>{statusGlyph(run.status)}</KagoStatusIcon>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="font-medium">
                      <Headline run={run} />
                      {seconds !== null ? <span className="font-normal text-muted"> · {formatDuration(seconds)}</span> : null}
                    </span>
                    <span className="text-xs text-muted tabular-nums">{[describeRun(run), saving].filter(Boolean).join(" · ")}</span>
                    {/* "Some files couldn’t be converted" is what the headline's count of failed files already says. */}
                    {run.error_code ? <KagoFailureHelp code={run.error_code} detail={run.error_detail} /> : run.error_message && run.failed === 0 ? <span className="text-xs break-words text-danger">{taskErrorLabel(run.error_message)}</span> : null}
                    {count > 0 && shown ? (
                      <>
                        <button type="button" aria-expanded={open === run.task_id} className="mt-0.5 flex items-center gap-1 self-start rounded-md text-xs font-medium text-muted outline-none hover:text-ink focus-ring" onClick={() => setOpen(open === run.task_id ? null : run.task_id)}>
                          <ChevronRight className={cn("size-3.5 transition-transform", open === run.task_id && "rotate-90")} />
                          {open === run.task_id ? t("Hide the files") : t("Show {count} file | Show {count} files", { count })}
                        </button>
                        {open === run.task_id ? <RunFiles jobId={shown.id} run={run} /> : null}
                      </>
                    ) : null}
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
