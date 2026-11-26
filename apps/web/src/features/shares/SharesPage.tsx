import { useEffect, useState } from "react";
import { Plus, Search, Share2 } from "lucide-react";
import { useMe, useShares } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoSearchField } from "@/components/kago/search-field";
import { Button } from "@/components/ui/button";
import { groupShares } from "@/lib/shareModel";
import type { Root, ShareLink } from "@/types/kago";
import { ShareCard } from "./ShareCard";
import { ShareDialog } from "./ShareDialog";
import { ShareEditDialog, type ShareEdit } from "./ShareEditDialogs";
import { copyShare, useShareActions } from "./useShareActions";
import { shareName } from "@/lib/shareModel";
import { t } from "@/lib/i18n";

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Relative times in the list are re-read now and then, so "in 1 hour" does not stay that for a day. */
function useNow() {
  const [now, setNow] = useState(nowSeconds);
  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The links that work come first, the ones that no longer do are gathered below them with what would fix each.
 * A search field narrows both by name.
 */
export function SharesPage({ roots }: { roots: Root[] }) {
  const shares = useShares();
  const me = useMe().data?.user;
  const now = useNow();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState<ShareEdit | null>(null);
  const rootName = (rootId: string) => roots.find((root) => root.id === rootId)?.name ?? t("Removed location");
  const actions = useShareActions(rootName);
  const { active, dead } = groupShares(shares.data ?? [], rootName, query, now);
  const total = shares.data?.length ?? 0;
  const create = roots.length > 0 ? <Button variant="default" onClick={() => setCreating(true)}><Plus />{t("Create share link")}</Button> : null;
  const editing = (field: ShareEdit["field"]) => (share: ShareLink) => setEdit({ share, field, name: shareName(share, rootName(share.root_id)) });
  const cardActions = {
    copy: (share: ShareLink) => void copyShare(share),
    rotate: (share: ShareLink) => void actions.rotate(share),
    changeExpiry: editing("expiry"),
    changeLimit: editing("limit"),
    setDisabled: (share: ShareLink, disabled: boolean) => void actions.change(share, { disabled }),
    remove: (share: ShareLink) => void actions.remove(share)
  };
  const cards = (list: ShareLink[]) => list.map((share) => <ShareCard key={share.id} share={share} rootName={rootName(share.root_id)} now={now} creator={me?.role === "ADMIN" && share.created_by !== me.id} actions={cardActions} />);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {total > 0 ? (
        <header className="flex shrink-0 items-center gap-2 border-b border-line bg-elevated p-2.5">
          <KagoSearchField label={t("Search shares")} value={query} onChange={setQuery} />
          {create}
        </header>
      ) : null}

      {shares.isLoading ? <KagoLoading /> : null}
      {shares.data && total === 0 ? (
        <KagoEmptyState className="flex-1" icon={<Share2 />} title={t("No share links yet")} description={t("Create one here, or share straight from a file’s info panel.")}>
          {create}
        </KagoEmptyState>
      ) : null}
      {total > 0 && active.length + dead.length === 0 ? <KagoEmptyState className="flex-1" icon={<Search />} title={t("No shares match “{query}”", { query: query.trim() })} /> : null}
      {active.length + dead.length > 0 ? (
        <div className="flex min-h-0 flex-1 scroll-fade flex-col gap-1 overflow-y-auto p-2.5">
          {active.length > 0 ? (
            <section className="flex flex-col gap-1">
              <h2 className="m-0 px-1 pb-0.5 text-xs font-semibold text-muted">{t("Active · {count}", { count: active.length })}</h2>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">{cards(active)}</ul>
            </section>
          ) : null}
          {dead.length > 0 ? (
            <section className={active.length > 0 ? "mt-2 flex flex-col gap-1" : "flex flex-col gap-1"}>
              <h2 className="m-0 flex min-h-5 items-center gap-2 px-1 pb-0.5 text-xs font-semibold text-muted">
                <span className="min-w-0 flex-1 truncate">{t("No longer working · {count}", { count: dead.length })}</span>
                <Button variant="destructive" className="h-5 px-2 text-xs" onClick={() => void actions.removeAll(dead)}>{t("Delete all")}</Button>
              </h2>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">{cards(dead)}</ul>
            </section>
          ) : null}
        </div>
      ) : null}

      <ShareDialog open={creating} onClose={() => setCreating(false)} roots={roots} />
      <ShareEditDialog edit={edit} onClose={() => setEdit(null)} save={(share, change) => actions.change(share, change)} />
    </div>
  );
}
