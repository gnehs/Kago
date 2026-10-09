import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Columns3, KeyRound, LayoutGrid, List, Monitor, Moon, PanelLeft, PanelRight, Sparkles, Sun, ZapOff } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/input";
import { KagoPasswordInput } from "@/components/kago/password-input";
import { firstDirection, sortColumns } from "@/features/files/FileList";
import { BASE_VIEW } from "@/features/files/folderView";
import { Card, Page, SettingRow } from "@/features/workspace/Page";
import { formatUnixDate } from "@/lib/format";
import { localeNames, setLocale, t } from "@/lib/i18n";
import { getLocalePref, getMotion, getTheme, getWindowControls, setMotion, setTheme, setWindowControls, type LocalePref, type MotionPref, type ThemePref, type WindowControlsPref } from "@/lib/prefs";
import { run } from "@/lib/run";
import { saveSettings, setWallpaper, useSettingsStore, wallpaperUrl } from "@/stores/settings";
import type { FolderView } from "@/types/kago";

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

/** How Kago looks and shows folders for the person signed in. */
export function SettingsPage() {
  // Kept with the account, so a change made in another browser shows here as it arrives.
  const settings = useSettingsStore((state) => state.settings);
  const theme = getTheme();
  const side = getWindowControls();
  const motion = getMotion();
  const defaultView = { ...BASE_VIEW, ...settings.defaultView };

  return (
    <Page title={t("General")} description={t("How Kago looks and shows your folders.")}>
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
            <KagoPasswordInput autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
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
