import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, UsersRound, X } from "lucide-react";
import { api } from "@/api/client";
import { useGroups, useUsers } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Card, Page } from "@/features/workspace/Page";
import { run } from "@/lib/run";
import type { Group, UserAccount } from "@/types/kago";
import { t } from "@/lib/i18n";

export function GroupsPage() {
  const queryClient = useQueryClient();
  const groups = useGroups();
  const users = useUsers();
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["groups"] });

  async function createGroup(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await run(async () => {
      await api("/api/groups", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setName("");
      setCreating(false);
      await refresh();
    }, t("Couldn’t add the group"));
  }

  return (
    <Page
      title={t("Groups")}
      description={t("Put users into groups, then grant access to a whole group with one permission rule.")}
      actions={creating || !groups.data?.length ? null : <Button variant="default" onClick={() => setCreating(true)}><Plus />{t("Add group")}</Button>}
    >
      {creating ? (
      <Card title={t("Add group")} action={<KagoIconButton label={t("Cancel adding")} onClick={() => setCreating(false)}><X /></KagoIconButton>}>
        <form className="flex items-end gap-3" onSubmit={createGroup}>
          <Field label={t("Group name")} className="flex-1"><Input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Button type="submit" variant="default" disabled={!name.trim()}>{t("Add group")}</Button>
        </form>
      </Card>
      ) : null}
      {groups.isLoading ? <KagoLoading /> : null}
      {groups.data?.length === 0 && !creating ? (
        <KagoEmptyState icon={<UsersRound />} title={t("No groups yet")} description={t("Groups let you grant access to several people at once.")}>
          <Button variant="default" onClick={() => setCreating(true)}><Plus />{t("Add group")}</Button>
        </KagoEmptyState>
      ) : null}
      {groups.data?.map((group) => <GroupCard key={group.id} group={group} users={users.data ?? []} onChange={refresh} />)}
    </Page>
  );
}

/** One group with its members; membership changes take effect on the server right away. */
function GroupCard({ group, users, onChange }: { group: Group; users: UserAccount[]; onChange: () => Promise<void> }) {
  const [userId, setUserId] = useState("");
  const candidates = users.filter((user) => !group.members.some((member) => member.id === user.id));

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!userId) return;
    await run(async () => {
      await api(`/api/groups/${group.id}/members`, { method: "POST", body: JSON.stringify({ userId }) });
      setUserId("");
      await onChange();
    }, t("Couldn’t add to the group"));
  }

  async function remove(memberId: string) {
    await run(async () => {
      await api(`/api/groups/${group.id}/members/${memberId}`, { method: "DELETE" });
      await onChange();
    }, t("Couldn’t remove the member"));
  }

  return (
    <Card title={group.name} description={t("{count} member | {count} members", { count: group.members.length })}>
      {group.members.length > 0 ? (
        <ul className="m-0 mb-3 flex list-none flex-col divide-y divide-line rounded-md border border-line p-0">
          {group.members.map((member) => (
            <li key={member.id} className="flex h-9 items-center gap-2 pr-1 pl-3">
              <span className="truncate">{member.display_name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{member.email}</span>
              <KagoIconButton label={t("Remove {member} from {group}", { member: member.display_name, group: group.name })} onClick={() => void remove(member.id)}><X /></KagoIconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 mb-3 text-faint">{t("This group has no members yet.")}</p>
      )}
      <form className="flex gap-2" onSubmit={add}>
        <Select aria-label={t("User to add to {group}", { group: group.name })} value={userId} onChange={(event) => setUserId(event.target.value)} disabled={candidates.length === 0}>
          <option value="">{candidates.length === 0 ? t("Every user is already a member") : t("Choose a user to add")}</option>
          {candidates.map((user) => <option key={user.id} value={user.id}>{user.display_name}（{user.email}）</option>)}
        </Select>
        <Button type="submit" disabled={!userId}>{t("Add")}</Button>
      </form>
    </Card>
  );
}
