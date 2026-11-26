import { useEffect, useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { useMe, useRoots, useTasks, useTrash } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoSearchField } from "@/components/kago/search-field";
import { Button } from "@/components/ui/button";
import { isActiveTask } from "@/features/tasks/taskUtils";
import { t } from "@/lib/i18n";
import { arrangeTrash, isLocalRoot, othersOf, totalOf, type TrashSection } from "@/lib/trashModel";
import { TrashCard, TrashGroupCard, type TrashView } from "./TrashCard";
import { totalText, useTrashActions } from "./useTrashActions";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Times in the list and the day each item is under are read again now and then, so "Today" does not stay that past midnight. */
function useNow() {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const sectionTitle = (section: TrashSection) => (section === "today" ? t("Today") : section === "yesterday" ? t("Yesterday") : t("Earlier"));

/**
 * What was thrown away, by the day, one card for each deletion: several items that went in together are one card that
 * opens onto them. The header holds the search, what the Trash adds up to, and emptying it.
 */
export function TrashPage() {
  const trash = useTrash();
  const roots = useRoots();
  const me = useMe().data?.user;
  const now = useNow();
  const [query, setQuery] = useState("");
  const rootName = (rootId: string) => roots.data?.find((root) => root.id === rootId)?.name ?? null;
  const actions = useTrashActions(rootName);
  const items = trash.data ?? [];
  const sections = arrangeTrash(items, query, now);
  const tasks = useTasks().data ?? [];
  const running = tasks.filter((task) => (task.type === "restore_trash" || task.type === "empty_trash") && isActiveTask(task));
  const busy = new Set(running.flatMap((task) => task.sources.map((source) => source.path)));
  const emptying = running.some((task) => task.type === "empty_trash");
  const local = (rootId: string) => isLocalRoot(roots.data, rootId);
  const view: TrashView = { now, meId: me?.id, showDeleter: me?.role === "ADMIN", rootName, local, busy, restore: (list) => void actions.restore(list), destroy: (list) => void actions.destroy(list) };
  const total = totalOf(items, (item) => local(item.original_root_id), now);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {items.length > 0 ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-elevated p-2.5">
          <KagoSearchField label={t("Search the Trash")} value={query} onChange={setQuery} />
          <span className="shrink-0 text-xs text-muted tabular-nums">{totalText(total)}</span>
          <Button variant="destructive-primary" disabled={emptying} onClick={() => void actions.empty(total, othersOf(items, me?.id ?? ""))}>{t("Empty Trash")}</Button>
        </header>
      ) : null}

      {trash.isLoading ? <KagoLoading /> : null}
      {trash.data && items.length === 0 ? <KagoEmptyState className="flex-1" icon={<Trash2 />} title={t("The Trash is empty")} description={t("Deleted items wait here, and can be put back where they were.")} /> : null}
      {items.length > 0 && sections.length === 0 ? <KagoEmptyState className="flex-1" icon={<Search />} title={t("Nothing in the Trash matches “{query}”", { query: query.trim() })} /> : null}
      {sections.length > 0 ? (
        <div className="flex min-h-0 flex-1 scroll-fade flex-col gap-1 overflow-y-auto p-2.5">
          {sections.map(({ section, entries }, index) => (
            <section key={section} className={index > 0 ? "mt-2 flex flex-col gap-1" : "flex flex-col gap-1"}>
              <h2 className="m-0 px-1 pb-0.5 text-xs font-semibold text-muted">{sectionTitle(section)}</h2>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {entries.map((entry) => (entry.group ? <TrashGroupCard key={entry.key} deletion={entry} section={section} view={view} /> : <TrashCard key={entry.key} item={entry.items[0]!} section={section} view={view} />))}
              </ul>
            </section>
          ))}
        </div>
      ) : null}
    </div>
  );
}
