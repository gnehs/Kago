import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import { api } from "@/api/client";
import { useUsers } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoLoading } from "@/components/kago/empty-state";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Card, Page, Row, RowList } from "@/features/workspace/Page";
import { run } from "@/lib/run";
import { promptText } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import type { UserAccount } from "@/types/kago";

type Role = UserAccount["role"];
const roleLabels: Record<Role, string> = { ADMIN: "管理員", USER: "一般使用者", GUEST: "訪客" };

export function UsersPage({ currentUserId }: { currentUserId: string }) {
  const queryClient = useQueryClient();
  const users = useUsers();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("USER");
  const canCreate = Boolean(email) && password.length >= 8;
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["users"] });

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    await run(async () => {
      await api("/api/users", { method: "POST", body: JSON.stringify({ email, displayName: displayName || email.split("@")[0], password, role }) });
      setEmail("");
      setDisplayName("");
      setPassword("");
      setRole("USER");
      await refresh();
    }, "新增使用者失敗");
  }

  async function setDisabled(user: UserAccount, disabled: boolean) {
    await run(async () => {
      await api(`/api/users/${user.id}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
      await refresh();
    });
  }

  async function resetPassword(user: UserAccount) {
    const password = await promptText({ title: `重設 ${user.display_name} 的密碼`, description: "至少 8 個字元。這位使用者會從所有裝置登出，需要用新密碼重新登入。", placeholder: "新密碼", confirmLabel: "重設密碼" });
    if (password === null) return;
    if (password.length < 8) {
      toast("密碼至少要 8 個字元", "error");
      return;
    }
    await run(async () => {
      await api(`/api/users/${user.id}/password`, { method: "POST", body: JSON.stringify({ password }) });
      toast(`已重設 ${user.display_name} 的密碼`);
    }, "重設密碼失敗");
  }

  return (
    <Page title="使用者" description="管理員可以存取所有位置；其他角色需要透過權限規則授權。">
      <Card title="新增使用者">
        <form className="grid grid-cols-2 gap-3" onSubmit={create}>
          <Field label="Email"><Input type="email" autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} /></Field>
          <Field label="顯示名稱"><Input autoComplete="off" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field>
          <Field label="初始密碼" hint="至少 8 個字元"><Input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></Field>
          <Field label="角色">
            <Select value={role} onChange={(event) => setRole(event.target.value as Role)}>
              {(Object.keys(roleLabels) as Role[]).map((value) => <option key={value} value={value}>{roleLabels[value]}</option>)}
            </Select>
          </Field>
          <div className="col-span-2 flex justify-end"><Button type="submit" variant="default" disabled={!canCreate}>新增使用者</Button></div>
        </form>
      </Card>
      {users.isLoading ? <KagoLoading /> : null}
      {users.data?.length ? (
        <RowList>
          {users.data.map((user) => (
            <Row key={user.id} icon={<UserRound />} title={user.display_name} subtitle={user.email}>
              <KagoBadge tone={user.role === "ADMIN" ? "accent" : "neutral"}>{roleLabels[user.role]}</KagoBadge>
              {user.disabled ? <KagoBadge tone="danger">已停用</KagoBadge> : null}
              {user.id === currentUserId ? null : <Button onClick={() => void resetPassword(user)}>重設密碼</Button>}
              {user.id === currentUserId ? null : <Button onClick={() => void setDisabled(user, !user.disabled)}>{user.disabled ? "啟用" : "停用"}</Button>}
            </Row>
          ))}
        </RowList>
      ) : null}
    </Page>
  );
}
