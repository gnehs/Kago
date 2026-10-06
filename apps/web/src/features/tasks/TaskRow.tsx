import { useQueryClient } from "@tanstack/react-query";
import { api, downloadUrl } from "@/api/client";
import { KagoBadge } from "@/components/kago/badge";
import { Button } from "@/components/ui/button";
import { triggerDownload } from "@/lib/paths";
import { run } from "@/lib/run";
import type { FileTask } from "@/types/kago";
import { canRetryTask, compressDownloadTarget, isActiveTask, taskProgressLabel, taskProgressMax, taskProgressValue, taskStatus, taskTypeLabel } from "./taskUtils";

export function TaskRow({ task }: { task: FileTask }) {
  const queryClient = useQueryClient();
  const status = taskStatus(task);
  const download = compressDownloadTarget(task);

  async function act(verb: "cancel" | "pause" | "resume" | "retry") {
    await run(async () => {
      await api(`/api/tasks/${task.id}/${verb}`, { method: "POST" });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    });
  }

  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className="flex items-center gap-2">
        <strong className="min-w-0 flex-1 truncate font-medium">{taskTypeLabel(task)}</strong>
        <KagoBadge tone={status.tone}>{status.label}</KagoBadge>
      </div>
      {isActiveTask(task) ? <progress value={taskProgressValue(task)} max={taskProgressMax(task)} /> : null}
      <span className="truncate text-xs text-muted">{task.error_message ?? taskProgressLabel(task)}</span>
      {download || task.status === "queued" || task.status === "paused" || canRetryTask(task) ? (
        <div className="flex gap-1.5">
          {download ? <Button onClick={() => triggerDownload(downloadUrl(download.rootSlug, download.path))}>下載</Button> : null}
          {task.status === "queued" ? <Button onClick={() => void act("pause")}>暫停</Button> : null}
          {task.status === "paused" ? <Button onClick={() => void act("resume")}>繼續</Button> : null}
          {task.status === "queued" || task.status === "paused" ? <Button onClick={() => void act("cancel")}>取消</Button> : null}
          {canRetryTask(task) ? <Button onClick={() => void act("retry")}>重試</Button> : null}
        </div>
      ) : null}
    </div>
  );
}
