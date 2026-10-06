import { ListChecks } from "lucide-react";
import { useTasks } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Page } from "@/features/workspace/Page";
import { TaskRow } from "./TaskRow";

export function TasksPage() {
  const tasks = useTasks();
  return (
    <Page title="任務" description="複製、搬移、壓縮等工作都在伺服器背景執行，關掉瀏覽器也會繼續。">
      {tasks.isLoading ? <KagoLoading /> : null}
      {tasks.data?.length === 0 ? <KagoEmptyState icon={<ListChecks />} title="目前沒有任務" /> : null}
      {tasks.data?.length ? (
        <div className="flex flex-col divide-y divide-line rounded-lg border border-line px-4">
          {tasks.data.map((task) => <TaskRow key={task.id} task={task} />)}
        </div>
      ) : null}
    </Page>
  );
}
