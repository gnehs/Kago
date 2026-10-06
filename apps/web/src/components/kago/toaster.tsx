import { CircleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToastStore } from "@/stores/toast";

export function KagoToaster() {
  const { toasts, dismiss } = useToastStore();
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[1000] flex -translate-x-1/2 flex-col items-center gap-2" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={cn("pointer-events-auto flex max-w-md items-center gap-2 rounded-md bg-surface py-1.5 pr-1.5 pl-3 shadow-popup", toast.kind === "error" && "text-danger")}>
          {toast.kind === "error" ? <CircleAlert /> : null}
          <span>{toast.message}</span>
          <button className="rounded-sm p-1 text-muted hover:bg-hover" aria-label="關閉通知" onClick={() => dismiss(toast.id)}>
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}
