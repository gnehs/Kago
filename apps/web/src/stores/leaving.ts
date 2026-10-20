import { create } from "zustand";
import type { FileRef } from "./clipboard";

const refKey = (rootSlug: string, path: string) => `${rootSlug}\n${path}`;

/**
 * Items on their way out of their folder, to the Trash or elsewhere, by the task moving them. The move runs on the
 * server and can take a while, but to the user it has already happened, so listings leave these out until the task settles.
 */
export const useLeavingStore = create<{ tasks: Record<string, string[]> }>(() => ({ tasks: {} }));

/**
 * Tasks heard to have ended, and whether they finished. A quick task can end before the request that started it is
 * answered, and what it carried away must not be hidden after that for good.
 */
const settled = new Map<string, boolean>();

export function settleLeaving(taskId: string, done: boolean) {
  settled.set(taskId, done);
  // Only the latest few can still be waiting for their answer.
  if (settled.size > 100) settled.delete(settled.keys().next().value!);
}

/** Whether a task has been heard to finish (true), to fail or be cancelled (false), or neither yet (undefined). */
export const leavingSettled = (taskId: string) => settled.get(taskId);

export function hideLeaving(taskId: string, refs: FileRef[]) {
  if (settled.has(taskId)) return;
  useLeavingStore.setState(({ tasks }) => ({ tasks: { ...tasks, [taskId]: refs.map((ref) => refKey(ref.rootSlug, ref.path)) } }));
}

export function showLeaving(taskId: string) {
  useLeavingStore.setState(({ tasks }) => {
    if (!(taskId in tasks)) return { tasks };
    const { [taskId]: _settled, ...rest } = tasks;
    return { tasks: rest };
  });
}

/** An item is leaving with the folder it is in, so what a search found inside a moved folder goes too. */
export const isLeaving = (tasks: Record<string, string[]>, rootSlug: string, path: string) => {
  const key = refKey(rootSlug, path);
  return Object.values(tasks).some((keys) => keys.some((left) => key === left || key.startsWith(`${left}/`)));
};

/** Where the items a task is carrying away are, as the location and path of each. */
export const leavingRefs = (taskId: string): FileRef[] =>
  (useLeavingStore.getState().tasks[taskId] ?? []).map((key) => {
    const [rootSlug, path] = key.split("\n") as [string, string];
    return { rootSlug, path };
  });
