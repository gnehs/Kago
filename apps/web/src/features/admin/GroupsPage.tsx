import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UsersRound } from "lucide-react";
import { api } from "@/api/client";
import { useGroups, useUsers } from "@/api/hooks";
import { KagoEmptyState, KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Card, Page, Row, RowList } from "@/features/workspace/Page";
import { formatUnixDate } from "@/lib/format";
import { run } from "@/lib/run";
import { toast } from "@/stores/toast";

export function GroupsPage() {
  const queryClient = useQueryClient();
  const groups = useGroups();
  const users = useUsers();
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [userId, setUserId] = useState("");

  async function createGroup(event: React.FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    await run(async () => {
      await api("/api/groups", { method: "POST", body: JSON.stringify({ name: name.trim() }) });
      setName("");
      await queryClient.invalidateQueries({ queryKey: ["groups"] });
    }, "新增群組失敗");
  }

  async function changeMember(method: "POST" | "DELETE") {
    if (!groupId || !userId) return;
    await run(async () => {
      if (method === "POST") await api(`/api/groups/${groupId}/members`, { method, body: JSON.stringify({ userId }) });
      else await api(`/api/groups/${groupId}/members/${userId}`, { method });
      toast(method === "POST" ? "已加入群組" : "已從群組移除");
    });
  }

  return (
    <Page title="群組" description="把使用者編成群組，再用權限規則一次授權給整個群組。">
      <Card title="新增群組">
        <form className="flex items-end gap-3" onSubmit={createGroup}>
          <Field label="群組名稱" className="flex-1"><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Button type="submit" variant="default" disabled={!name.trim()}>新增群組</Button>
        </form>
      </Card>
      <Card title="群組成員">
        <div className="grid grid-cols-[1fr_1fr_auto_auto] items-end gap-3">
          <Field label="群組">
            <Select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              <option value="">選擇群組</option>
              {groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
            </Select>
          </Field>
          <Field label="使用者">
            <Select value={userId} onChange={(event) => setUserId(event.target.value)}>
              <option value="">選擇使用者</option>
              {users.data?.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
            </Select>
          </Field>
          <Button variant="default" disabled={!groupId || !userId} onClick={() => void changeMember("POST")}>加入</Button>
          <Button disabled={!groupId || !userId} onClick={() => void changeMember("DELETE")}>移除</Button>
        </div>
      </Card>
      {groups.isLoading ? <KagoLoading /> : null}
      {groups.data?.length === 0 ? <KagoEmptyState icon={<UsersRound />} title="還沒有群組" /> : null}
      {groups.data?.length ? (
        <RowList>
          {groups.data.map((group) => <Row key={group.id} icon={<UsersRound />} title={group.name} subtitle={`建立於 ${formatUnixDate(group.created_at)}`} />)}
        </RowList>
      ) : null}
    </Page>
  );
}
