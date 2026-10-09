import { useQueryClient } from "@tanstack/react-query";
import { Ban, Check, Clock, Pause, X } from "lucide-react";
import { api, downloadUrl, taskDownloadUrl } from "@/api/client";
import { Button } from "@/components/ui/button";
import { extractWithPassword, lockedExtract } from "@/features/files/ArchivePassword";
import { formatPercent } from "@/lib/format";
import { triggerDownload } from "@/lib/paths";
import { run } from "@/lib/run";
import { cn } from "@/lib/utils";
import type { FileTask } from "@/types/kago";
import { canCancelTask, canRetryTask, compressDownloadTarget, hasTaskDownload, isActiveTask, taskErrorLabel, taskProgressLabel, taskProgressMax, taskProgressValue, taskSpeedLabel, taskStatus, taskTypeLabel } from "./taskUtils";
import { t } from "@/lib/i18n";

/** The colour of a state, on the plate at the row's far end. */
const tones = {
  neutral: "text-muted",
  accent: "text-accent",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger"
};

/** What the plate at the end of a row holds once there is no figure to show: a glyph for how the task stands. */
const glyphs: Record<string, React.ReactNode> = { queued: <Clock />, paused: <Pause />, done: <Check />, failed: <X />, interrupted: <X />, cancelled: <Ban /> };

/**
 * A task, as a slab of its own: the far end is a plate in the colour of its state, holding how far along it is,
 * as a figure with its unit beside it, or a glyph once it has stopped.
 * The state is in words as well, at the head of the line under the name, except while the figure is counting.
 */
export function TaskRow({ task }: { task: FileTask }) {
  const queryClient = useQueryClient();
  const status = taskStatus(task);
  const download = compressDownloadTarget(task);
  const locked = lockedExtract(task);
  const downloadHref = download ? downloadUrl(download.rootSlug, download.path) : hasTaskDownload(task) ? taskDownloadUrl(task.id) : null;

  async function act(verb: "cancel" | "pause" | "resume" | "retry") {
    await run(async () => {
      await api(`/api/tasks/${task.id}/${verb}`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    });
  }

  const counting = task.status === "running" || task.status === "pausing";
  const detail = task.error_message ? taskErrorLabel(task.error_message) : taskProgressLabel(task);
  const speed = taskSpeedLabel(task);
  const [percent, tenth] = formatPercent(taskProgressValue(task), taskProgressMax(task)).split(".");

  return (
    <div className={cn("kago-card flex shrink-0 overflow-hidden rounded-md border border-line", tones[status.tone])}>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 px-3 py-2.5 text-ink">
        <div className="flex items-baseline gap-2">
          <strong className="min-w-0 flex-1 truncate font-medium">{taskTypeLabel(task)}</strong>
          {speed ? <span className="shrink-0 text-xs text-muted tabular-nums">{speed}</span> : null}
        </div>
        {isActiveTask(task) ? <progress value={taskProgressValue(task)} max={taskProgressMax(task)} /> : null}
        <span className="truncate text-xs text-muted">{task.status === "running" ? detail : `${status.label} · ${detail}`}</span>
        {downloadHref || canCancelTask(task) || canRetryTask(task) ? (
          <div className="flex gap-1.5">
            {downloadHref ? <Button onClick={() => triggerDownload(downloadHref)}>{t("Download")}</Button> : null}
            {task.status === "queued" ? <Button onClick={() => void act("pause")}>{t("Pause")}</Button> : null}
            {task.status === "paused" ? <Button onClick={() => void act("resume")}>{t("Resume")}</Button> : null}
            {canCancelTask(task) ? <Button onClick={() => void act("cancel")}>{t("Cancel")}</Button> : null}
            {locked ? <Button variant="default" onClick={() => void extractWithPassword(queryClient, locked, task.error_message ?? "")}>{t("Enter password")}</Button> : null}
            {canRetryTask(task) ? <Button onClick={() => void act("retry")}>{t("Retry")}</Button> : null}
          </div>
        ) : null}
      </div>
      <div aria-hidden className="kago-cap flex w-14 shrink-0 items-center justify-center [&>.lucide]:size-[18px] [&>.lucide]:stroke-[2.2]">
        {counting ? (
          <span className="flex items-baseline font-semibold tabular-nums">
            <span className="text-lg leading-none">{percent}</span>
            <span className="ml-px text-[10px]">{tenth ? `.${tenth}` : ""}%</span>
          </span>
        ) : (
          glyphs[task.status]
        )}
      </div>
    </div>
  );
}
