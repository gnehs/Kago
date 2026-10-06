import { useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { api, ApiError } from "@/api/client";
import { KagoBadge } from "@/components/kago/badge";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";
import { Card, Page, SettingRow } from "@/features/workspace/Page";
import { getTheme, setTheme, type ThemePref } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast";
import type { Actor } from "@/types/kago";
import { roleLabels } from "./UsersPage";

const themes: Array<{ value: ThemePref; label: string; icon: React.ReactNode }> = [
  { value: "system", label: "跟隨系統", icon: <Monitor /> },
  { value: "light", label: "淺色", icon: <Sun /> },
  { value: "dark", label: "深色", icon: <Moon /> }
];

/** What belongs to the person signed in: how Kago looks in this browser, and their own account. */
export function SettingsPage({ user }: { user: Actor }) {
  const [theme, setThemeState] = useState(getTheme);

  return (
    <Page title="一般" description="這個瀏覽器的外觀，以及你自己的帳號。">
      <Card title="外觀">
        <SettingRow label="主題" description="只套用在這個瀏覽器。">
          <div className="flex rounded-md border border-line bg-surface p-px" role="radiogroup" aria-label="主題">
            {themes.map((item) => (
              <button
                key={item.value}
                role="radio"
                aria-checked={theme === item.value}
                className={cn(
                  "flex h-[calc(var(--kago-control-h)-4px)] items-center gap-1.5 rounded-sm px-2.5 text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50",
                  theme === item.value && "bg-hover text-ink"
                )}
                onClick={() => {
                  setTheme(item.value);
                  setThemeState(item.value);
                }}
              >
                {item.icon}
                {item.label}
              </button>
            ))}
          </div>
        </SettingRow>
      </Card>
      <AccountSettings user={user} />
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
      <div className="flex items-center gap-3">
        <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent">
          {(user.displayName || user.email).slice(0, 1).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{user.displayName}</span>
          <span className="truncate text-xs text-muted">{user.email}</span>
        </div>
        <KagoBadge tone={user.role === "ADMIN" ? "accent" : "neutral"}>{roleLabels[user.role]}</KagoBadge>
      </div>
      <form className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4" onSubmit={submit}>
        <h3 className="col-span-2 m-0 font-medium">變更密碼</h3>
        <Field label="目前密碼" className="col-span-2 @md:col-span-1">
          <Input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
        </Field>
        <Field label="新密碼" hint={tooShort ? "至少 8 個字元" : undefined} className="col-start-1">
          <Input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </Field>
        <Field label="再輸入一次新密碼" hint={mismatch ? "兩次輸入的密碼不一樣" : undefined}>
          <Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </Field>
        <div className="col-span-2 flex items-center justify-between gap-3">
          <span className="text-xs text-muted">變更後，其他裝置會被登出。</span>
          <Button type="submit" variant="default" disabled={!canSubmit}>變更密碼</Button>
        </div>
      </form>
    </Card>
  );
}
