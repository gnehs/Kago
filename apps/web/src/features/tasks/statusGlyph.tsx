import { Ban, Check, Clock, Pause, RefreshCw, X } from "lucide-react";

/** The glyph for how a run ended, or for the run it is in the middle of: what a `KagoStatusIcon` of a sync or an auto-convert holds. */
export function statusGlyph(status: string | null) {
  if (status === "done") return <Check />;
  if (status === "running") return <RefreshCw className="animate-spin" />;
  if (status === "queued") return <Clock />;
  if (status === "paused") return <Pause />;
  if (status === "cancelling" || status === "cancelled") return <Ban />;
  if (status === "failed" || status === "interrupted") return <X />;
  return <RefreshCw />;
}
