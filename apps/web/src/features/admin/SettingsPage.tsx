import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import { api, ApiError } from "@/api/client";
import { KagoBadge } from "@/components/kago/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { Card, Page, Row, RowList } from "@/features/workspace/Page";
import { getTheme, setTheme, type ThemePref } from "@/lib/prefs";
import { run } from "@/lib/run";
import { toast } from "@/stores/toast";
import type { Actor, Root } from "@/types/kago";

export function SettingsPage({ roots, user }: { roots: Root[]; user: Actor }) {
  const [theme, setThemeState] = useState(getTheme);

  return (
    <Page title="設定">
      <Card title="外觀">
        <div className="grid grid-cols-2 gap-3">
          <Field label="主題">
            <Select value={theme} onChange={(event) => { setTheme(event.target.value as ThemePref); setThemeState(event.target.value as ThemePref); }}>
              <option value="system">跟隨系統</option>
              <option value="light">淺色</option>
              <option value="dark">深色</option>
            </Select>
          </Field>
        </div>
      </Card>
      <AccountSettings user={user} />
      {user.role === "ADMIN" ? <RootSettings roots={roots} /> : null}
    </Page>
  );
}

function AccountSettings({ user }: { user: Actor }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit = Boolean(currentPassword) && newPassword.length >= 8 && confirmPassword === newPassword;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword, newPassword }) });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast("密碼已更新，其他裝置已登出");
    } catch (error) {
      toast(error instanceof ApiError && error.code === "INVALID_CURRENT_PASSWORD" ? "目前密碼不正確" : "變更密碼失敗", "error");
    }
  }

  return (
    <Card title="帳號">
      <p className="m-0 mb-3 text-muted">{user.displayName} · {user.email}</p>
      <form className="grid grid-cols-2 gap-3" onSubmit={submit}>
        <Field label="目前密碼" className="col-span-2 @md:col-span-1">
          <Input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </Field>
        <Field label="新密碼" hint={tooShort ? "至少 8 個字元" : undefined} className="col-start-1">
          <Input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </Field>
        <Field label="再輸入一次新密碼" hint={mismatch ? "兩次輸入的密碼不一樣" : undefined}>
          <Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </Field>
        <div className="col-span-2 flex justify-end"><Button type="submit" variant="default" disabled={!canSubmit}>變更密碼</Button></div>
      </form>
    </Card>
  );
}

function RootSettings({ roots }: { roots: Root[] }) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["roots"] });

  async function setRootReadonly(root: Root, next: boolean) {
    await run(async () => {
      await api(`/api/roots/${root.id}`, { method: "PATCH", body: JSON.stringify({ readonly: next }) });
      await Promise.all([refresh(), queryClient.invalidateQueries({ queryKey: ["fs"] })]);
    });
  }

  return (
    <Card title="位置">
      <p className="m-0 mb-3 text-muted">掛載在 /data 底下的每個資料夾都會自動成為一個位置。</p>
      {roots.length > 0 ? (
        <RowList>
          {roots.map((root) => (
            <Row key={root.id} icon={<HardDrive />} title={root.name} subtitle={root.slug}>
              {root.readonly ? <KagoBadge>唯讀</KagoBadge> : null}
              <Button onClick={() => void setRootReadonly(root, !root.readonly)}>{root.readonly ? "允許寫入" : "設為唯讀"}</Button>
            </Row>
          ))}
        </RowList>
      ) : (
        <span className="text-faint">/data 底下還沒有任何資料夾。</span>
      )}
    </Card>
  );
}
