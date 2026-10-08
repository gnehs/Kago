import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { settleDialog, useDialogStore } from "@/stores/dialogs";
import { t } from "@/lib/i18n";

export function KagoDialog({ open, onClose, title, className, children }: { open: boolean; onClose: () => void; title: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="kago-backdrop fixed inset-0 z-[900] bg-overlay" />
        <Dialog.Popup className={cn("kago-dialog fixed top-1/2 left-1/2 z-[900] flex max-h-[calc(100vh-48px)] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-surface shadow-window-active ring-1 ring-(--kago-window-edge) outline-none", className)}>
          <Dialog.Title className="m-0 px-4 pt-4 text-sm font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
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
    <KagoDialog open={Boolean(pending)} onClose={() => settleDialog(null)} title={request.title}>
      <form
        className="flex flex-col gap-3 p-4 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) settleDialog(request.input ? value.trim() : "");
        }}
      >
        {request.description ? <p className="m-0 text-muted">{request.description}</p> : null}
        {request.input ? (
          <Input ref={input} autoFocus value={value} placeholder={request.input.placeholder} onChange={(event) => setValue(event.target.value)} />
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => settleDialog(null)}>{t("Cancel")}</Button>
          <Button type="submit" variant={request.destructive ? "destructive-primary" : "default"} disabled={!canSubmit} autoFocus={!request.input}>
            {request.confirmLabel ?? t("OK")}
          </Button>
        </div>
      </form>
    </KagoDialog>
  );
}
