import { useEffect, useRef, useState } from "react";
import { Check, CircleHelp, Cpu, LoaderCircle, Monitor, Play, RefreshCw, X } from "lucide-react";
import { api } from "@/api/client";
import { Card, Page } from "@/components/kago/page";
import { Button } from "@/components/ui/button";
import { formatDate } from "@/lib/format";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { runBrowserCompatibility, type BrowserCompatibilityReport } from "./browserCompatibility";
import { compatibilityDetail } from "./compatibilityMessages";
import { groupServerChecks, type ServerCompatibilityCheck, type ServerCompatibilityReport } from "./serverCompatibility";

type CheckResult = {
  id: string;
  label: string;
  codec: string;
  operation: "encode" | "decode" | "playback";
  status: "passed" | "failed" | "unsupported" | "unavailable";
  detail: string;
  evidence?: "reported" | "tested";
  durationMs?: number | null;
};

const statusLabels = {
  passed: t("Test passed"),
  failed: t("Test failed"),
  unsupported: t("Not supported"),
  unavailable: t("Not tested")
};

/** A checkmark means either a completed test or a capability report; the words always say which. */
function Result({ check, compact = false }: { check?: CheckResult; compact?: boolean }) {
  const status = check?.status ?? "unavailable";
  const Icon = status === "passed" ? Check : status === "unavailable" ? CircleHelp : X;
  const label = status === "passed" && check?.evidence === "reported" ? t("Reported support") : statusLabels[status];
  const detail = check ? compatibilityDetail(check.detail) : undefined;
  return (
    <div className="flex flex-col gap-1">
      <span className={cn("flex items-center gap-1.5 font-medium", status === "passed" ? "text-success" : status === "failed" ? "text-danger" : "text-muted")}>
        <Icon aria-hidden="true" className="size-4 shrink-0" />
        {label}
      </span>
      {detail && !compact && status !== "passed" ? <span className="text-xs text-muted">{detail}</span> : null}
      {check?.durationMs != null ? <span className="text-xs text-faint tabular-nums">{t("{milliseconds} ms", { milliseconds: Math.round(check.durationMs) })}</span> : null}
    </div>
  );
}

