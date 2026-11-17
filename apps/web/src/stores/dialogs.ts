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
  /** A second thing the dialog can do instead, which answers with `ALTERNATIVE`. */
  alternative?: { label: string; destructive?: boolean };
  /** When set the dialog shows a text field prefilled with this value, selected up to `selectEnd` (all of it when unset). */
  input?: { defaultValue: string; placeholder?: string; selectEnd?: number };
  resolve: (value: string | null) => void;
};

/** The window a dialog opened from code belongs to; null, or left out, for one that belongs to no window. */
type Scoped = { window?: string | null };

export const ALTERNATIVE = "\0alternative";

/** The question each window is waiting on, by window id; the page's is under "". A window asks one thing at a time. */
export const useDialogStore = create<{ requests: Record<string, DialogRequest> }>(() => ({ requests: {} }));

function open({ window, ...request }: Omit<DialogRequest, "resolve"> & Scoped) {
  const scope = window ?? "";
  return new Promise<string | null>((resolve) => {
    useDialogStore.getState().requests[scope]?.resolve(null);
    useDialogStore.setState(({ requests }) => ({ requests: { ...requests, [scope]: { ...request, resolve } } }));
  });
}

export function promptText(options: Scoped & { title: string; description?: string; defaultValue?: string; placeholder?: string; selectEnd?: number; confirmLabel?: string }) {
  return open({ ...options, input: { defaultValue: options.defaultValue ?? "", placeholder: options.placeholder, selectEnd: options.selectEnd } });
}

export async function confirmAction(options: Scoped & { title: string; subject?: DialogSubject; description?: string; confirmLabel?: string; destructive?: boolean }) {
  return (await open(options)) !== null;
}

/** Asks which of two things to do: resolves to the one picked, or to nothing when neither was. */
export async function chooseAction(options: Scoped & { title: string; subject?: DialogSubject; description?: string; confirmLabel: string; alternative: { label: string; destructive?: boolean } }) {
  const answer = await open(options);
  return answer === null ? null : answer === ALTERNATIVE ? "alternative" : "confirm";
}

export function settleDialog(scope: string, value: string | null) {
  const { [scope]: request, ...rest } = useDialogStore.getState().requests;
  request?.resolve(value);
  useDialogStore.setState({ requests: rest });
}
