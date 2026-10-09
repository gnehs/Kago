import { create } from "zustand";

export type Toast = {
  id: number;
  message: string;
  kind: "info" | "error";
  /** On its way out: still drawn, fading, and no longer counted. */
  leaving?: boolean;
  /** What it is about. The next one said about the same thing takes its place rather than a place of its own. */
  key?: string;
  /** It reports on work that is still going, and stays up until it is replaced or dismissed. */
  ongoing?: boolean;
  /** How far along that work is, with the figures in words, and how fast it is going if that is known. */
  progress?: { value: number; max: number; detail: string; speed?: string };
};

let nextId = 1;

/** How long a notification stays up when left alone. What went wrong takes longer to read than what went right. */
const life = (kind: Toast["kind"]) => (kind === "error" ? 6000 : 3000);
/** As long as the fade in styles.css (`.kago-toast[data-leaving]`). */
const LEAVE = 120;

const timers = new Map<number, ReturnType<typeof setTimeout>>();

function arm(toast: Toast) {
  clearTimeout(timers.get(toast.id));
  if (toast.ongoing) timers.delete(toast.id);
  else timers.set(toast.id, setTimeout(() => useToastStore.getState().dismiss(toast.id), life(toast.kind)));
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

export function toast(message: string, kind: Toast["kind"] = "info", options: Pick<Toast, "key" | "ongoing" | "progress"> = {}) {
  // Said again while it is still up, it is not said twice: the one that is there stays that much longer.
  // What is said under a key takes over the one already up under it, whatever that one said.
  const up = useToastStore
    .getState()
    .toasts.find((entry) => !entry.leaving && (options.key === undefined ? entry.key === undefined && entry.message === message && entry.kind === kind : entry.key === options.key));
  if (up) {
    const next = { ...up, message, kind, ongoing: options.ongoing, progress: options.progress };
    useToastStore.setState((state) => ({ toasts: state.toasts.map((entry) => (entry.id === up.id ? next : entry)) }));
    arm(next);
    return;
  }
  const entry = { id: nextId++, message, kind, ...options };
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

const keyed = (key: string) => useToastStore.getState().toasts.find((entry) => entry.key === key && !entry.leaving);

/** Whether what was said under `key` is still up. */
export const hasToast = (key: string) => keyed(key) !== undefined;

/** Takes down what was said under `key`, if it is still up. */
export function dismissToast(key: string) {
  const entry = keyed(key);
  if (entry) useToastStore.getState().dismiss(entry.id);
}
