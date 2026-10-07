import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/lib/i18n";

export function KagoEmptyState({ icon, title, description, className, children }: { icon?: ReactNode; title: string; description?: string; className?: string; children?: ReactNode }) {
  return (
    <div data-empty="" className={cn("flex flex-col items-center justify-center gap-1.5 px-6 py-10 text-center text-muted", className)}>
      {icon ? <span className="kago-badge mb-2 flex size-12 items-center justify-center rounded-full text-faint [&>.lucide]:size-5">{icon}</span> : null}
      <strong className="font-medium text-ink">{title}</strong>
      {description ? <span className="max-w-xs">{description}</span> : null}
      {children ? <div className="mt-2 flex flex-wrap justify-center gap-2">{children}</div> : null}
    </div>
  );
}

export function KagoSpinner({ className }: { className?: string }) {
  return <Loader2 className={cn("animate-spin text-muted", className)} aria-label={t("Loading")} />;
}

export function KagoLoading() {
  return (
    <div className="flex items-center justify-center p-10">
      <KagoSpinner className="size-5" />
    </div>
  );
}
