import { useMemo, useState, type ReactNode } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { CircleUserRound, Clock, Fingerprint, Folder, HardDrive, KeyRound, LayoutGrid, RefreshCw, ScrollText, Search, UserRound, UsersRound } from "lucide-react";
import { useExternalApps } from "@/api/hooks";
import { ExternalAppGlyph } from "@/features/apps/ExternalAppIcon";
import { appHost, openExternalApp } from "@/features/apps/externalApps";
import { appIcons } from "@/features/windows/AppWindow";
import { baseName, displayPath, nfc, normalizeLogicalPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { useRecentStore, type RecentFolder } from "@/stores/recent";
import { useWorkspaceStore, type AppKind, type SettingsSection } from "@/stores/workspace";
import type { ExternalApp, Root } from "@/types/kago";
import { t } from "@/lib/i18n";

type Target = { key: string; label: string; hint: string; icon: ReactNode; open: () => void };

/** Everything that opens as an app window, so the palette reaches it even when the desktop is covered. */
const apps: Array<{ app: AppKind; section?: SettingsSection; label: string; icon: ReactNode; adminOnly?: boolean }> = [
  { app: "shares", label: t("Shares"), icon: appIcons.shares },
  { app: "trash", label: t("Trash"), icon: appIcons.trash },
  { app: "tasks", label: t("Tasks"), icon: appIcons.tasks },
  { app: "settings", section: "general", label: t("Settings"), icon: appIcons.settings },
  { app: "settings", section: "account", label: t("Account"), icon: <CircleUserRound /> },
  { app: "settings", section: "apps", label: t("Apps"), icon: <LayoutGrid /> },
  { app: "settings", section: "sync", label: t("Sync"), icon: <RefreshCw /> },
  { app: "settings", section: "locations", label: t("Locations"), icon: <HardDrive />, adminOnly: true },
  { app: "settings", section: "users", label: t("Users"), icon: <UserRound />, adminOnly: true },
  { app: "settings", section: "groups", label: t("Groups"), icon: <UsersRound />, adminOnly: true },
  { app: "settings", section: "sso", label: t("Single sign-on"), icon: <Fingerprint />, adminOnly: true },
  { app: "settings", section: "permissions", label: t("Permissions"), icon: <KeyRound />, adminOnly: true },
  { app: "settings", section: "audit", label: t("Audit log"), icon: <ScrollText />, adminOnly: true }
];

function suggestions(query: string, roots: Root[], activeRootSlug: string | undefined, recent: RecentFolder[], isAdmin: boolean, externalApps: ExternalApp[]): Target[] {
  const trimmed = query.trim();
  const results = new Map<string, Target>();
  const pushFolder = (rootSlug: string, logicalPath: string, label: string, icon: ReactNode) => {
    const key = `${rootSlug}:${logicalPath}`;
    if (results.has(key)) return;
    const rootName = roots.find((root) => root.slug === rootSlug)?.name ?? rootSlug;
    // The location itself is already named by its label.
    results.set(key, { key, label, hint: logicalPath === "/" ? "" : displayPath(rootName, logicalPath), icon, open: () => useWorkspaceStore.getState().openWindow({ rootSlug, logicalPath, title: label }) });
  };
  const pushPath = (root: Root, rawPath: string) => {
    const logicalPath = normalizeLogicalPath(rawPath);
    if (!logicalPath) return;
    if (logicalPath === "/") pushFolder(root.slug, "/", root.name, <HardDrive />);
    else pushFolder(root.slug, logicalPath, baseName(logicalPath), <Folder />);
  };

  // "photos:/2026" opens a path inside a root; "/2026" resolves against the active window's root.
  const colon = trimmed.indexOf(":");
  const explicitRoot = colon > 0 ? roots.find((root) => root.slug === trimmed.slice(0, colon).trim()) : undefined;
  if (explicitRoot) pushPath(explicitRoot, trimmed.slice(colon + 1));
  const activeRoot = roots.find((root) => root.slug === activeRootSlug);
  if (activeRoot && trimmed.startsWith("/")) pushPath(activeRoot, trimmed);

  const lower = nfc(trimmed).toLowerCase();
  for (const root of roots) {
    if (!lower || root.name.toLowerCase().includes(lower) || root.slug.includes(lower)) pushPath(root, "/");
  }
  // Recently visited folders fill in below the roots, filtered by the same query.
  for (const folder of recent) {
    const label = baseName(folder.path);
    if (!roots.some((root) => root.slug === folder.rootSlug)) continue;
    if (!lower || label.toLowerCase().includes(lower)) pushFolder(folder.rootSlug, folder.path, label, <Clock />);
  }
  // The other services on the desktop are places to go as well; they open in a tab of their own.
  for (const item of externalApps) {
    if (lower && !item.name.toLowerCase().includes(lower)) continue;
    results.set(`external:${item.id}`, { key: `external:${item.id}`, label: item.name, hint: appHost(item), icon: <ExternalAppGlyph icon={item.icon} />, open: () => openExternalApp(item) });
  }
  for (const item of apps) {
    if ((item.adminOnly && !isAdmin) || (lower && !item.label.toLowerCase().includes(lower))) continue;
    const key = `app:${item.app}:${item.section ?? ""}`;
    results.set(key, { key, label: item.label, hint: item.section && item.section !== "general" ? t("Settings") : "", icon: item.icon, open: () => useWorkspaceStore.getState().openApp(item.app, item.section) });
  }
  return [...results.values()];
}

export function CommandPalette({ roots, isAdmin, onClose }: { roots: Root[]; isAdmin: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const activeRootSlug = useWorkspaceStore((state) => state.windows.find((window) => window.id === state.activeWindowId)?.rootSlug);
  const recent = useRecentStore((state) => state.folders);
  const externalApps = useExternalApps().data;
  const items = useMemo(() => suggestions(query, roots, activeRootSlug, recent, isAdmin, externalApps ?? []), [query, roots, activeRootSlug, recent, isAdmin, externalApps]);

  function open(target: Target | undefined) {
    if (!target) return;
    target.open();
    onClose();
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[900] bg-overlay" />
        <Dialog.Popup aria-label={t("Quick open")} className="fixed top-[18vh] left-1/2 z-[900] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 kago-glass overflow-hidden rounded-lg outline-none">
          <label className="flex h-11 items-center gap-2 border-b border-line px-3">
            <Search className="text-muted" />
            <input
              autoFocus
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
              placeholder={t("Type a location or a feature, or photos:/2026 to open a path")}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (items.length) setIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  open(items[index]);
                }
              }}
            />
          </label>
          <ul className="m-0 max-h-72 list-none overflow-y-auto p-1">
            {items.length === 0 ? <li className="px-3 py-6 text-center text-muted">{t("Nothing to open")}</li> : null}
            {items.map((item, itemIndex) => (
              <li key={item.key}>
                <button
                  className={cn("flex h-8 w-full items-center gap-2 rounded-[calc(var(--kago-radius-md)+1px)] [corner-shape:squircle] px-2 text-left", itemIndex === index && "kago-selection")}
                  onMouseMove={() => setIndex(itemIndex)}
                  onClick={() => open(item)}
                >
                  {item.icon}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className={cn("truncate text-xs", itemIndex === index ? "opacity-80" : "text-faint")}>{item.hint}</span>
                </button>
              </li>
            ))}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
