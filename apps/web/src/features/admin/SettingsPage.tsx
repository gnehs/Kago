import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns3, Fingerprint, KeyRound, LayoutGrid, List, Monitor, Moon, PanelLeft, PanelRight, Sparkles, Sun, ZapOff } from "lucide-react";
import { api, ApiError } from "@/api/client";
import { useIdentities } from "@/api/hooks";
import { KagoAvatar } from "@/components/kago/avatar";
import { KagoBadge } from "@/components/kago/badge";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { startSsoLink } from "@/features/auth/sso";
import { firstDirection, sortColumns } from "@/features/files/FileList";
import { BASE_VIEW } from "@/features/files/folderView";
import { Card, Page, SettingRow } from "@/features/workspace/Page";
import { formatUnixDate } from "@/lib/format";
import { localeNames, setLocale, t } from "@/lib/i18n";
import { getLocalePref, getMotion, getTheme, getWindowControls, setMotion, setTheme, setWindowControls, type LocalePref, type MotionPref, type ThemePref, type WindowControlsPref } from "@/lib/prefs";
import { run } from "@/lib/run";
import { saveSettings, setWallpaper, useSettingsStore, wallpaperUrl } from "@/stores/settings";
import { confirmAction } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import type { Actor, FolderView, SsoIdentity } from "@/types/kago";
import { roleLabels } from "./UsersPage";

const themes: Array<{ value: ThemePref; label: string; icon: React.ReactNode }> = [
  { value: "system", label: t("Match system"), icon: <Monitor /> },
  { value: "light", label: t("Light"), icon: <Sun /> },
  { value: "dark", label: t("Dark"), icon: <Moon /> }
];

const sides: Array<{ value: WindowControlsPref; label: string; icon: React.ReactNode }> = [
  { value: "left", label: t("Left"), icon: <PanelLeft /> },
  { value: "right", label: t("Right"), icon: <PanelRight /> }
];

const motions: Array<{ value: MotionPref; label: string; icon: React.ReactNode }> = [
  { value: "on", label: t("On"), icon: <Sparkles /> },
  { value: "off", label: t("Off"), icon: <ZapOff /> }
];

const viewModes: Array<{ value: FolderView["viewMode"]; label: string; icon: React.ReactNode }> = [
  { value: "list", label: t("List"), icon: <List /> },
  { value: "grid", label: t("Icons"), icon: <LayoutGrid /> },
  { value: "columns", label: t("Columns"), icon: <Columns3 /> }
];

const switches: Array<{ value: "on" | "off"; label: string; icon: React.ReactNode }> = [
  { value: "on", label: t("On"), icon: null },
  { value: "off", label: t("Off"), icon: null }
];

