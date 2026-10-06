import { useState } from "react";
import { useNavigate } from "react-router";
import { ChevronDown, ChevronUp, ListChecks } from "lucide-react";
import { useTasks } from "@/api/hooks";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { pagePaths } from "@/features/workspace/routes";
import type { FileTask } from "@/types/kago";
import { TaskRow } from "./TaskRow";
import { canRetryTask, compressDownloadTarget, isActiveTask } from "./taskUtils";

const RECENT_SECONDS = 5 * 60;

/** Tasks worth interrupting the user for: still running, or just finished with something to act on. */
function needsAttention(task: FileTask) {
  if (isActiveTask(task)) return true;
  const recent = Date.now() / 1000 - task.updated_at < RECENT_SECONDS;
  return recent && (canRetryTask(task) || compressDownloadTarget(task) !== null);
}

/** Floating summary of in-flight work. The full history lives on the tasks page. */
export function TaskCenter() {
  const navigate = useNavigate();
  const tasks = useTasks();
  const [collapsed, setCollapsed] = useState(false);
  const visible = (tasks.data ?? []).filter(needsAttention).slice(0, 4);
  if (visible.length === 0) return null;
  const activeCount = visible.filter(isActiveTask).length;

  return (
    <aside aria-label="任務" className="absolute top-3 right-3 z-[700] flex w-72 flex-col rounded-lg bg-surface shadow-popup">
      <header className="flex h-10 items-center gap-2 pr-1.5 pl-3">
        <ListChecks className="text-muted" />
        <strong className="flex-1 font-medium">{activeCount > 0 ? `${activeCount} 個任務進行中` : "任務"}</strong>
        <KagoIconButton label={collapsed ? "展開任務" : "收合任務"} onClick={() => setCollapsed(!collapsed)}>
          {collapsed ? <ChevronDown /> : <ChevronUp />}
        </KagoIconButton>
      </header>
      {collapsed ? null : (
        <>
          <div className="flex flex-col divide-y divide-line border-t border-line px-3">
            {visible.map((task) => <TaskRow key={task.id} task={task} />)}
          </div>
          <Button variant="ghost" className="m-1.5" onClick={() => navigate(pagePaths.tasks)}>查看所有任務</Button>
        </>
      )}
    </aside>
  );
}
