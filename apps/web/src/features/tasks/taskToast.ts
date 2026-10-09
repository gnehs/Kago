import { useEffect } from "react";
import { useTasks } from "@/api/hooks";
import { dismissToast, hasToast, toast, type Toast } from "@/stores/toast";
import type { FileTask } from "@/types/kago";
import { isActiveTask, taskErrorLabel, taskProgressLabel, taskProgressMax, taskProgressValue, taskStatus, taskTypeLabel } from "./taskUtils";
import { t } from "@/lib/i18n";

/** Task types whose completion is worth announcing; the rest finish quietly. */
export const announcedTypes = ["copy", "move", "compress", "extract", "restore_trash", "sync"];

export const taskFinished = (label: string) => t("{task} finished", { task: label });
export const taskFailed = (label: string, error?: string | null) => t("{task} failed: {reason}", { task: label, reason: taskErrorLabel(error ?? "Task failed") });

const keyOf = (taskId: string) => `task:${taskId}`;

/** The tasks this tab started whose notification is up, saying how they stand. */
const followed = new Set<string>();

function show(task: FileTask) {
  const label = taskTypeLabel(task);
  const figures = taskProgressLabel(task);
  // There is nothing to count until the task is under way: until then it says only where it stands.
  if (task.status === "queued" || task.status === "paused") toast(`${label} · ${taskStatus(task).label}`, "info", { key: keyOf(task.id), ongoing: true });
  else {
    toast(label, "info", {
      key: keyOf(task.id),
      ongoing: true,
      progress: { value: taskProgressValue(task), max: taskProgressMax(task), detail: task.status === "running" ? figures : `${taskStatus(task).label} · ${figures}` }
    });
  }
}

/** Reports on a task this tab has just started: one notification that counts along with it, and then says how it ended. */
export function followTask(task: FileTask) {
  followed.add(task.id);
  show(task);
}

/** The task is over. What is said of it takes the place of its count, and with nothing to say the count just goes. */
export function settleTask(taskId: string, message?: string, kind?: Toast["kind"]) {
  followed.delete(taskId);
  if (message) toast(message, kind, { key: keyOf(taskId) });
  else dismissToast(keyOf(taskId));
}

function report(tasks: FileTask[]) {
  for (const task of tasks) {
    if (!followed.has(task.id)) continue;
    // Dismissed by hand, or pushed out by newer ones: it is not put back up. The socket still announces how the task ends.
    if (!hasToast(keyOf(task.id))) followed.delete(task.id);
    else if (isActiveTask(task)) show(task);
    // The socket says how a task ended as it happens. One that ended while the socket was away is heard of here instead.
    else if (task.status === "done") settleTask(task.id, announcedTypes.includes(task.type) ? taskFinished(taskTypeLabel(task)) : undefined);
    else if (task.status === "cancelled") settleTask(task.id);
    else settleTask(task.id, taskFailed(taskTypeLabel(task), task.error_message), "error");
  }
}

/** Keeps the notifications of this tab's tasks counting as the list of tasks is heard again. */
export function useTaskToasts() {
  const { data } = useTasks();
  useEffect(() => {
    if (data) report(data);
  }, [data]);
}
