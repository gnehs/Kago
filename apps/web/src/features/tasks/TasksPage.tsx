import { ListChecks } from "lucide-react";
import { useTasks } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/kago/page";
import { TaskRow } from "./TaskRow";
import { UploadRow } from "./UploadRow";
import { useUploadStore } from "@/stores/uploads";
import { isFinishedTask } from "./taskUtils";
import { useClearFinishedTasks } from "./useClearFinishedTasks";
import { t } from "@/lib/i18n";

export function TasksPage() {
  const tasks = useTasks();
  const uploads = useUploadStore((state) => state.uploads);
  const clear = useClearFinishedTasks();

  return (
    <Page
      actions={tasks.data?.some(isFinishedTask) ? <Button onClick={() => void clear()}>{t("Clear finished")}</Button> : null}
    >
      {tasks.isLoading ? <KagoLoading /> : null}
      {tasks.data?.length === 0 && uploads.length === 0 ? <KagoEmptyState icon={<ListChecks />} title={t("No tasks right now")} /> : null}
      {tasks.data?.length || uploads.length ? (
        <div className="flex flex-col gap-2">
          {uploads.map((upload) => <UploadRow key={`upload:${upload.id}`} upload={upload} />)}
          {tasks.data?.map((task) => <TaskRow key={task.id} task={task} />)}
        </div>
      ) : null}
    </Page>
  );
}