function CodecMatrix({ checks, server = false }: { checks: Array<CheckResult & { backend?: string; deviceId?: string | null }>; server?: boolean }) {
  const rows = new Map<string, { label: string; encode?: CheckResult; decode?: CheckResult }>();
  for (const check of checks) {
    if (check.operation === "playback") continue;
    const key = JSON.stringify([check.backend, check.deviceId, check.codec]);
    const row = rows.get(key) ?? { label: server ? check.codec : check.label };
    row[check.operation] = check;
    rows.set(key, row);
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-left">
        <caption className="sr-only">{server ? t("Server encoding and decoding results") : t("Browser encoding and decoding results")}</caption>
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th scope="col" className="w-1/4 pr-3 pb-2 font-medium">{t("Format")}</th>
            <th scope="col" className="px-2 pb-2 font-medium">{t("Encoding")}</th>
            <th scope="col" className="pl-2 pb-2 font-medium">{t("Decoding")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {[...rows].map(([key, row]) => (
            <tr key={key}>
              <th scope="row" className="py-3 pr-3 align-top font-medium">
                {row.label}
              </th>
              <td className="px-2 py-3 align-top"><Result check={row.encode} /></td>
              <td className="py-3 pl-2 align-top"><Result check={row.decode} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ServerDeviceResults({ checks }: { checks: ServerCompatibilityCheck[] }) {
  return (
    <div className="flex flex-col gap-5">
      {groupServerChecks(checks).map(({ key, device, checks: deviceChecks }) => (
        <section key={key} aria-label={device.deviceLabel ?? device.backend} className="min-w-0">
          <h3 className="m-0 font-semibold">{device.deviceLabel ?? device.backend}</h3>
          {device.deviceLabel ? <p className="m-0 mt-0.5 text-xs text-muted">{device.backend}</p> : null}
          {device.deviceScope === "system" && device.backend === "Apple VideoToolbox" ? <p className="m-0 mt-0.5 text-xs text-muted">{t("System-selected device")}</p> : null}
          <div className="mt-3"><CodecMatrix checks={deviceChecks} server /></div>
        </section>
      ))}
    </div>
  );
}

function CapabilityFlag({ value }: { value: boolean | null | undefined }) {
  return <span className={value === true ? "text-success" : "text-muted"}>{value == null ? t("Unknown") : value ? t("Yes") : t("No")}</span>;
}

function PlaybackMatrix({ report }: { report: BrowserCompatibilityReport }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full table-fixed text-left">
        <caption className="sr-only">{t("Browser playback capability reports")}</caption>
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th scope="col" className="w-[35%] pr-3 pb-2 font-medium">{t("Format")}</th>
            <th scope="col" className="w-[35%] px-2 pb-2 font-medium">{t("Playback")}</th>
            <th scope="col" className="px-2 pb-2 font-medium">{t("Smooth")}</th>
            <th scope="col" className="pl-2 pb-2 font-medium">{t("Power efficient")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {report.checks.filter((check) => check.operation === "playback").map((check) => (
            <tr key={check.id}>
              <th scope="row" className="py-3 pr-3 align-top font-medium">{check.label}</th>
              <td className="px-2 py-3 align-top"><Result check={check} compact={check.status === "passed" || check.status === "unsupported"} /></td>
              <td className="px-2 py-3 align-top"><CapabilityFlag value={check.smooth} /></td>
              <td className="py-3 pl-2 align-top"><CapabilityFlag value={check.powerEfficient} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CheckedAt({ date }: { date: string }) {
  return <p className="m-0 mt-3 text-xs text-faint">{t("Last checked: {date}", { date: formatDate(Date.parse(date)) })}</p>;
}

/** Synthetic tests are started deliberately: opening Settings should not compete with a video playing. */
export function CompatibilityPage({ isAdmin }: { isAdmin: boolean }) {
  const [browser, setBrowser] = useState<BrowserCompatibilityReport | null>(null);
  const [server, setServer] = useState<ServerCompatibilityReport | null>(null);
  const [browserError, setBrowserError] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [browserRunning, setBrowserRunning] = useState(false);
  const [serverRunning, setServerRunning] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const browserRun = useRef<AbortController | null>(null);
  const serverRun = useRef<AbortController | null>(null);

  useEffect(() => () => {
    browserRun.current?.abort();
    serverRun.current?.abort();
  }, []);

  const checkBrowser = async () => {
    if (browserRun.current) return;
    const controller = new AbortController();
    browserRun.current = controller;
    setBrowserRunning(true);
    setBrowserError(false);
    setBrowser(null);
    setProgress({ completed: 0, total: 0 });
    try {
      const report = await runBrowserCompatibility(controller.signal, (completed, total) => {
        if (!controller.signal.aborted) setProgress({ completed, total });
      });
      if (!controller.signal.aborted) setBrowser(report);
    } catch {
      if (!controller.signal.aborted) setBrowserError(true);
    } finally {
      if (!controller.signal.aborted) setBrowserRunning(false);
      if (browserRun.current === controller) browserRun.current = null;
    }
  };

  const checkServer = async () => {
    if (!isAdmin || serverRun.current) return;
    const controller = new AbortController();
    serverRun.current = controller;
    setServerRunning(true);
    setServerError(null);
    setServer(null);
    try {
      const report = await api<ServerCompatibilityReport>("/api/compatibility/server", { method: "POST", signal: controller.signal });
      if (!controller.signal.aborted) setServer(report);
    } catch (error) {
      if (!controller.signal.aborted) setServerError(error instanceof Error ? error.message : t("Couldn’t check the server"));
    } finally {
      if (!controller.signal.aborted) setServerRunning(false);
      if (serverRun.current === controller) serverRun.current = null;
    }
  };

  const running = browserRunning || serverRunning;
  const serverPassed = server?.checks.filter((check) => check.hardware && check.status === "passed").length ?? 0;
  const browserPassed = browser?.checks.filter((check) => check.evidence === "tested" && check.status === "passed").length ?? 0;

  return (
    <Page title={t("Compatibility")} description={t("Check video encoding, decoding and playback on your server and in this browser.")}>
      <Card>
        <div className="flex flex-wrap items-start gap-4">
          <div className="min-w-48 flex-1">
            <h2 className="m-0 font-semibold">{t("Your media capabilities")}</h2>
          </div>
          <Button variant="default" disabled={running} onClick={() => { void checkBrowser(); void checkServer(); }}>
            {running ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : browser || server ? <RefreshCw aria-hidden="true" /> : <Play aria-hidden="true" />}
            {running ? t("Checking…") : browser || server ? t("Check again") : t("Run checks")}
          </Button>
        </div>
        <div className="mt-4 grid gap-4 border-t border-line pt-4 @sm:grid-cols-2" aria-live="polite" aria-atomic="true">
          <div className="flex items-start gap-2.5">
            <Cpu aria-hidden="true" className="mt-0.5 text-muted" />
            <div>
              <div className="font-medium">{t("Server graphics")}</div>
              <div className="mt-0.5 text-xs text-muted">{!isAdmin ? t("An administrator can run server checks.") : serverRunning ? t("Testing the server’s encoders and decoders…") : server ? t("{count} hardware checks passed", { count: serverPassed }) : serverError ? t("Server check failed") : t("Ready to check")}</div>
            </div>
          </div>
          <div className="flex items-start gap-2.5">
            <Monitor aria-hidden="true" className="mt-0.5 text-muted" />
            <div>
              <div className="font-medium">{t("This browser")}</div>
              <div className="mt-0.5 text-xs text-muted">{browserRunning ? progress.total ? t("Checking {completed} of {total}…", progress) : t("Checking…") : browser ? t("{count} codec tests passed", { count: browserPassed }) : browserError ? t("Browser check failed") : t("Ready to check")}</div>
            </div>
          </div>
        </div>
      </Card>

      <Card title={t("Server graphics")} action={isAdmin ? <Button disabled={serverRunning} onClick={() => void checkServer()}>{serverRunning ? t("Checking…") : t("Check server")}</Button> : undefined}>
        {!isAdmin ? <p className="m-0 text-muted">{t("An administrator can run server checks.")}</p> : serverError ? <p role="alert" className="m-0 text-danger">{serverError}</p> : server ? (
          <>
            <p className="m-0 mb-3 text-xs text-muted">{server.ffmpeg.available ? `FFmpeg ${server.ffmpeg.version ?? ""}` : t("FFmpeg is not available")}</p>
            {server.discoveryNotes?.map((note) => compatibilityDetail(note) ? <p key={note} className="m-0 mb-3 text-xs text-warning">{compatibilityDetail(note)}</p> : null)}
            <ServerDeviceResults checks={server.checks} />
            <CheckedAt date={server.checkedAt} />
          </>
        ) : <p className="m-0 text-muted" role="status">{serverRunning ? t("Testing the server’s encoders and decoders…") : t("Run a check to see hardware results and the CPU fallback.")}</p>}
      </Card>

      <Card title={t("Browser encoding and decoding")} action={<Button disabled={browserRunning} onClick={() => void checkBrowser()}>{browserRunning ? t("Checking…") : t("Check browser")}</Button>}>
        {browserError ? <p role="alert" className="m-0 text-danger">{t("Couldn’t check this browser. Try again.")}</p> : browser ? (
          <>
            {!browser.secureContext ? <p className="m-0 mb-3 text-warning">{t("Open Kago over HTTPS or localhost to enable WebCodecs checks.")}</p> : null}
            <CodecMatrix checks={browser.checks} />
            <CheckedAt date={browser.checkedAt} />
          </>
        ) : <p className="m-0 text-muted" role="status">{browserRunning ? t("Checking browser codecs…") : t("Run a check to see which codecs work in this browser.")}</p>}
      </Card>

      {browser ? (
        <Card title={t("Browser playback")}>
          <PlaybackMatrix report={browser} />
        </Card>
      ) : null}
    </Page>
  );
}
