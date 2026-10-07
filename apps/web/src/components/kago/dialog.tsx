import { useEffect, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { settleDialog, useDialogStore } from "@/stores/dialogs";

export function KagoDialog({ open, onClose, title, className, children }: { open: boolean; onClose: () => void; title: ReactNode; className?: string; children: ReactNode }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[900] bg-overlay" />
        <Dialog.Popup className={cn("fixed top-1/2 left-1/2 z-[900] flex max-h-[calc(100vh-48px)] w-[min(420px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-surface shadow-window-active ring-1 ring-(--kago-window-edge) outline-none", className)}>
          <Dialog.Title className="m-0 px-4 pt-4 text-sm font-semibold">{title}</Dialog.Title>
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Renders the prompt/confirm dialogs requested through `promptText` and `confirmAction`. */
export function KagoDialogHost() {
  const request = useDialogStore((state) => state.request);
  const [value, setValue] = useState("");

  useEffect(() => {
    setValue(request?.input?.defaultValue ?? "");
  }, [request]);

  if (!request) return null;
  const canSubmit = !request.input || value.trim().length > 0;

  return (
    <KagoDialog open onClose={() => settleDialog(null)} title={request.title}>
      <form
        className="flex flex-col gap-3 p-4 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) settleDialog(request.input ? value.trim() : "");
        }}
      >
        {request.description ? <p className="m-0 text-muted">{request.description}</p> : null}
        {request.input ? (
          <Input autoFocus value={value} placeholder={request.input.placeholder} onChange={(event) => setValue(event.target.value)} onFocus={(event) => event.target.select()} />
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={() => settleDialog(null)}>取消</Button>
          <Button type="submit" variant={request.destructive ? "destructive" : "default"} disabled={!canSubmit} autoFocus={!request.input}>
            {request.confirmLabel ?? "確定"}
          </Button>
        </div>
      </form>
    </KagoDialog>
  );
}
