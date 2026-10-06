import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UsersRound, X } from "lucide-react";
import { api } from "@/api/client";
import { useGroups, useUsers } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Card, Page } from "@/features/workspace/Page";
import { run } from "@/lib/run";
import type { Group, UserAccount } from "@/types/kago";

export function GroupsPage() {
  const queryClient = useQueryClient();
  const groups = useGroups();
  const users = useUsers();
  const [name, setName] = useState("");
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["groups"] });

  async function createGroup(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await run(async () => {
      await api("/api/groups", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setName("");
      await refresh();
    }, "新增群組失敗");
  }

  return (
    <Page title="群組" description="把使用者編成群組，再用權限規則一次授權給整個群組。">
      <Card title="新增群組">
        <form className="flex items-end gap-3" onSubmit={createGroup}>
          <Field label="群組名稱" className="flex-1"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Button type="submit" variant="default" disabled={!name.trim()}>新增群組</Button>
        </form>
      </Card>
      {groups.isLoading ? <KagoLoading /> : null}
      {groups.data?.length === 0 ? <KagoEmptyState icon={<UsersRound />} title="還沒有群組" /> : null}
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
    }, "加入群組失敗");
  }

  async function remove(memberId: string) {
    await run(async () => {
      await api(`/api/groups/${group.id}/members/${memberId}`, { method: "DELETE" });
      await onChange();
    }, "移除成員失敗");
  }

  return (
    <Card>
      <h2 className="m-0 mb-3 flex items-center gap-2 text-sm font-semibold">
        <UsersRound className="text-muted" />
        <span className="min-w-0 flex-1 truncate">{group.name}</span>
        <span className="text-xs font-normal text-muted">{group.members.length} 位成員</span>
      </h2>
      {group.members.length > 0 ? (
        <ul className="m-0 mb-3 flex list-none flex-col divide-y divide-line rounded-md border border-line p-0">
          {group.members.map((member) => (
            <li key={member.id} className="flex h-9 items-center gap-2 pr-1 pl-3">
              <span className="truncate">{member.display_name}</span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{member.email}</span>
              <KagoIconButton label={`將 ${member.display_name} 移出 ${group.name}`} onClick={() => void remove(member.id)}><X /></KagoIconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="m-0 mb-3 text-faint">這個群組還沒有成員。</p>
      )}
      <form className="flex gap-2" onSubmit={add}>
        <Select aria-label={`要加入 ${group.name} 的使用者`} value={userId} onChange={(event) => setUserId(event.target.value)} disabled={candidates.length === 0}>
          <option value="">{candidates.length === 0 ? "所有使用者都已加入" : "選擇要加入的使用者"}</option>
          {candidates.map((user) => <option key={user.id} value={user.id}>{user.display_name}（{user.email}）</option>)}
        </Select>
        <Button type="submit" disabled={!userId}>加入</Button>
      </form>
    </Card>
  );
}
