import { useState } from "react";
import { Check, ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import { useTasks } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoStatusBar } from "@/components/kago/status-bar";
import { Button } from "@/components/ui/button";
import { groupTasks } from "@/lib/taskLayout";
import { useUploadStore } from "@/stores/uploads";
import { TaskRow } from "./TaskRow";
import { UploadRow } from "./UploadRow";
import { useClearFinishedTasks } from "./useClearFinishedTasks";
import { t } from "@/lib/i18n";

/**
 * Work under way and what failed stay at the top, out of the list's way, so a long queue never pushes them off
 * screen; past 45% of the window they scroll on their own. The queue scrolls under them, and what has finished
 * is a count in the bar below until it is asked for.
 */
export function TasksPage() {
  const tasks = useTasks();
  const uploads = useUploadStore((state) => state.uploads);
  const clear = useClearFinishedTasks();
  const [showFinished, setShowFinished] = useState(false);
  const { pinned, queue, finished } = groupTasks(tasks.data ?? []);
  const listed = showFinished ? finished : [];
  const nothing = pinned.length === 0 && uploads.length === 0 && queue.length === 0 && listed.length === 0;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tasks.isLoading ? <KagoLoading /> : null}
      {pinned.length > 0 || uploads.length > 0 ? (
        <div className="flex max-h-[45%] shrink-0 scroll-fade flex-col gap-1.5 overflow-y-auto border-b border-line bg-elevated p-2.5">
          {uploads.map((upload) => <UploadRow key={`upload:${upload.id}`} upload={upload} />)}
          {pinned.map((task) => <TaskRow key={task.id} task={task} />)}
        </div>
      ) : null}
      {queue.length > 0 || listed.length > 0 ? (
        <div className="flex min-h-0 flex-1 scroll-fade flex-col gap-1 overflow-y-auto p-2.5">
          {queue.length > 0 ? <h2 className="m-0 px-1 pt-0.5 pb-0.5 text-xs font-semibold text-muted">{t("Up next · {count}", { count: queue.length })}</h2> : null}
          {queue.map((task, index) => <TaskRow key={task.id} task={task} position={index + 1} />)}
          {listed.length > 0 ? (
            <>
              <h2 className="m-0 px-1 pt-2 pb-0.5 text-xs font-semibold text-muted">{t("Finished · {count}", { count: finished.length })}</h2>
              {finished.map((task) => <TaskRow key={task.id} task={task} />)}
            </>
          ) : null}
        </div>
      ) : null}
      {tasks.data && nothing ? <KagoEmptyState className="flex-1" icon={<ListChecks />} title={t("No tasks right now")} /> : null}
      {finished.length > 0 ? (
        <KagoStatusBar>
          <Check className="size-3.5 text-success" />
          <span className="min-w-0 flex-1 truncate">{t("{count} finished", { count: finished.length })}</span>
          <KagoIconButton label={showFinished ? t("Hide finished") : t("Show finished")} size="sm" active={showFinished} onClick={() => setShowFinished((on) => !on)}>
            {showFinished ? <ChevronDown /> : <ChevronUp />}
          </KagoIconButton>
          <Button className="h-5 px-2 text-xs" onClick={() => void clear()}>
            {t("Clear")}
          </Button>
        </KagoStatusBar>
      ) : null}
    </div>
  );
}
