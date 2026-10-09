import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Share2, X } from "lucide-react";
import { api } from "@/api/client";
import { useShares } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Card, Page, Row, RowList } from "@/components/kago/page";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { formatUnixDate } from "@/lib/format";
import { baseName, displayPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import type { Root, ShareLink } from "@/types/kago";
import { ShareForm } from "./ShareForm";
import { parseShareMode, shareModeLabel } from "./shareUtils";
import { t } from "@/lib/i18n";

function describe(share: ShareLink) {
  return [
    shareModeLabel(parseShareMode(share.permission_json)),
    share.max_downloads ? t("{count} of {max} downloads", { count: share.download_count, max: share.max_downloads }) : t("{count} download | {count} downloads", { count: share.download_count }),
    share.has_password ? t("Password protected") : null,
    share.expires_at ? t("Expires {date}", { date: formatUnixDate(share.expires_at) }) : null
  ].filter(Boolean).join(" · ");
}

export function SharesPage({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();
  const shares = useShares();
  const [creating, setCreating] = useState(false);
  const rootName = (rootId: string) => roots.find((root) => root.id === rootId)?.name ?? t("Removed location");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["shares"] });

  async function setDisabled(share: ShareLink, disabled: boolean) {
    await run(async () => {
      await api(`/api/shares/${share.id}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
      await refresh();
    });
  }

  async function remove(share: ShareLink) {
    if (!(await confirmAction({ title: t("Delete this share link?"), description: t("Links you’ve already sent stop working right away."), confirmLabel: t("Delete"), destructive: true }))) return;
    await run(async () => {
      await api(`/api/shares/${share.id}`, { method: "DELETE" });
      await refresh();
    });
  }

  return (
    <Page
      description={t("Public share links, with an optional expiry date, password and download limit.")}
      // An empty list offers the same button in its place, so there is only ever one.
      actions={shares.data?.length && roots.length > 0 && !creating ? <Button variant="default" onClick={() => setCreating(true)}><Plus />{t("Create share link")}</Button> : null}
    >
      {creating ? (
        <Card title={t("Create share link")} action={<KagoIconButton label={t("Close")} onClick={() => setCreating(false)}><X /></KagoIconButton>}>
          <ShareForm roots={roots} />
        </Card>
      ) : null}
      {shares.isLoading ? <KagoLoading /> : null}
      {shares.data?.length === 0 && !creating ? (
        <KagoEmptyState icon={<Share2 />} title={t("No share links yet")} description={t("Create one here, or share straight from a file’s info panel.")}>
          {roots.length > 0 ? <Button variant="default" onClick={() => setCreating(true)}><Plus />{t("Create share link")}</Button> : null}
        </KagoEmptyState>
      ) : null}
      {shares.data?.length ? (
        <RowList>
          {shares.data.map((share) => (
            <Row
              key={share.id}
              icon={<KagoStatusIcon tone={share.disabled ? "neutral" : "success"} label={share.disabled ? t("Disabled") : t("Active")}><Share2 /></KagoStatusIcon>}
              title={baseName(share.path) || rootName(share.root_id)}
              // A link that is switched off says so in words as well: it is the one that needs noticing.
              subtitle={`${share.disabled ? `${t("Disabled")} · ` : ""}${displayPath(rootName(share.root_id), share.path)} · ${describe(share)}`}
            >
              <Button onClick={() => void setDisabled(share, !share.disabled)}>{share.disabled ? t("Enable") : t("Disable")}</Button>
              <Button variant="destructive" onClick={() => void remove(share)}>{t("Delete")}</Button>
            </Row>
          ))}
        </RowList>
      ) : null}
    </Page>
  );
}
