import type { ReactNode } from "react";
import { create } from "zustand";

/** What a dialog asks about, shown as the thing itself: its icon, its name under it, and a line about it. */
export type DialogSubject = { icon: ReactNode; name: string; detail?: string };

export type DialogRequest = {
  title: string;
  subject?: DialogSubject;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  /** When set the dialog shows a text field prefilled with this value. */
  input?: { defaultValue: string; placeholder?: string };
  resolve: (value: string | null) => void;
};

export const useDialogStore = create<{ request: DialogRequest | null }>(() => ({ request: null }));

function open(request: Omit<DialogRequest, "resolve">) {
  return new Promise<string | null>((resolve) => {
    useDialogStore.getState().request?.resolve(null);
    useDialogStore.setState({ request: { ...request, resolve } });
  });
}

export function promptText(options: { title: string; description?: string; defaultValue?: string; placeholder?: string; confirmLabel?: string }) {
  return open({ ...options, input: { defaultValue: options.defaultValue ?? "", placeholder: options.placeholder } });
}

export async function confirmAction(options: { title: string; subject?: DialogSubject; description?: string; confirmLabel?: string; destructive?: boolean }) {
  return (await open(options)) !== null;
}

export function settleDialog(value: string | null) {
  useDialogStore.getState().request?.resolve(value);
  useDialogStore.setState({ request: null });
}
