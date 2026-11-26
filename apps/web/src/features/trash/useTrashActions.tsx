import { useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { apiTask } from "@/api/client";
import { invalidateKeys } from "@/api/invalidations";
import { keys } from "@/api/keys";
import { FileTile } from "@/components/kago/file-icon";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { useWindowScope } from "@/components/kago/window-scope";
import { followTask } from "@/features/tasks/taskToast";
import { formatSize } from "@/lib/format";
import { t } from "@/lib/i18n";
import { run } from "@/lib/run";
import { placeText, trashFolder, trashName, type Total } from "@/lib/trashModel";
import { confirmAction } from "@/stores/dialogs";
import type { TrashItem } from "@/types/kago";

const sourcesOf = (items: readonly TrashItem[]) => items.map((item) => ({ rootSlug: "trash", path: item.id }));

/** The total as a line: how many, and how much of it where that is known, or the least it is where it is not. */
export function totalText(total: Total) {
  const size = total.complete ? formatSize(total.bytes) : total.bytes > 0 ? t("at least {size}", { size: formatSize(total.bytes) }) : null;
  const count = t("{count} item | {count} items", { count: total.count });
  return size ? `${count} · ${size}` : count;
}

/** What can be done to what is in the Trash. Each starts a task, which the notification follows and which tells the list when it is done. */
export function useTrashActions(rootName: (rootId: string) => string | null) {
  const scope = useWindowScope();
  const queryClient = useQueryClient();
  const refresh = () => invalidateKeys(queryClient, [keys.trash(), keys.tasks()]);
  const subject = (item: TrashItem) => ({ icon: <FileTile item={{ kind: item.kind ?? "file", type: "", name: trashName(item) }} className="size-12" />, name: trashName(item), detail: placeText(rootName(item.original_root_id), trashFolder(item)) ?? undefined });

  return {
    async restore(items: readonly TrashItem[]) {
      await run(async () => {
        // Nothing is back in its folder until the task has put it there, which the server tells of then.
        followTask(items.length === 1 ? await apiTask(`/api/trash/${items[0]!.id}/restore`, { method: "POST" }) : await apiTask("/api/tasks", { method: "POST", body: JSON.stringify({ type: "restore_trash", sources: sourcesOf(items) }) }));
        await refresh();
      }, t("Couldn’t restore"));
    },

    async destroy(items: readonly TrashItem[]) {
      const [only] = items;
      const confirmed = await confirmAction({
        window: scope,
        title: items.length === 1 ? t("Delete this for good?") : t("Delete {count} items for good?", { count: items.length }),
        subject: only && items.length === 1 ? subject(only) : undefined,
        description: t("It will be deleted for good. This can’t be undone. | They will be deleted for good. This can’t be undone.", { count: items.length }),
        confirmLabel: t("Delete for good"),
        destructive: true
      });
      if (!confirmed) return;
      await run(async () => {
        followTask(await apiTask("/api/tasks", { method: "POST", body: JSON.stringify({ type: "empty_trash", sources: sourcesOf(items) }) }));
        await refresh();
      }, t("Couldn’t delete"));
    },

    /** Everything the list shows, which for an administrator is everyone's: `others` says whose, and the question says it before it is asked. */
    async empty(total: Total, others: { items: number; people: number }) {
      const whose =
        others.items === 0
          ? ""
          : others.people === 1
            ? t("This includes {count} item deleted by another person. | This includes {count} items deleted by another person.", { count: others.items })
            : t("This includes {count} item deleted by {people} other people. | This includes {count} items deleted by {people} other people.", { count: others.items, people: others.people });
      const confirmed = await confirmAction({
        window: scope,
        title: t("Empty the Trash?"),
        subject: { icon: <KagoStatusIcon large tone="danger"><Trash2 /></KagoStatusIcon>, name: t("Trash"), detail: totalText(total) },
        description: whose ? t("{first} {second}", { first: t("Everything in it will be deleted for good. This can’t be undone."), second: whose }) : t("Everything in it will be deleted for good. This can’t be undone."),
        confirmLabel: t("Empty"),
        destructive: true
      });
      if (!confirmed) return;
      await run(async () => {
        // Emptied by a task, which counts what it removes: the list is read again once it is done.
        followTask(await apiTask("/api/trash", { method: "DELETE" }));
        await queryClient.invalidateQueries({ queryKey: keys.tasks() });
      }, t("Couldn’t empty the Trash"));
    }
  };
}
