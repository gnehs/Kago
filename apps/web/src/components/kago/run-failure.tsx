import { failureTextOf } from "@/lib/runText";
import type { RunFailureCode } from "@kago/contract";
import { KagoCopyField } from "./copy-field";

/**
 * What to do about a failure, under the line that says what went wrong, and the technical line behind it (what ffmpeg
 * or rclone said, cleared of paths) for a person to copy into a search or a bug report. Neither is drawn where there
 * is none.
 */
export function KagoFailureHelp({ code, detail }: { code: RunFailureCode | null; detail: string | null }) {
  const { advice } = failureTextOf(code);
  if (!advice && !detail) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {advice ? <span className="text-xs text-muted">{advice}</span> : null}
      {detail ? <KagoCopyField wrap value={detail} /> : null}
    </div>
  );
}
