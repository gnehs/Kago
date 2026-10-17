import { create } from "zustand";
import type { FileRef } from "./clipboard";

const refKey = (rootSlug: string, path: string) => `${rootSlug}\n${path}`;

/**
 * Items on their way out of their folder, to the Trash or elsewhere, by the task moving them. The move runs on the
 * server and can take a while, but to the user it has already happened, so listings leave these out until the task settles.
 */
export const useLeavingStore = create<{ tasks: Record<string, string[]> }>(() => ({ tasks: {} }));

export function hideLeaving(taskId: string, refs: FileRef[]) {
  useLeavingStore.setState(({ tasks }) => ({ tasks: { ...tasks, [taskId]: refs.map((ref) => refKey(ref.rootSlug, ref.path)) } }));
}

/** Without a task, forgets them all. */
export function showLeaving(taskId?: string) {
  useLeavingStore.setState(({ tasks }) => {
    if (!taskId) return { tasks: {} };
    if (!(taskId in tasks)) return { tasks };
    const { [taskId]: _settled, ...rest } = tasks;
    return { tasks: rest };
  });
}

export const isLeaving = (tasks: Record<string, string[]>, rootSlug: string, path: string) => {
  const key = refKey(rootSlug, path);
  return Object.values(tasks).some((keys) => keys.includes(key));
};
