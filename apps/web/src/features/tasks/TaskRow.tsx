import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { keys } from "@/api/keys";
import { Ban, Check, CircleAlert, Pause, Play, X } from "lucide-react";
import { api, downloadUrl, taskDownloadUrl } from "@/api/client";
import { useRoots } from "@/api/hooks";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoTooltip } from "@/components/kago/tooltip";
import { Button } from "@/components/ui/button";
import { extractWithPassword, lockedExtract } from "@/features/files/ArchivePassword";
import { formatPercent, formatSize } from "@/lib/format";
import { triggerDownload } from "@/lib/paths";
import { run } from "@/lib/run";
import { taskCurrentName } from "@/lib/taskLayout";
import type { FileTask } from "@/types/kago";
import { canCancelTask, canRetryTask, compressDownloadTarget, hasTaskDownload, isCountingTask, taskErrorLabel, taskLeftLabel, taskProgressLabel, taskProgressMax, taskProgressValue, taskSentence, taskSpeedLabel, taskStatus } from "./taskUtils";
import { t } from "@/lib/i18n";

/** What a task is doing as a sentence: the verb stays whole, the subject gives way first, the destination after it. */
function TaskTitle({ task }: { task: FileTask }) {
  const roots = useRoots().data;
  const { verb, subject, destination } = taskSentence(task, (slug) => roots?.find((root) => root.slug === slug)?.name);
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-1.5" title={[verb, subject, destination && `→ ${destination}`].filter(Boolean).join(" ")}>
      <span className="shrink-0 font-medium">{verb}</span>
      {subject ? <span className="min-w-0 shrink-[3] truncate">{subject}</span> : null}
      {destination ? <span className="min-w-0 shrink truncate text-muted">→ {destination}</span> : null}
    </span>
  );
}

/**
 * A card for work in progress: the title and how far along it is, a bar, and under it what is being worked on and
 * how long is left. The detail that does not fit in a line is in the tooltip. The bar runs to and fro without a value.
 */
export function ProgressCard({ title, value, max, left, right, cancel, detail }: { title: ReactNode; value: number | undefined; max: number; left: ReactNode; right: string | null; cancel: { label: string; onClick: () => void } | null; detail: ReactNode }) {
  const percent = value === undefined ? null : formatPercent(value, max);
  return (
    <KagoTooltip label={detail}>
      <div className="kago-card flex min-h-[62px] shrink-0 items-center gap-2 rounded-md border border-line py-2 pr-1.5 pl-3 text-ink">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            {title}
            {percent ? <span className="shrink-0 font-semibold text-accent tabular-nums">{percent}%</span> : null}
          </div>
          <progress className="h-1" value={value} max={max} />
          <div className="flex items-start gap-2 text-xs text-muted">
            <span className="min-w-0 flex-1 truncate">{left}</span>
            {right ? <span className="shrink-0 tabular-nums">{right}</span> : null}
          </div>
        </div>
        {cancel ? (
          <KagoIconButton label={cancel.label} size="sm" onClick={cancel.onClick}>
            <X />
          </KagoIconButton>
        ) : null}
      </div>
    </KagoTooltip>
  );
}

/**
 * A task as a card, in the shape its state gives it: work under way is tall, with a bar; one that needs the
 * user is a line with what to do about it; the ones waiting, paused or done are thin lines. `position` is a
 * queued task's place in the queue.
 */
