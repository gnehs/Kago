import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, LoaderCircle, Minus, Play, RefreshCw, TriangleAlert, X } from "lucide-react";
import { api } from "@/api/client";
import { Card, Page } from "@/components/kago/page";
import { KagoTooltip } from "@/components/kago/tooltip";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { canPlayHdrStream, directPlaySupport } from "@/features/files/videoCapabilities";
import { compatibilityDetail } from "./compatibilityMessages";
import { summarizeServerChecks, type ServerCompatibilityCheck, type ServerCompatibilityReport } from "./serverCompatibility";

type Tone = "success" | "warning" | "danger" | "muted";

const tones: Record<Tone, string> = { success: "text-success", warning: "text-warning", danger: "text-danger", muted: "text-muted" };
const icons: Record<Tone, typeof Check> = { success: Check, warning: TriangleAlert, danger: X, muted: Minus };

/** One answer in a table. With `text` the words stand beside the mark; without, they are kept for whoever cannot see it. */
function Mark({ tone, label, text, hint }: { tone: Tone; label: string; text?: boolean; hint?: string }) {
  const Icon = icons[tone];
  const mark = (
    <span className={cn("inline-flex items-center gap-1.5", tones[tone])}>
      <Icon aria-hidden="true" className="size-4 shrink-0" />
      <span className={text ? undefined : "sr-only"}>{label}</span>
      {hint ? <span className="sr-only">{hint}</span> : null}
    </span>
  );
  return hint || !text ? <KagoTooltip label={hint ?? label}>{mark}</KagoTooltip> : mark;
}

/** What the card found, in a sentence, ahead of the table that backs it. */
function Verdict({ tone, children }: { tone: Tone; children: ReactNode }) {
  const Icon = icons[tone];
  return (
    <p className="m-0 mb-4 flex items-start gap-2 font-medium">
      <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", tones[tone])} />
      {children}
    </p>
  );
}

function Waiting({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="m-0 flex items-center gap-2 text-muted">
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />
      {children}
    </p>
  );
}

const headCell = "pb-2 font-medium";
const cell = "py-2.5 align-top";

function codecMark(check: ServerCompatibilityCheck | undefined) {
  if (!check) return <Mark tone="muted" label={t("Not tested")} />;
  if (check.status === "passed") return <Mark tone="success" label={t("Works")} hint={check.durationMs != null ? t("{milliseconds} ms", { milliseconds: Math.round(check.durationMs) }) : undefined} />;
  const detail = compatibilityDetail(check.detail);
  if (check.status === "failed") return <Mark tone="danger" label={t("Failed")} hint={detail} />;
  return <Mark tone="muted" label={check.status === "unsupported" ? t("Not supported") : t("Not tested")} hint={detail} />;
}

