import { create } from "zustand";

export type Toast = { id: number; message: string; kind: "info" | "error"; /** On its way out: still drawn, fading, and no longer counted. */ leaving?: boolean };

let nextId = 1;

/** How long a notification stays up when left alone. What went wrong takes longer to read than what went right. */
const life = (kind: Toast["kind"]) => (kind === "error" ? 6000 : 3000);
/** As long as the fade in styles.css (`.kago-toast[data-leaving]`). */
const LEAVE = 120;

const timers = new Map<number, ReturnType<typeof setTimeout>>();

function arm(toast: Pick<Toast, "id" | "kind">) {
  clearTimeout(timers.get(toast.id));
  timers.set(toast.id, setTimeout(() => useToastStore.getState().dismiss(toast.id), life(toast.kind)));
}

export const useToastStore = create<{
  toasts: Toast[];
  dismiss: (id: number) => void;
  /** Keeps a notification up while the pointer is on it, and gives it its time again once the pointer has left. */
  hold: (id: number) => void;
  release: (id: number) => void;
}>((set, get) => ({
  toasts: [],
  dismiss: (id) => {
    clearTimeout(timers.get(id));
    timers.delete(id);
    set((state) => ({ toasts: state.toasts.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast)) }));
    setTimeout(() => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })), LEAVE);
  },
  hold: (id) => clearTimeout(timers.get(id)),
  release: (id) => {
    const toast = get().toasts.find((entry) => entry.id === id && !entry.leaving);
    if (toast) arm(toast);
  }
}));

export function toast(message: string, kind: Toast["kind"] = "info") {
  // Said again while it is still up, it is not said twice: the one that is there stays that much longer.
  const same = useToastStore.getState().toasts.find((entry) => entry.message === message && entry.kind === kind && !entry.leaving);
  if (same) {
    arm(same);
    return;
  }
  const entry = { id: nextId++, message, kind };
  useToastStore.setState((state) => {
    // Four at most: the oldest gives up its place, and its timer with it.
    const kept = state.toasts.slice(-3);
    for (const dropped of state.toasts.slice(0, -3)) {
      clearTimeout(timers.get(dropped.id));
      timers.delete(dropped.id);
    }
    return { toasts: [...kept, entry] };
  });
  arm(entry);
}
