import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Search, UsersRound } from "lucide-react";
import { api } from "@/api/client";
import { keys } from "@/api/keys";
import { useGroups, usePermissions, useRoots, useUsers } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Page } from "@/components/kago/page";
import { KagoSearchField } from "@/components/kago/search-field";
import { KagoStatusIcon } from "@/components/kago/status-icon";
import { useWindowScope } from "@/components/kago/window-scope";
import { Button } from "@/components/ui/button";
import { accessOf, filterGroups, foundByMember, visibleMembers } from "@/lib/peopleModel";
import { run } from "@/lib/run";
import { confirmAction, promptText } from "@/stores/dialogs";
import type { Group } from "@/types/kago";
import { AddMembersDialog } from "./AddMembersDialog";
import { GroupCard, type GroupCardActions } from "./GroupCard";
import { t } from "@/lib/i18n";

/**
 * Every group on one card, closed until it is opened: who is in it, and what the permission rules let it reach, since
 * that is the only reason to have one. The header holds the search, by group or by member, and adding a group.
 */
export function GroupsPage() {
  const scope = useWindowScope();
  const queryClient = useQueryClient();
  const groups = useGroups();
  const users = useUsers();
  const roots = useRoots();
  const rules = usePermissions();
  const [query, setQuery] = useState("");
  // The cards a person has opened or closed themselves; a search that found a group through a member opens it until then.
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const all = groups.data ?? [];
  const found = filterGroups(all, query);
  const disabled = new Set((users.data ?? []).filter((user) => user.disabled).map((user) => user.id));
  const rootName = (rootId: string) => roots.data?.find((root) => root.id === rootId)?.name ?? null;
  const refresh = () => queryClient.invalidateQueries({ queryKey: keys.groups() });

  async function create() {
    const name = await promptText({ window: scope, title: t("Add group"), placeholder: t("Group name"), confirmLabel: t("Add group") });
    if (name === null || !name.trim()) return;
    await run(async () => {
      const group = await api<Group>("/api/groups", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      await refresh();
      // A new group has nobody in it, which is what it is made for next.
      if (group?.id) setOpened((was) => ({ ...was, [group.id]: true }));
    }, t("Couldn’t add the group"));
  }

  const actions: GroupCardActions = {
    addMembers: (group) => setAdding(group.id),
    removeMember: (group, memberId) =>
      void run(async () => {
        await api(`/api/groups/${group.id}/members/${memberId}`, { method: "DELETE" });
        await refresh();
      }, t("Couldn’t remove the member")),
    async rename(group) {
      const next = await promptText({ window: scope, title: t("Rename {name}", { name: group.name }), defaultValue: group.name, placeholder: t("Group name"), confirmLabel: t("Rename") });
      if (next === null || !next.trim() || next.trim() === group.name) return;
      await run(async () => {
        await api(`/api/groups/${group.id}`, { method: "PATCH", body: JSON.stringify({ name: next.trim() }) });
        await refresh();
      }, t("Couldn’t rename the group"));
    },
    async remove(group) {
      if (!(await confirmAction({ window: scope, title: t("Delete this group?"), subject: { icon: <KagoStatusIcon large><UsersRound /></KagoStatusIcon>, name: group.name, detail: t("{count} member | {count} members", { count: group.members.length }) }, description: t("Its members stay as users but lose the access this group gave them: the permission rules that name it are removed."), confirmLabel: t("Delete"), destructive: true }))) return;
      await run(async () => {
        await api(`/api/groups/${group.id}`, { method: "DELETE" });
        await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: keys.permissions.all() })]);
      }, t("Couldn’t delete the group"));
    }
  };

  const add = <Button variant="default" onClick={() => void create()}><Plus />{t("Add group")}</Button>;

  return (
    <Page
      wide
      title={t("Groups")}
      description={t("Groups let you grant access to several people at once.")}
      search={all.length > 0 ? <KagoSearchField label={t("Search groups or members")} value={query} onChange={setQuery} /> : undefined}
      actions={all.length > 0 ? add : undefined}
    >
      {groups.isLoading ? <KagoLoading /> : null}
      {groups.data && all.length === 0 ? (
        <KagoEmptyState className="flex-1" icon={<UsersRound />} title={t("No groups yet")}>
          {add}
        </KagoEmptyState>
      ) : null}
      {all.length > 0 && found.length === 0 ? <KagoEmptyState className="flex-1" icon={<Search />} title={t("No groups match “{query}”", { query: query.trim() })} /> : null}
      {found.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h2 className="m-0 px-1 pb-0.5 text-xs font-semibold text-muted">{t("{count} group | {count} groups", { count: found.length })}</h2>
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {found.map((group) => (
              <GroupCard
                key={group.id}
                group={group}
                members={visibleMembers(group, query)}
                access={rules.data ? accessOf(group.id, rules.data, rootName) : null}
                disabled={disabled}
                open={opened[group.id] ?? foundByMember(group, query)}
                onToggle={() => setOpened((was) => ({ ...was, [group.id]: !(was[group.id] ?? foundByMember(group, query)) }))}
                actions={actions}
              />
            ))}
          </ul>
        </section>
      ) : null}

      <AddMembersDialog group={all.find((group) => group.id === adding) ?? null} onClose={() => setAdding(null)} />
    </Page>
  );
}
