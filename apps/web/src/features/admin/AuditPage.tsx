import { ScrollText } from "lucide-react";
import { useAudit, useRoots } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Page } from "@/features/workspace/Page";
import { formatUnixDate } from "@/lib/format";
import { displayPath } from "@/lib/paths";
import type { AuditLog } from "@/types/kago";
import { t } from "@/lib/i18n";

const results: Record<AuditLog["result"], { label: string; tone: "success" | "danger" | "warning" }> = {
  success: { label: t("Success"), tone: "success" },
  failure: { label: t("Failed"), tone: "danger" },
  denied: { label: t("Denied"), tone: "warning" }
};

function target(log: AuditLog, rootName?: string) {
  if (log.path) return rootName ? displayPath(rootName, log.path) : log.path;
  if (!log.target_json) return "—";
  try {
    const [first] = Object.entries(JSON.parse(log.target_json) as Record<string, unknown>);
    return first ? `${first[0]}: ${String(first[1])}` : "—";
  } catch {
    return log.target_json;
  }
}

export function AuditPage() {
  const audit = useAudit();
  const roots = useRoots().data;
  const describe = (log: AuditLog) => target(log, roots?.find((root) => root.id === log.root_id)?.name);
  return (
    <Page title={t("Audit log")} description={t("Sign-ins, file operations, shares and permission changes, including attempts that failed or were denied.")}>
      {audit.isLoading ? <KagoLoading /> : null}
      {audit.data?.length === 0 ? <KagoEmptyState icon={<ScrollText />} title={t("No audit entries yet")} /> : null}
      {audit.data?.length ? (
        <div className="kago-card overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-elevated/60 text-left text-xs whitespace-nowrap text-muted">
                <th className="px-3 py-2 font-medium">{t("Time")}</th>
                <th className="px-3 py-2 font-medium">{t("Action")}</th>
                <th className="px-3 py-2 font-medium">{t("Target")}</th>
                <th className="px-3 py-2 font-medium">{t("Source")}</th>
                <th className="px-3 py-2 font-medium">{t("Result")}</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((log) => (
                <tr key={log.id} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap text-muted tabular-nums">{formatUnixDate(log.created_at)}</td>
                  <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{log.action}</td>
                  <td className="max-w-64 truncate px-3 py-2 text-muted" title={describe(log)}>{describe(log)}</td>
                  <td className="px-3 py-2 whitespace-nowrap text-muted">{log.actor_type === "user" ? t("User") : log.actor_type === "share_link" ? t("Share link") : t("System")}</td>
                  <td className="px-3 py-2"><KagoBadge tone={results[log.result].tone}>{results[log.result].label}</KagoBadge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </Page>
  );
}
