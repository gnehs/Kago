import { useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { api } from "@/api/client";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Page, Row, RowList } from "@/features/workspace/Page";
import { run } from "@/lib/run";
import type { Root } from "@/types/kago";
import { t } from "@/lib/i18n";

export function LocationsPage({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();

  async function setRootReadonly(root: Root, next: boolean) {
    await run(async () => {
      await api(`/api/roots/${root.id}`, { method: "PATCH", body: JSON.stringify({ readonly: next }) });
      await Promise.all(["roots", "fs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    });
  }

  return (
    <Page title={t("Locations")} description={t("Every folder mounted under /data becomes a location and appears on the desktop.")}>
      {roots.length > 0 ? (
        <RowList>
          {roots.map((root) => (
            <Row key={root.id} icon={<HardDrive />} title={root.name} subtitle={root.slug}>
              {root.readonly ? <KagoBadge>{t("Read-only")}</KagoBadge> : null}
              <Button onClick={() => void setRootReadonly(root, !root.readonly)}>{root.readonly ? t("Allow writing") : t("Make read-only")}</Button>
            </Row>
          ))}
        </RowList>
      ) : (
        <KagoEmptyState icon={<HardDrive />} title={t("No locations yet")} description={t("Create or mount a folder under /data and it will show up here.")} />
      )}
    </Page>
  );
}
