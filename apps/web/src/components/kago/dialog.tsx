import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { settleDialog, useDialogStore } from "@/stores/dialogs";
import { t } from "@/lib/i18n";

export function KagoDialog({ open, onClose, title, question, className, children }: { open: boolean; onClose: () => void; title: ReactNode; /** It asks one thing and waits for the answer: the title is centred over a rule, as on a form. */ question?: boolean; className?: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="kago-backdrop fixed inset-0 z-[900] bg-overlay" />
        <Dialog.Popup className={cn("kago-dialog fixed top-1/2 left-1/2 z-[900] flex max-h-[calc(100vh-48px)] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-surface shadow-window-active ring-1 ring-(--kago-window-edge) outline-none", className)}>
          {question ? (
            <header className="shrink-0 px-5 pt-4">
              <Dialog.Title className="m-0 text-center text-sm font-semibold text-balance">{title}</Dialog.Title>
              <div className="mt-3 h-px bg-line-strong" />
            </header>
          ) : (
            <Dialog.Title className="m-0 px-4 pt-4 text-sm font-semibold">{title}</Dialog.Title>
          )}
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The buttons at the foot of a dialog, at its far end: the way out first, what the dialog is for last. */
export function KagoDialogActions({ children }: { children: ReactNode }) {
  return <div className="flex justify-end gap-2 pt-1">{children}</div>;
}

/** Renders the prompt/confirm dialogs requested through `promptText` and `confirmAction`. */
export function KagoDialogHost() {
  const pending = useDialogStore((state) => state.request);
  // The last request stays on show while its dialog fades out.
  const [request, setRequest] = useState(pending);
  const [value, setValue] = useState("");

  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pending) return;
    setRequest(pending);
    setValue(pending.input?.defaultValue ?? "");
    // The suggested text is selected, ready to be typed over, once the field is there and holds it.
    const frame = requestAnimationFrame(() => input.current?.select());
    return () => cancelAnimationFrame(frame);
  }, [pending]);

  if (!request) return null;
  const canSubmit = !request.input || value.trim().length > 0;

  return (
    <KagoDialog question open={Boolean(pending)} onClose={() => settleDialog(null)} title={request.title}>
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) settleDialog(request.input ? value.trim() : "");
        }}
      >
        <div className="flex min-h-0 flex-col items-center gap-3 overflow-y-auto px-6 py-5 text-center">
          {/* What is asked about stands there as itself, the way it does on the desktop: its icon, and its name under it. */}
          {request.subject ? (
            <div className="flex max-w-full flex-col items-center">
              <span className="mb-2.5 flex size-12 shrink-0 items-center justify-center">{request.subject.icon}</span>
              <strong className="max-w-full truncate font-semibold">{request.subject.name}</strong>
              {request.subject.detail ? <span className="max-w-full truncate text-xs text-muted">{request.subject.detail}</span> : null}
            </div>
          ) : null}
          {request.description ? <p className="m-0 max-w-xs text-muted text-pretty">{request.description}</p> : null}
          {request.input ? (
            <Input ref={input} autoFocus value={value} placeholder={request.input.placeholder} onChange={(event) => setValue(event.target.value)} />
          ) : null}
        </div>
        {/* The two answers, side by side and as wide as each other, on a strip of their own: the way out first, what the dialog is for last. */}
        <footer className="grid shrink-0 grid-cols-2 gap-2 rounded-b-lg border-t border-line bg-elevated p-3">
          <Button size="lg" onClick={() => settleDialog(null)}>{t("Cancel")}</Button>
          <Button size="lg" type="submit" variant={request.destructive ? "destructive-primary" : "default"} disabled={!canSubmit} autoFocus={!request.input}>
            {request.confirmLabel ?? t("OK")}
          </Button>
        </footer>
      </form>
    </KagoDialog>
  );
}
