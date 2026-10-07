import { ListChecks } from "lucide-react";
import { useTasks } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Page } from "@/features/workspace/Page";
import { TaskRow } from "./TaskRow";
import { t } from "@/lib/i18n";

export function TasksPage() {
  const tasks = useTasks();
  return (
    <Page description={t("Copying, moving, compressing and the like run on the server in the background, and carry on after you close the browser.")}>
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
