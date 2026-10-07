import { create } from "zustand";
import type { FileRef } from "./clipboard";

const refKey = (rootSlug: string, path: string) => `${rootSlug}\n${path}`;

/**
 * Items on their way to the Trash, by the task moving them. The move runs on the server and can take
 * a while, but to the user it has already happened, so listings leave these out until the task settles.
 */
export const useTrashingStore = create<{ tasks: Record<string, string[]> }>(() => ({ tasks: {} }));

export function hideTrashing(taskId: string, refs: FileRef[]) {
  useTrashingStore.setState(({ tasks }) => ({ tasks: { ...tasks, [taskId]: refs.map((ref) => refKey(ref.rootSlug, ref.path)) } }));
}

/** Without a task, forgets them all. */
export function showTrashing(taskId?: string) {
  useTrashingStore.setState(({ tasks }) => {
    if (!taskId) return { tasks: {} };
    if (!(taskId in tasks)) return { tasks };
    const { [taskId]: _settled, ...rest } = tasks;
    return { tasks: rest };
  });
}

export const isTrashing = (tasks: Record<string, string[]>, rootSlug: string, path: string) => {
  const key = refKey(rootSlug, path);
  return Object.values(tasks).some((keys) => keys.includes(key));
};
