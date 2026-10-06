import { create } from "zustand";

export type Toast = { id: number; message: string; kind: "info" | "error" };

let nextId = 1;

export const useToastStore = create<{ toasts: Toast[]; dismiss: (id: number) => void }>((set) => ({
  toasts: [],
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
}));

export function toast(message: string, kind: Toast["kind"] = "info") {
  const id = nextId++;
  useToastStore.setState((state) => ({ toasts: [...state.toasts.slice(-3), { id, message, kind }] }));
  setTimeout(() => useToastStore.getState().dismiss(id), kind === "error" ? 6000 : 3000);
}
