import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { holdWindow, WindowScope } from "@/components/kago/window-scope";
import { cn } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import { useShallow } from "zustand/react/shallow";
import { ALTERNATIVE, settleDialog, useDialogStore } from "@/stores/dialogs";
import { t } from "@/lib/i18n";

/**
 * A dialog belongs to the window it was opened from, and is drawn in it: it dims that window only, below its title bar,
 * and moves and minimizes with it, while the other windows go on working. One opened from no window covers the page.
 * Inside a window that is known from where it is drawn; a dialog drawn from a host outside the windows is told by `scope`.
 */
export function KagoDialog({ open, onClose, title, question, scope, onGone, className, children }: { open: boolean; onClose: () => void; title: ReactNode; /** It asks one thing and waits for the answer: the title is centred over a rule, as on a form. */ question?: boolean; /** The window it belongs to, when it is not drawn inside it; null for the page. */ scope?: string | null; /** Called once it has closed and faded out. */ onGone?: () => void; className?: string; children: ReactNode }) {
  const inherited = useContext(WindowScope);
  const windowId = scope === undefined ? inherited : scope;
  const frame = useWorkspaceStore((state) => (windowId === null ? null : [...state.windows, ...state.appWindows, ...state.previewWindows].find((window) => window.id === windowId)));
  const gone = windowId !== null && !frame;
  const [element, setElement] = useState<HTMLElement | null>(null);
  // The window's own element is there only once it has been drawn, and is drawn again after it was minimized.
  useLayoutEffect(() => {
    setElement(windowId === null ? null : document.querySelector<HTMLElement>(`section[data-window="${CSS.escape(windowId)}"]`));
  }, [windowId, frame?.minimized]);
  // A question for a window that was closed has no one left to answer it.
  useEffect(() => {
    if (open && gone) onClose();
  }, [open, gone, onClose]);
  useEffect(() => (open && windowId !== null ? holdWindow(windowId) : undefined), [open, windowId]);

  const body = (
    <>
      {question ? (
        <header className="shrink-0 px-5 pt-4">
          <Dialog.Title className="m-0 text-center text-sm font-semibold text-balance">{title}</Dialog.Title>
          <div className="mt-3 h-px bg-line-strong" />
        </header>
      ) : (
        <Dialog.Title className="m-0 px-4 pt-4 text-sm font-semibold">{title}</Dialog.Title>
      )}
      {children}
    </>
  );
  const popup = "kago-dialog flex w-[min(420px,calc(100%-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg bg-surface shadow-window-active ring-1 ring-(--kago-window-edge) outline-none";

  if (windowId === null) {
    return (
      <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()} onOpenChangeComplete={(next) => !next && onGone?.()}>
        <Dialog.Portal>
          <Dialog.Backdrop className="kago-backdrop fixed inset-0 z-[900] bg-overlay" />
          <Dialog.Popup className={cn(popup, "fixed top-1/2 left-1/2 z-[900] max-h-[calc(100%-48px)]", className)}>{body}</Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    );
  }
  if (!element || gone) return null;
  return (
    // Not modal: the rest of the page stays usable. The window itself is held by `holdWindow`, and dims under the backdrop.
    <Dialog.Root
      open={open}
      modal={false}
      disablePointerDismissal
      onOpenChangeComplete={(next) => !next && onGone?.()}
      onOpenChange={(next, details) => {
        if (next) return;
        // Escape typed in another window is that window's.
        if (details.reason === "escape-key" && !(details.event.target instanceof Node && element.contains(details.event.target))) return;
        onClose();
      }}
    >
      <Dialog.Portal container={element}>
        <Dialog.Backdrop className="kago-backdrop absolute inset-x-0 top-9 bottom-0 z-20 bg-overlay" onClick={onClose} />
        <Dialog.Popup className={cn(popup, "absolute top-[calc(50%+18px)] left-1/2 z-30 max-h-[calc(100%-36px-32px)]", className)}>{body}</Dialog.Popup>
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
  const scopes = useDialogStore(useShallow((state) => Object.keys(state.requests)));
  // A scope stays drawn a moment after its question is settled, so the dialog can fade out.
  const [shown, setShown] = useState<string[]>([]);
  useEffect(() => setShown((before) => [...new Set([...before, ...scopes])]), [scopes]);
  return shown.map((scope) => <QuestionDialog key={scope} scope={scope} onGone={() => setShown((before) => before.filter((item) => item !== scope))} />);
}

function QuestionDialog({ scope, onGone }: { scope: string; onGone: () => void }) {
  const pending = useDialogStore((state) => state.requests[scope] ?? null);
  // The last request stays on show while its dialog fades out.
  const [request, setRequest] = useState(pending);
  const [value, setValue] = useState("");

  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!pending) return;
    setRequest(pending);
    setValue(pending.input?.defaultValue ?? "");
    // The suggested text is selected, ready to be typed over, once the field is there and holds it.
    const selectEnd = pending.input?.selectEnd;
    const frame = requestAnimationFrame(() => (selectEnd === undefined ? input.current?.select() : input.current?.setSelectionRange(0, selectEnd)));
    return () => cancelAnimationFrame(frame);
  }, [pending]);

  if (!request) return null;
  const canSubmit = !request.input || value.trim().length > 0;

  return (
    <KagoDialog question scope={scope || null} open={Boolean(pending)} onClose={() => settleDialog(scope, null)} onGone={onGone} title={request.title}>
      <form
        className="flex min-h-0 flex-col"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSubmit) settleDialog(scope, request.input ? value.trim() : "");
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
        {/* The two answers, side by side and as wide as each other, on a strip of their own: the way out first, what the dialog is for last. Three are too many for one row, and stand under each other. */}
        <footer className={cn("grid shrink-0 gap-2 rounded-b-lg border-t border-line bg-elevated p-3", request.alternative ? "grid-cols-1" : "grid-cols-2")}>
          <Button size="lg" onClick={() => settleDialog(scope, null)}>{t("Cancel")}</Button>
          {request.alternative ? (
            <Button size="lg" variant={request.alternative.destructive ? "destructive" : "outline"} onClick={() => settleDialog(scope, ALTERNATIVE)}>{request.alternative.label}</Button>
          ) : null}
          <Button size="lg" type="submit" variant={request.destructive ? "destructive-primary" : "default"} disabled={!canSubmit} autoFocus={!request.input}>
            {request.confirmLabel ?? t("OK")}
          </Button>
        </footer>
      </form>
    </KagoDialog>
  );
}
