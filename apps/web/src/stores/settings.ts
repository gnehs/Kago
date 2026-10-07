import { create } from "zustand";
import { api } from "../api/client";
import { adoptPrefs, onPrefChange } from "../lib/prefs";
import type { AccountPreferences, AccountSettings, FolderViewEntry } from "../types/kago";

type SettingsStore = {
  /** False until the account has answered once. */
  hydrated: boolean;
  settings: AccountSettings;
  /** Every folder something has been set for, by `folderKey`. */
  folderViews: Record<string, FolderViewEntry>;
};

export const folderKey = (rootSlug: string, path: string) => `${rootSlug}\n${path}`;

/**
 * What the account has set: the look of the interface, and how each folder is shown. It is small enough to be
 * held whole, so a folder's view is known the moment it is opened.
 */
export const useSettingsStore = create<SettingsStore>(() => ({ hydrated: false, settings: {}, folderViews: {} }));

/** Changes on their way to the server. Until the last one is answered, what is on screen is ahead of what the server says. */
let pending = 0;

function adopt(remote: AccountPreferences) {
  useSettingsStore.setState({ hydrated: true, settings: remote.settings, folderViews: Object.fromEntries(remote.folderViews.map((view) => [folderKey(view.rootSlug, view.path), view])) });
  const unsent = adoptPrefs(remote.settings);
  if (Object.keys(unsent).length > 0) void saveSettings(unsent);
}

export async function loadSettings() {
  try {
    const remote = await api<AccountPreferences>("/api/settings");
    if (pending === 0) adopt(remote);
  } catch {
    // Without an answer the desktop still opens, on what this browser remembers and the defaults.
    useSettingsStore.setState({ hydrated: true });
  }
}

/** Every change is answered with all that is now set, which the last answer to arrive puts in place. */
async function send(path: string, init: RequestInit) {
  pending += 1;
  try {
    const remote = await api<AccountPreferences>(path, init);
    if (pending === 1) adopt(remote);
  } catch {
    // What was shown ahead of the server did not get there; go back to what it has.
    if (pending === 1) setTimeout(() => void loadSettings());
  } finally {
    pending -= 1;
  }
}

export function saveSettings(patch: AccountSettings) {
  useSettingsStore.setState(({ settings }) => ({ settings: { ...settings, ...patch, ...(patch.defaultView ? { defaultView: { ...settings.defaultView, ...patch.defaultView } } : {}) } }));
  return send("/api/settings", { method: "PATCH", body: JSON.stringify(patch) });
}

/** Sets the named parts of a folder's view, leaving the rest to come from wherever they came from. */
export function setFolderView(rootSlug: string, path: string, view: Partial<Omit<FolderViewEntry, "rootSlug" | "path">>) {
  const key = folderKey(rootSlug, path);
  useSettingsStore.setState(({ folderViews }) => ({ folderViews: { ...folderViews, [key]: { rootSlug, path, recursive: false, ...folderViews[key], ...view } } }));
  return send("/api/folder-views", { method: "PUT", body: JSON.stringify({ rootSlug, path, view }) });
}

/** Forgets what was set for a folder, so it is shown the way the folders around it are. */
export function resetFolderView(rootSlug: string, path: string) {
  useSettingsStore.setState(({ folderViews }) => {
    const rest = { ...folderViews };
    delete rest[folderKey(rootSlug, path)];
    return { folderViews: rest };
  });
  return send(`/api/folder-views?${new URLSearchParams({ rootSlug, path }).toString()}`, { method: "DELETE" });
}

onPrefChange(saveSettings);
