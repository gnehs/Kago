import { useQueryClient } from "@tanstack/react-query";
import { ListChecks } from "lucide-react";
import { api } from "@/api/client";
import { useTasks } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Page } from "@/features/workspace/Page";
import { run } from "@/lib/run";
import { toast } from "@/stores/toast";
import { TaskRow } from "./TaskRow";
import { isFinishedTask } from "./taskUtils";
import { t } from "@/lib/i18n";

export function TasksPage() {
  const queryClient = useQueryClient();
  const tasks = useTasks();

  async function clear() {
    await run(async () => {
      await api("/api/tasks", { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["tasks"] });
      toast(t("Finished tasks cleared"));
    }, t("Couldn’t clear the tasks"));
  }

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
