import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "@/api/client";
import { useRoots, useTrash } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Page, Row, RowList } from "@/features/workspace/Page";
import { formatUnixDate } from "@/lib/format";
import { baseName } from "@/lib/paths";
import { run } from "@/lib/run";
import { toast } from "@/stores/toast";

export function TrashPage() {
  const queryClient = useQueryClient();
  const trash = useTrash();
  const roots = useRoots();
  const rootSlug = (rootId: string) => roots.data?.find((root) => root.id === rootId)?.slug ?? "已移除的位置";

  async function restore(itemId: string) {
    await run(async () => {
      await api(`/api/trash/${itemId}/restore`, { method: "POST" });
      await Promise.all(["trash", "tasks", "fs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      toast("已建立還原任務");
    }, "還原失敗");
  }

  return (
    <Page title="垃圾桶" description="刪除的項目會先放在這裡，可以還原到原本的位置。">
      {trash.isLoading ? <KagoLoading /> : null}
      {trash.data?.length === 0 ? <KagoEmptyState icon={<Trash2 />} title="垃圾桶是空的" /> : null}
      {trash.data?.length ? (
        <RowList>
          {trash.data.map((item) => (
            <Row key={item.id} icon={<Trash2 />} title={baseName(item.original_path) || item.original_path} subtitle={`${rootSlug(item.original_root_id)}:${item.original_path} · 刪除於 ${formatUnixDate(item.deleted_at)}`}>
              <Button onClick={() => void restore(item.id)}>還原</Button>
            </Row>
          ))}
        </RowList>
      ) : null}
    </Page>
  );
}
