import { ScrollText } from "lucide-react";
import { useAudit } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Page } from "@/features/workspace/Page";
import { formatUnixDate } from "@/lib/format";
import type { AuditLog } from "@/types/kago";

const results: Record<AuditLog["result"], { label: string; tone: "success" | "danger" | "warning" }> = {
  success: { label: "成功", tone: "success" },
  failure: { label: "失敗", tone: "danger" },
  denied: { label: "拒絕", tone: "warning" }
};

function target(log: AuditLog) {
  if (log.path) return log.path;
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
  return (
    <Page title="稽核紀錄" description="登入、檔案操作、分享與權限變更，包含失敗與被拒絕的嘗試。">
      {audit.isLoading ? <KagoLoading /> : null}
      {audit.data?.length === 0 ? <KagoEmptyState icon={<ScrollText />} title="目前沒有稽核紀錄" /> : null}
      {audit.data?.length ? (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse">
            <thead>
              <tr className="bg-elevated text-left text-xs text-muted">
                <th className="px-3 py-2 font-medium">時間</th>
                <th className="px-3 py-2 font-medium">動作</th>
                <th className="px-3 py-2 font-medium">對象</th>
                <th className="px-3 py-2 font-medium">來源</th>
                <th className="px-3 py-2 font-medium">結果</th>
              </tr>
            </thead>
            <tbody>
              {audit.data.map((log) => (
                <tr key={log.id} className="border-t border-line">
                  <td className="px-3 py-2 whitespace-nowrap text-muted tabular-nums">{formatUnixDate(log.created_at)}</td>
                  <td className="px-3 py-2 font-medium">{log.action}</td>
                  <td className="max-w-64 truncate px-3 py-2 text-muted" title={target(log)}>{target(log)}</td>
                  <td className="px-3 py-2 text-muted">{log.actor_type === "user" ? "使用者" : log.actor_type === "share_link" ? "分享連結" : "系統"}</td>
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
