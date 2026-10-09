import { ListChecks } from "lucide-react";
import { useTasks } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Page } from "@/components/kago/page";
import { TaskRow } from "./TaskRow";
import { isFinishedTask } from "./taskUtils";
import { useClearFinishedTasks } from "./useClearFinishedTasks";
import { t } from "@/lib/i18n";

export function TasksPage() {
  const tasks = useTasks();
  const clear = useClearFinishedTasks();

  return (
    <Page
      description={t("Copying, moving, compressing and the like run on the server in the background, and carry on after you close the browser. Finished tasks are cleared after 7 days.")}
      actions={tasks.data?.some(isFinishedTask) ? <Button onClick={() => void clear()}>{t("Clear finished")}</Button> : null}
    >
      {tasks.isLoading ? <KagoLoading /> : null}
      {tasks.data?.length === 0 ? <KagoEmptyState icon={<ListChecks />} title={t("No tasks right now")} /> : null}
      {tasks.data?.length ? (
        <div className="flex flex-col divide-y divide-line kago-card rounded-lg border border-line px-4">
          {tasks.data.map((task) => <TaskRow key={task.id} task={task} />)}
        </div>
      ) : null}
    </Page>
  );
}