function ServerResults({ report }: { report: ServerCompatibilityReport }) {
  const { codecs, devices, missing, hardware, software } = summarizeServerChecks(report.checks);
  const notes = [...new Set(report.discoveryNotes?.map(compatibilityDetail).filter((note) => note != null))];

  return (
    <>
      {!report.ffmpeg.available ? <Verdict tone="danger">{t("FFmpeg is missing, so video can’t be transcoded.")}</Verdict>
        : hardware.length ? <Verdict tone="success">{t("{devices} can transcode video in hardware.", { devices: hardware.join(t(", ")) })}</Verdict>
        : software ? <Verdict tone="warning">{t("No hardware acceleration here. Video is transcoded on the CPU.")}</Verdict>
        : <Verdict tone="danger">{t("This server can’t transcode video.")}</Verdict>}
      {devices.length ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">{t("What each device on the server encodes and decodes")}</caption>
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" rowSpan={2} className={cn(headCell, "border-b border-line pr-3 align-bottom")}>{t("Device")}</th>
                {codecs.map((codec) => <th key={codec} scope="colgroup" colSpan={2} className="px-2 pb-1 font-medium text-ink">{codec}</th>)}
              </tr>
              <tr className="border-b border-line">
                {codecs.map((codec) => [
                  <th key={codec + "encode"} scope="col" className={cn(headCell, "w-16 px-2")}>{t("Encode")}</th>,
                  <th key={codec + "decode"} scope="col" className={cn(headCell, "w-16 px-2")}>{t("Decode")}</th>
                ])}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {devices.map((device) => (
                <tr key={device.key}>
                  <th scope="row" className={cn(cell, "pr-3 font-normal")}>
                    <div className="font-medium">{device.name}</div>
                    <div className="text-xs text-muted">{device.hardware ? device.backend ?? t("Hardware##transcoding") : t("Software##transcoding")}</div>
                    {device.problems.map((problem) => (
                      <div key={problem.id} className="mt-1 text-xs text-danger">
                        {t("{subject}: {reason}", { subject: `${problem.codec} ${problem.operation === "encode" ? t("Encode") : t("Decode")}`, reason: compatibilityDetail(problem.detail) ?? t("Failed") })}
                      </div>
                    ))}
                  </th>
                  {codecs.map((codec) => [
                    <td key={codec + "encode"} className={cn(cell, "px-2")}>{codecMark(device.checks.get(codec + " encode"))}</td>,
                    <td key={codec + "decode"} className={cn(cell, "px-2")}>{codecMark(device.checks.get(codec + " decode"))}</td>
                  ])}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {missing.length ? <p className="m-0 mt-3 text-xs text-muted">{t("Not on this server: {backends}", { backends: missing.join(t(", ")) })}</p> : null}
      {notes.map((note) => <p key={note} className="m-0 mt-1 text-xs text-warning">{note}</p>)}
      <TestedAt date={report.checkedAt} />
    </>
  );
}

function playMark(plays: boolean | null) {
  if (plays == null) return <span aria-hidden="true" className="text-faint">—</span>;
  return plays ? <Mark text tone="success" label={t("Plays as is")} /> : <Mark text tone="muted" label={t("Transcoded")} />;
}

/** Nothing here is measured: these are the answers the player itself goes by when it opens a video. */
function BrowserResults() {
  const { video, audio } = useMemo(() => directPlaySupport(), []);
  const hdr = useMemo(() => canPlayHdrStream(), []);
  const playable = video.filter((format) => format.eightBit);

  return (
    <>
      {playable.length === video.length ? <Verdict tone="success">{t("Plays every common video format as is.")}</Verdict>
        : playable.length ? <Verdict tone="success">{t("Plays {formats} as is. The server transcodes the rest.", { formats: playable.map((format) => format.label).join(t(", ")) })}</Verdict>
        : <Verdict tone="warning">{t("Plays no common video format as is. The server transcodes everything.")}</Verdict>}
      <div className="overflow-x-auto">
        <table className="w-full table-fixed text-left">
          <caption className="sr-only">{t("What this browser plays as is")}</caption>
          <thead className="text-xs text-muted">
            <tr className="border-b border-line">
              <th scope="col" className={cn(headCell, "pr-3")}>{t("Format")}</th>
              <th scope="col" className={cn(headCell, "px-2")}>{t("8-bit")}</th>
              <th scope="col" className={cn(headCell, "px-2")}>{t("10-bit")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {video.map((format) => (
              <tr key={format.id}>
                <th scope="row" className={cn(cell, "pr-3 font-medium")}>{format.label}</th>
                <td className={cn(cell, "px-2")}>{playMark(format.eightBit)}</td>
                <td className={cn(cell, "px-2")}>{playMark(format.tenBit)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-4 gap-y-2 border-t border-line pt-2.5">
        <dt className="text-xs font-medium text-muted">{t("Audio")}</dt>
        <dd className="m-0 flex flex-wrap gap-x-4 gap-y-1">
          {audio.map((codec) => (
            <span key={codec.id} className="flex items-center gap-1.5">
              {codec.label}
              <Mark tone={codec.plays ? "success" : "muted"} label={codec.plays ? t("Plays as is") : t("Transcoded")} />
            </span>
          ))}
        </dd>
        <dt className="text-xs font-medium text-muted">HDR</dt>
        <dd className="m-0">{hdr ? <Mark text tone="success" label={t("Transcoded video stays HDR")} /> : <Mark text tone="muted" label={t("Transcoded video becomes SDR")} />}</dd>
      </dl>
    </>
  );
}

function TestedAt({ date }: { date: string }) {
  return <p className="m-0 mt-3 text-xs text-faint">{t("Tested {date}", { date: formatDate(Date.parse(date)) })}</p>;
}

/** The server's test is started deliberately: opening Settings should not compete with a video being transcoded. */
export function CompatibilityPage({ isAdmin }: { isAdmin: boolean }) {
  const [server, setServer] = useState<ServerCompatibilityReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const run = useRef<AbortController | null>(null);

  useEffect(() => () => run.current?.abort(), []);

  const test = async () => {
    if (run.current) return;
    const controller = new AbortController();
    run.current = controller;
    setRunning(true);
    setError(null);
    setServer(null);
    try {
      const report = await api<ServerCompatibilityReport>("/api/compatibility/server", { method: "POST", signal: controller.signal });
      if (!controller.signal.aborted) setServer(report);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : t("Couldn’t test the server"));
    } finally {
      if (!controller.signal.aborted) setRunning(false);
      if (run.current === controller) run.current = null;
    }
  };

  const tested = server != null || error != null;

  return (
    <Page
      title={t("Transcoding test")}
      description={isAdmin ? t("See what video the server can transcode, and what this browser plays as is.") : t("See what video this browser plays as is.")}
      actions={isAdmin ? (
        <Button variant={tested || running ? "outline" : "default"} disabled={running} onClick={() => void test()}>
          {running ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : tested ? <RefreshCw aria-hidden="true" /> : <Play aria-hidden="true" />}
          {running ? t("Testing…") : tested ? t("Run again") : t("Test the server")}
        </Button>
      ) : undefined}
    >
      {isAdmin ? (
        <Card title={t("Server")} description={server?.ffmpeg.version ? `FFmpeg ${server.ffmpeg.version}` : undefined}>
          {running ? <Waiting>{t("Transcoding a test clip on every device…")}</Waiting>
            : error ? <p role="alert" className="m-0 text-danger">{error}</p>
            : server ? <ServerResults report={server} />
            : <p className="m-0 text-muted">{t("Not tested yet. Every device on the server encodes and decodes a short generated clip, which takes a few seconds.")}</p>}
        </Card>
      ) : null}
      <Card title={t("This browser")}>
        <BrowserResults />
      </Card>
      {!isAdmin ? <p className="m-0 text-xs text-muted">{t("Only an administrator can test the server.")}</p> : null}
    </Page>
  );
}
