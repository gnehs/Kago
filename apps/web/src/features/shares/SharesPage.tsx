import { useQueryClient } from "@tanstack/react-query";
import { Share2 } from "lucide-react";
import { api } from "@/api/client";
import { useShares } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Card, Page, Row, RowList } from "@/features/workspace/Page";
import { formatUnixDate } from "@/lib/format";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import type { Root, ShareLink } from "@/types/kago";
import { ShareForm } from "./ShareForm";
import { parseShareMode, shareModeLabel } from "./shareUtils";

function describe(share: ShareLink) {
  return [
    shareModeLabel(parseShareMode(share.permission_json)),
    `已下載 ${share.download_count}${share.max_downloads ? ` / ${share.max_downloads}` : ""} 次`,
    share.has_password ? "有密碼" : null,
    share.expires_at ? `${formatUnixDate(share.expires_at)} 到期` : null
  ].filter(Boolean).join(" · ");
}

export function SharesPage({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();
  const shares = useShares();
  const rootSlug = (rootId: string) => roots.find((root) => root.id === rootId)?.slug ?? "已移除的位置";
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["shares"] });

  async function setDisabled(share: ShareLink, disabled: boolean) {
    await run(async () => {
      await api(`/api/shares/${share.id}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
      await refresh();
    });
  }

  async function remove(share: ShareLink) {
    if (!(await confirmAction({ title: "刪除這個分享連結？", description: "已經發出去的連結會立刻失效。", confirmLabel: "刪除", destructive: true }))) return;
    await run(async () => {
      await api(`/api/shares/${share.id}`, { method: "DELETE" });
      await refresh();
    });
  }

  return (
    <Page title="分享" description="公開分享連結可以設定到期日、密碼與下載次數。也可以在檔案的資訊面板直接建立。">
      {roots.length > 0 ? (
        <Card title="建立分享連結">
          <ShareForm roots={roots} />
        </Card>
      ) : null}
      {shares.isLoading ? <KagoLoading /> : null}
      {shares.data?.length === 0 ? <KagoEmptyState icon={<Share2 />} title="還沒有分享連結" /> : null}
      {shares.data?.length ? (
        <RowList>
          {shares.data.map((share) => (
            <Row key={share.id} icon={<Share2 />} title={`${rootSlug(share.root_id)}:${share.path}`} subtitle={describe(share)}>
              <KagoBadge tone={share.disabled ? "neutral" : "success"}>{share.disabled ? "已停用" : "啟用中"}</KagoBadge>
              <Button onClick={() => void setDisabled(share, !share.disabled)}>{share.disabled ? "啟用" : "停用"}</Button>
              <Button variant="destructive" onClick={() => void remove(share)}>刪除</Button>
            </Row>
          ))}
        </RowList>
      ) : null}
    </Page>
  );
}
