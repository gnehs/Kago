import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ScrollText, Search } from "lucide-react";
import { useAudit, useGroups, useRoots, useUsers } from "@/api/hooks";
import { KagoDropdownMenu, KagoMenuCheckItem } from "@/components/kago/menu";
import { KagoEmptyState, KagoLoading, KagoSpinner } from "@/components/kago/empty-state";
import { Page } from "@/components/kago/page";
import { KagoSearchField } from "@/components/kago/search-field";
import { KagoSegmented } from "@/components/kago/segmented";
import { Button } from "@/components/ui/button";
import { ANY_DATE, arrangeDays, isFiltered, isMoreView, MAIN_VIEWS, MORE_VIEWS, type AuditScope, type AuditView, type DateRange, type Names } from "@/lib/auditModel";
import { formatUnixDay } from "@/lib/format";
import { personName } from "@/lib/peopleModel";
import { useNow } from "@/lib/useNow";
import { t } from "@/lib/i18n";
import { AuditCard } from "./AuditCard";
import { DateFilter, PersonFilter } from "./AuditFilters";

const viewLabels: Record<AuditView, () => string> = {
  important: () => t("Important"),
  sign_in: () => t("Sign-ins"),
  file: () => t("Files"),
  share: () => t("Shares"),
  permission: () => t("Permissions"),
  problems: () => t("Failed and denied"),
  all: () => t("All"),
  account: () => t("Accounts"),
  task: () => t("Tasks"),
  settings: () => t("Settings"),
  system: () => t("Server requests")
};

/** What the search is set to, once it has stood still: the server is asked after the typing stops, not at every letter. */
function useSettled<T>(value: T, ms = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/**
 * What happened, newest first, under the day it happened: one card to an event, each a sentence. The header holds the
 * search, whose and when, and the switch between the kinds of event. The list grows as it is scrolled to its end, and a run of the same thing is one card.
 */
export function AuditPage() {
  const now = useNow();
  const users = useUsers().data;
  const groups = useGroups().data;
  const roots = useRoots().data;
  const [view, setView] = useState<AuditView>("important");
  const [actor, setActor] = useState("");
  const [dates, setDates] = useState<DateRange>(ANY_DATE);
  const [typed, setTyped] = useState("");
  const query = useSettled(typed.trim());
  const scope: AuditScope = { view, actor, dates, query };
  const audit = useAudit(scope);
  const names = useMemo<Names>(
    () => ({
      users: new Map(users?.map((user) => [user.id, personName(user)])),
      groups: new Map(groups?.map((group) => [group.id, group.name])),
      roots: new Map(roots?.map((root) => [root.id, root.name])),
      slugs: new Map(roots?.map((root) => [root.slug, root.name]))
    }),
    [users, groups, roots]
  );
  const avatars = useMemo(() => new Map(users?.map((user) => [user.id, user.avatar_at])), [users]);
  const days = useMemo(() => arrangeDays(audit.data?.pages.flat() ?? [], now), [audit.data, now]);
  const filtered = isFiltered(scope);

  const scroller = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = audit;
  useEffect(() => {
    const target = end.current;
    if (!target || !hasNextPage) return;
    const watcher = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isFetchingNextPage) void fetchNextPage();
    }, { root: scroller.current, rootMargin: "240px" });
    watcher.observe(target);
    return () => watcher.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage, days.length]);

  const dayTitle = (day: (typeof days)[number]) => (day.name === "today" ? t("Today") : day.name === "yesterday" ? t("Yesterday") : formatUnixDay(day.day, now));
  const more = isMoreView(view);

  return (
    <Page
      wide
      scrollRef={scroller}
      title={t("Audit log")}
      description={t("Who did what in Kago, newest first.")}
      search={<KagoSearchField label={t("Search people, files or actions")} value={typed} onChange={setTyped} />}
      toolbar={
        <div className="-m-0.5 flex items-center gap-2 overflow-x-auto p-0.5 [scrollbar-width:none]">
          <PersonFilter actor={actor} users={users ?? []} onChange={setActor} />
          <DateFilter range={dates} onChange={setDates} />
          <KagoSegmented<AuditView | "">
            label={t("Audit views")}
            className="shrink-0"
            value={more ? "" : view}
            options={MAIN_VIEWS.map((value) => ({ value, label: viewLabels[value]() }))}
            onChange={(value) => value && setView(value)}
          />
          <KagoDropdownMenu
            raised
            wide
            align="start"
            label={t("More")}
            className={more ? "font-medium" : undefined}
            menu={MORE_VIEWS.map((value) => <KagoMenuCheckItem key={value} checked={view === value} onClick={() => setView(value)}>{viewLabels[value]()}</KagoMenuCheckItem>)}
          >
            {more ? viewLabels[view]() : t("More")}
            <ChevronDown className="size-3.5 shrink-0 text-muted" />
          </KagoDropdownMenu>
        </div>
      }
    >
      {audit.isLoading ? <KagoLoading /> : null}
      {audit.data && days.length === 0 ? (
        filtered || view !== "all" ? (
          <KagoEmptyState className="flex-1" icon={<Search />} title={query ? t("Nothing recorded matches “{query}”", { query }) : t("No events match")} description={t("Try another view, person or date, or clear the search.")} />
        ) : (
          <KagoEmptyState className="flex-1" icon={<ScrollText />} title={t("Nothing recorded yet")} description={t("What people do in Kago is written down here.")} />
        )
      ) : null}
      {days.map((day) => (
        <section key={day.day} className="flex flex-col gap-1">
          <h2 className="m-0 px-1 pb-0.5 text-xs font-semibold text-muted">{dayTitle(day)}</h2>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {day.rows.map((row) => <AuditCard key={row.burst?.id ?? row.id} row={row} names={names} avatars={avatars} />)}
          </ul>
        </section>
      ))}
      {days.length > 0 && hasNextPage ? (
        <div ref={end} className="flex shrink-0 justify-center py-2">
          <Button disabled={isFetchingNextPage} onClick={() => void fetchNextPage()}>
            {isFetchingNextPage ? <KagoSpinner className="text-inherit" /> : null}
            {isFetchingNextPage ? t("Loading events…") : t("Show more")}
          </Button>
        </div>
      ) : null}
    </Page>
  );
}
