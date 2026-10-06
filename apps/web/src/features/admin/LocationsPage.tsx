import { useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { api } from "@/api/client";
import { KagoBadge } from "@/components/kago/badge";
import { KagoEmptyState } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Page, Row, RowList } from "@/features/workspace/Page";
import { run } from "@/lib/run";
import type { Root } from "@/types/kago";

export function LocationsPage({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();

  async function setRootReadonly(root: Root, next: boolean) {
    await run(async () => {
      await api(`/api/roots/${root.id}`, { method: "PATCH", body: JSON.stringify({ readonly: next }) });
      await Promise.all(["roots", "fs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    });
  }

  return (
    <Page title="位置" description="掛載在 /data 底下的每個資料夾都會自動成為一個位置，出現在桌面上。">
      {roots.length > 0 ? (
        <RowList>
          {roots.map((root) => (
            <Row key={root.id} icon={<HardDrive />} title={root.name} subtitle={root.slug}>
              {root.readonly ? <KagoBadge>唯讀</KagoBadge> : null}
              <Button onClick={() => void setRootReadonly(root, !root.readonly)}>{root.readonly ? "允許寫入" : "設為唯讀"}</Button>
            </Row>
          ))}
        </RowList>
      ) : (
        <KagoEmptyState icon={<HardDrive />} title="還沒有任何位置" description="在 /data 底下建立或掛載資料夾後，就會出現在這裡。" />
      )}
    </Page>
  );
}