export function TaskRow({ task, position }: { task: FileTask; position?: number }) {
  const queryClient = useQueryClient();

  async function act(verb: "cancel" | "pause" | "resume" | "retry") {
    await run(async () => {
      await api(`/api/tasks/${task.id}/${verb}`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: keys.tasks() });
    });
  }
  const cancel = canCancelTask(task) ? { label: t("Cancel"), onClick: () => void act("cancel") } : null;

  if (task.status === "running" || task.status === "cancelling") {
    const speed = taskSpeedLabel(task);
    const counting = isCountingTask(task);
    return (
      <ProgressCard
        title={<TaskTitle task={task} />}
        value={counting ? undefined : taskProgressValue(task)}
        max={taskProgressMax(task)}
        left={task.status === "cancelling" ? taskStatus(task).label : taskCurrentName(task) ?? (counting ? taskProgressLabel(task) : null)}
        right={taskLeftLabel(task)}
        cancel={cancel}
        detail={
          <>
            <div>{taskProgressLabel(task)}</div>
            {speed ? <div>{speed}</div> : null}
          </>
        }
      />
    );
  }

  if (task.status === "failed" || task.status === "interrupted") {
    const locked = lockedExtract(task);
    return (
      <div className="kago-card @container shrink-0 rounded-md border border-line text-ink">
        {/* In a narrow card the reason goes on a line of its own, so that neither it nor the title is cut to nothing. */}
        <div className="flex min-h-9 flex-wrap items-center gap-x-2 gap-y-0.5 py-1.5 pr-1.5 pl-3">
          <CircleAlert className="size-4 shrink-0 text-danger" aria-label={taskStatus(task).label} />
          <TaskTitle task={task} />
          <span className="min-w-0 shrink truncate text-xs text-danger @max-sm:order-last @max-sm:basis-full @max-sm:pl-6" title={task.error_message ? taskErrorLabel(task.error_message) : undefined}>
            {task.error_message ? taskErrorLabel(task.error_message) : taskStatus(task).label}
          </span>
          {locked ? (
            <Button className="h-6 px-2 text-xs" onClick={() => void extractWithPassword(queryClient, locked, task.error_message ?? "")}>
              {t("Enter password")}
            </Button>
          ) : canRetryTask(task) ? (
            <Button className="h-6 px-2 text-xs" onClick={() => void act("retry")}>
              {t("Retry")}
            </Button>
          ) : null}
        </div>
      </div>
    );
  }

  if (task.status === "queued" || task.status === "paused") {
    const paused = task.status === "paused";
    return (
      <div className="kago-card flex h-8 shrink-0 items-center gap-2 rounded-md border border-line pr-1.5 pl-2 text-ink shadow-none">
        <span className="flex w-4 shrink-0 justify-end text-[11px] text-faint tabular-nums">{paused ? <Pause className="size-3.5" aria-label={taskStatus(task).label} /> : position}</span>
        <TaskTitle task={task} />
        {paused ? <span className="shrink-0 text-xs text-muted">{taskStatus(task).label}</span> : task.total_bytes > 0 ? <span className="shrink-0 text-xs text-faint tabular-nums">{formatSize(task.total_bytes)}</span> : null}
        <KagoIconButton label={paused ? t("Resume") : t("Pause")} size="sm" onClick={() => void act(paused ? "resume" : "pause")}>
          {paused ? <Play /> : <Pause />}
        </KagoIconButton>
        {cancel ? (
          <KagoIconButton label={cancel.label} size="sm" onClick={cancel.onClick}>
            <X />
          </KagoIconButton>
        ) : null}
      </div>
    );
  }

  const download = compressDownloadTarget(task);
  const downloadHref = download ? downloadUrl(download.rootSlug, download.path) : hasTaskDownload(task) ? taskDownloadUrl(task.id) : null;
  return (
    <div className="kago-card flex h-8 shrink-0 items-center gap-2 rounded-md border border-line pr-1.5 pl-2 text-ink shadow-none">
      {task.status === "done" ? <Check className="size-4 shrink-0 text-success" aria-label={taskStatus(task).label} /> : <Ban className="size-4 shrink-0 text-muted" aria-label={taskStatus(task).label} />}
      <TaskTitle task={task} />
      {downloadHref ? (
        <Button className="h-6 px-2 text-xs" onClick={() => triggerDownload(downloadHref)}>
          {t("Download")}
        </Button>
      ) : null}
      {canRetryTask(task) ? (
        <Button className="h-6 px-2 text-xs" onClick={() => void act("retry")}>
          {t("Retry")}
        </Button>
      ) : null}
    </div>
  );
}