/** One of a few, as a row of joined buttons. */
function Choice<T extends string>({ label, options, value, onChange }: { label: string; options: Array<{ value: T; label: string; icon: React.ReactNode }>; value: T; onChange: (value: T) => void }) {
  return (
    <div className="kago-segments" role="radiogroup" aria-label={label}>
      {options.map((item) => (
        <button
          key={item.value}
          role="radio"
          aria-checked={value === item.value}
          className="flex h-[calc(var(--kago-control-h)-4px)] items-center gap-1.5 px-2.5 outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-inset"
          onClick={() => onChange(item.value)}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** What belongs to the person signed in: how Kago looks and shows folders for them, and their own account. */
export function SettingsPage({ user }: { user: Actor }) {
  // Kept with the account, so a change made in another browser shows here as it arrives.
  const settings = useSettingsStore((state) => state.settings);
  const theme = getTheme();
  const side = getWindowControls();
  const motion = getMotion();
  const defaultView = { ...BASE_VIEW, ...settings.defaultView };

  return (
    <Page title={t("General")} description={t("How Kago looks and shows your folders, and your own account.")}>
      <Card title={t("Appearance")}>
        <div className="flex flex-col gap-4">
          <SettingRow label={t("Language")} description={t("Changing it reloads the page.")}>
            <Select aria-label={t("Language")} className="w-40" value={getLocalePref()} onChange={(event) => setLocale(event.target.value as LocalePref)}>
              <option value="system">{t("Match system")}</option>
              {Object.entries(localeNames).map(([value, name]) => <option key={value} value={value} lang={value}>{name}</option>)}
            </Select>
          </SettingRow>
          <SettingRow label={t("Theme")}>
            <Choice
              label={t("Theme")}
              options={themes}
              value={theme}
              onChange={setTheme}
            />
          </SettingRow>
          <SettingRow label={t("Window controls")} description={t("Which end of the title bar holds close, minimize and maximize.")}>
            <Choice
              label={t("Window controls position")}
              options={sides}
              value={side}
              onChange={setWindowControls}
            />
          </SettingRow>
          <SettingRow label={t("Desktop background")} description={t("Right-click a picture in any folder and choose “Set as desktop background”. Kago keeps its own copy.")}>
            <div className="flex items-center gap-2">
              {settings.wallpaper ? <img alt="" src={wallpaperUrl(settings.wallpaper)} className="h-(--kago-control-h) w-12 rounded-sm object-cover ring-1 ring-line" /> : null}
              <Button variant="outline" disabled={!settings.wallpaper} onClick={() => void run(() => setWallpaper(null))}>{settings.wallpaper ? t("Remove") : t("None set")}</Button>
            </div>
          </SettingRow>
          <SettingRow label={t("Animations")} description={t("Windows, menus and dialogs come and go at once when this is off.")}>
            <Choice
              label={t("Animations")}
              options={motions}
              value={motion}
              onChange={setMotion}
            />
          </SettingRow>
        </div>
      </Card>
      <Card title={t("Folders")} description={t("Each folder remembers the view you pick for it. These apply to the folders you have not picked one for.")}>
        <div className="flex flex-col gap-4">
          <SettingRow label={t("Default view")}>
            <Choice label={t("Default view")} options={viewModes} value={defaultView.viewMode} onChange={(viewMode) => void saveSettings({ defaultView: { viewMode } })} />
          </SettingRow>
          <SettingRow label={t("Default sort")}>
            <Select
              aria-label={t("Default sort")}
              className="w-40"
              value={defaultView.sortBy}
              onChange={(event) => {
                const sortBy = event.target.value as FolderView["sortBy"];
                void saveSettings({ defaultView: { sortBy, sortDirection: firstDirection(sortBy) } });
              }}
            >
              {sortColumns.map(({ sortBy, label }) => <option key={sortBy} value={sortBy}>{label}</option>)}
            </Select>
          </SettingRow>
          <SettingRow label={t("Icons for pictures and videos")} description={t("A folder that mostly holds pictures and videos opens as icons, until you pick a view for it.")}>
            <Choice label={t("Icons for pictures and videos")} options={switches} value={settings.smartView === false ? "off" : "on"} onChange={(value) => void saveSettings({ smartView: value === "on" })} />
          </SettingRow>
        </div>
      </Card>
      <ArchivePasswords />
      <AccountSettings user={user} />
    </Page>
  );
}

type ArchivePassword = { id: string; note: string; createdAt: number };

/** The passwords tried on a locked archive before its own is asked for. What is saved is not shown again, so each goes by its note. */
function ArchivePasswords() {
  const queryClient = useQueryClient();
  const saved = useQuery({ queryKey: ["archive-passwords"], queryFn: () => api<ArchivePassword[]>("/api/archive-passwords") });
  const [password, setPassword] = useState("");
  const [note, setNote] = useState("");
  const adopt = (list: ArchivePassword[]) => queryClient.setQueryData(["archive-passwords"], list);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (!password) return;
    await run(async () => {
      adopt(await api<ArchivePassword[]>("/api/archive-passwords", { method: "POST", body: JSON.stringify({ password, note }) }));
      setPassword("");
      setNote("");
    }, t("Couldn’t save the password"));
  }

  return (
    <Card title={t("Archive passwords")} description={t("Tried on a locked archive before you are asked for its password. A saved password is not shown again.")}>
      <div className="flex flex-col gap-4">
        {saved.data?.length ? (
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {saved.data.map((item) => (
              <li key={item.id} className="flex items-center gap-3 py-2 first:pt-0 [&>.lucide]:size-4 [&>.lucide]:text-muted">
                <KeyRound />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className={item.note ? "truncate font-medium" : "truncate text-muted"}>{item.note || t("No note")}</span>
                  <span className="text-xs text-muted">{t("Added {date}", { date: formatUnixDate(item.createdAt) })}</span>
                </div>
                <Button variant="destructive" onClick={() => void run(async () => adopt(await api<ArchivePassword[]>(`/api/archive-passwords/${item.id}`, { method: "DELETE" })))}>{t("Remove")}</Button>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="grid grid-cols-2 items-end gap-3" onSubmit={add}>
          <Field label={t("Password")}>
            <Input type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
          </Field>
          <Field label={t("Note")}>
            <Input autoComplete="off" maxLength={80} value={note} placeholder={t("What it is for")} onChange={(event) => setNote(event.target.value)} />
          </Field>
          <div className="col-span-2 flex justify-end"><Button type="submit" variant="default" disabled={!password}>{t("Add password")}</Button></div>
        </form>
      </div>
    </Card>
  );
}

/** The host of an issuer, which is how people know their provider; the whole of it when it is not an address. */
const issuerName = (issuer: string) => {
  try {
    return new URL(issuer).host;
  } catch {
    return issuer;
  }
};

function AccountSettings({ user }: { user: Actor }) {
  const queryClient = useQueryClient();
  const account = useIdentities();
  // An account made through single sign-on has no password until one is set here; there is no current one to ask for.
  const hasPassword = account.data?.hasPassword ?? true;
  const identities = account.data?.identities ?? [];
  const sso = account.data?.sso ?? null;
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const tooShort = newPassword.length > 0 && newPassword.length < 8;
  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;
  const canSubmit = (Boolean(currentPassword) || !hasPassword) && newPassword.length >= 8 && confirmPassword === newPassword;

  async function unlink(identity: SsoIdentity) {
    if (!(await confirmAction({ title: t("Unlink {provider}?", { provider: issuerName(identity.issuer) }), description: t("You will no longer be able to sign in to this account through it. Other devices signed in that way are signed out."), confirmLabel: t("Unlink"), destructive: true }))) return;
    await run(async () => {
      await api(`/api/auth/identities/${identity.id}`, { method: "DELETE" });
      await queryClient.invalidateQueries({ queryKey: ["auth", "identities"] });
    }, t("Couldn’t unlink the identity"));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ currentPassword: hasPassword ? currentPassword : undefined, newPassword }) });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      await queryClient.invalidateQueries({ queryKey: ["auth", "identities"] });
      toast(t("Password updated. Other devices have been signed out"));
    } catch (error) {
      toast(error instanceof ApiError && error.code === "INVALID_CURRENT_PASSWORD" ? t("The current password is incorrect") : t("Couldn’t change the password"), "error");
    }
  }

  return (
    <Card title={t("Account")}>
      <div className="flex items-center gap-3">
        <KagoAvatar name={user.displayName || user.email} className="size-9 text-sm" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{user.displayName}</span>
          <span className="truncate text-xs text-muted">{user.email}</span>
        </div>
        <KagoBadge tone={user.role === "ADMIN" ? "accent" : "neutral"}>{roleLabels[user.role]}</KagoBadge>
      </div>
      {sso || identities.length > 0 ? (
        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
          <h3 className="m-0 font-medium">{t("Single sign-on")}</h3>
          {identities.length > 0 ? (
            <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
              {identities.map((identity) => (
                <li key={identity.id} className="flex items-center gap-3 py-2 first:pt-0 [&>.lucide]:size-4 [&>.lucide]:text-muted">
                  <Fingerprint />
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{issuerName(identity.issuer)}</span>
                    <span className="truncate text-xs text-muted">{identity.email ?? identity.displayName ?? identity.subject}</span>
                  </div>
                  <Button variant="destructive" onClick={() => void unlink(identity)}>{t("Unlink")}</Button>
                </li>
              ))}
            </ul>
          ) : null}
          {sso ? (
            <div className="flex items-center justify-between gap-3">
              <span className="text-xs text-muted">{identities.length > 0 ? t("You can sign in to this account through the identities above.") : t("Link your identity at the provider to sign in to this account without its password.")}</span>
              <Button onClick={() => void run(startSsoLink, t("Couldn’t start linking"))}>{identities.length > 0 ? t("Link another") : sso.name ? t("Link {name}", { name: sso.name }) : t("Link an identity")}</Button>
            </div>
          ) : null}
        </div>
      ) : null}
      <form className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4" onSubmit={submit}>
        <h3 className="col-span-2 m-0 font-medium">{hasPassword ? t("Change password") : t("Set a password")}</h3>
        {hasPassword ? (
          <Field label={t("Current password")} className="col-span-2 @md:col-span-1">
            <Input type="password" autoComplete="current-password" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
          </Field>
        ) : (
          <p className="col-span-2 m-0 text-xs text-muted">{t("This account has no password yet: it is signed in to through single sign-on only. Setting one gives it a second way in.")}</p>
        )}
        <Field label={t("New password")} hint={tooShort ? t("At least 8 characters") : undefined} className="col-start-1">
          <Input type="password" autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
        </Field>
        <Field label={t("Confirm new password")} hint={mismatch ? t("The passwords don’t match") : undefined}>
          <Input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} />
        </Field>
        <div className="col-span-2 flex items-center justify-between gap-3">
          <span className="text-xs text-muted">{t("Other devices are signed out after the change.")}</span>
          <Button type="submit" variant="default" disabled={!canSubmit}>{hasPassword ? t("Change password") : t("Set a password")}</Button>
        </div>
      </form>
    </Card>
  );
}
