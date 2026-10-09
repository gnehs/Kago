import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { api } from "@/api/client";
import { useRoots, useTrash } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Page, Row, RowList } from "@/components/kago/page";
import { formatUnixDate } from "@/lib/format";
import { baseName, displayPath } from "@/lib/paths";
import { run } from "@/lib/run";
import { confirmAction } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import { t } from "@/lib/i18n";

export function TrashPage() {
  const queryClient = useQueryClient();
  const trash = useTrash();
  const roots = useRoots();
  const rootName = (rootId: string) => roots.data?.find((root) => root.id === rootId)?.name ?? t("Removed location");

  async function restore(itemId: string) {
    await run(async () => {
      await api(`/api/trash/${itemId}/restore`, { method: "POST" });
      await Promise.all(["trash", "tasks", "fs"].map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
      toast(t("Restore task created"));
    }, t("Couldn’t restore"));
  }

  async function empty() {
    const confirmed = await confirmAction({
      title: t("Empty the Trash?"),
      description: t("The {count} item in the Trash will be deleted for good. This can’t be undone. | The {count} items in the Trash will be deleted for good. This can’t be undone.", { count: trash.data?.length ?? 0 }),
      confirmLabel: t("Empty"),
      destructive: true
    });
    if (!confirmed) return;
    await run(async () => {
      await api("/api/trash", { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["trash"] });
      toast(t("Trash emptied"));
    }, t("Couldn’t empty the Trash"));
  }

  return (
    <Page
      description={trash.data?.length ? t("{count} item, which can be put back where it was. | {count} items, which can be put back where they were.", { count: trash.data.length }) : t("Deleted items wait here, and can be put back where they were.")}
      actions={trash.data?.length ? <Button variant="destructive-primary" onClick={() => void empty()}>{t("Empty Trash")}</Button> : null}
    >
      {trash.isLoading ? <KagoLoading /> : null}
      {trash.data?.length === 0 ? <KagoEmptyState icon={<Trash2 />} title={t("The Trash is empty")} /> : null}
      {trash.data?.length ? (
        <RowList>
          {trash.data.map((item) => (
            <Row key={item.id} icon={<Trash2 />} title={baseName(item.original_path) || item.original_path} subtitle={`${displayPath(rootName(item.original_root_id), item.original_path)} · ${t("Deleted {date}", { date: formatUnixDate(item.deleted_at) })}`}>
              <Button onClick={() => void restore(item.id)}>{t("Put back")}</Button>
            </Row>
          ))}
        </RowList>
      ) : null}
    </Page>
  );
}
