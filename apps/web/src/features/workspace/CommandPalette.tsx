import { Fragment, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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

/** What the list is divided into, in the order it is shown. */
const groupLabels = { locations: t("Locations"), recent: t("Recent folders"), apps: t("Apps"), kago: "Kago" };

type Target = { key: string; group: keyof typeof groupLabels; label: string; hint: string; icon: ReactNode; open: () => void };

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
  const pushFolder = (rootSlug: string, logicalPath: string, label: string, icon: ReactNode, group: Target["group"] = "locations") => {
    const key = `${rootSlug}:${logicalPath}`;
    if (results.has(key)) return;
    const rootName = roots.find((root) => root.slug === rootSlug)?.name ?? rootSlug;
    // The location itself is already named by its label.
    results.set(key, { key, group, label, hint: logicalPath === "/" ? "" : displayPath(rootName, logicalPath), icon, open: () => useWorkspaceStore.getState().openWindow({ rootSlug, logicalPath, title: label }) });
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
    if (!lower || label.toLowerCase().includes(lower)) pushFolder(folder.rootSlug, folder.path, label, <Clock />, "recent");
  }
  // The other services on the desktop are places to go as well; they open in a tab of their own.
  for (const item of externalApps) {
    if (lower && !item.name.toLowerCase().includes(lower)) continue;
    results.set(`external:${item.id}`, { key: `external:${item.id}`, group: "apps", label: item.name, hint: appHost(item), icon: <ExternalAppGlyph icon={item.icon} />, open: () => openExternalApp(item) });
  }
  for (const item of apps) {
    if ((item.adminOnly && !isAdmin) || (lower && !item.label.toLowerCase().includes(lower))) continue;
    const key = `app:${item.app}:${item.section ?? ""}`;
    results.set(key, { key, group: "kago", label: item.label, hint: item.section && item.section !== "general" ? t("Settings") : "", icon: item.icon, open: () => useWorkspaceStore.getState().openApp(item.app, item.section) });
  }
  return [...results.values()];
}

/** The label of a row, with the part that was typed set a little heavier, so the eye finds why it is listed. */
function Matched({ label, query }: { label: string; query: string }) {
  const at = query ? label.toLowerCase().indexOf(query) : -1;
  if (at < 0) return label;
  return (
    <>
      {label.slice(0, at)}
      <mark className="bg-transparent font-semibold text-inherit">{label.slice(at, at + query.length)}</mark>
      {label.slice(at + query.length)}
    </>
  );
}

const Key = ({ children }: { children: ReactNode }) => <kbd className="kago-badge flex h-4.5 min-w-4.5 items-center justify-center rounded-[5px] px-1 font-sans text-[11px] text-muted">{children}</kbd>;

export function CommandPalette({ open, roots, isAdmin, onClose }: { open: boolean; roots: Root[]; isAdmin: boolean; onClose: () => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="kago-pop fixed inset-0 z-[900] bg-overlay" />
        <Dialog.Popup aria-label={t("Quick open")} className="kago-pop fixed top-[18vh] left-1/2 z-[900] flex max-h-[calc(82vh-16px)] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 flex-col kago-glass overflow-hidden rounded-lg outline-none">
          {/* What was typed belongs to one opening: the next one starts empty. */}
          <Palette roots={roots} isAdmin={isAdmin} onClose={onClose} />
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Palette({ roots, isAdmin, onClose }: { roots: Root[]; isAdmin: boolean; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const activeRootSlug = useWorkspaceStore((state) => state.windows.find((window) => window.id === state.activeWindowId)?.rootSlug);
  const recent = useRecentStore((state) => state.folders);
  const externalApps = useExternalApps().data;
  const items = useMemo(() => suggestions(query, roots, activeRootSlug, recent, isAdmin, externalApps ?? []), [query, roots, activeRootSlug, recent, isAdmin, externalApps]);
  const typed = nfc(query.trim()).toLowerCase();

  function open(target: Target | undefined) {
    if (!target) return;
    target.open();
    onClose();
  }

  const list = useRef<HTMLUListElement>(null);
  /** Set when the choice was moved with the keyboard, which is when it has to be brought into sight. */
  const follow = useRef(false);

  function choose(next: (current: number) => number) {
    follow.current = true;
    setIndex(next);
  }

  // The list is longer than the panel. The pointer only ever chooses what is already in sight, so it never scrolls.
  useLayoutEffect(() => {
    if (!follow.current) return;
    follow.current = false;
    // The first row takes its heading along, so going back to the top shows the top.
    if (index === 0) list.current?.scrollTo({ top: 0 });
    else list.current?.querySelector(`[data-row="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <>
      <label className="flex h-12 shrink-0 items-center gap-2.5 border-b border-line px-3.5">
        <Search className="size-4.5 text-muted" />
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="kago-palette-list"
          aria-activedescendant={items[index] ? `kago-palette-${index}` : undefined}
          className="h-full min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-faint"
          placeholder={t("Type a location or a feature, or photos:/2026 to open a path")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setIndex(0);
          }}
          onKeyDown={(event) => {
            const count = items.length;
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const step = event.key === "ArrowDown" ? 1 : -1;
              if (count) choose((current) => (current + step + count) % count);
            }
            // Home and End move the caret while there is text to move it in.
            if ((event.key === "Home" || event.key === "End") && !query && count) {
              event.preventDefault();
              choose(() => (event.key === "Home" ? 0 : count - 1));
            }
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              open(items[index]);
            }
          }}
        />
      </label>
      <ul ref={list} id="kago-palette-list" role="listbox" aria-label={t("Quick open")} className="m-0 min-h-0 flex-1 list-none scroll-py-1 overflow-y-auto overscroll-contain p-1 select-none">
        {items.length === 0 ? <li className="px-3 py-8 text-center text-muted">{t("Nothing to open")}</li> : null}
        {items.map((item, itemIndex) => (
          <Fragment key={item.key}>
            {item.group !== items[itemIndex - 1]?.group ? <li role="presentation" className="px-2 pt-2 pb-1 text-xs font-medium text-muted first:pt-1">{groupLabels[item.group]}</li> : null}
            <li role="presentation">
              <button
                id={`kago-palette-${itemIndex}`}
                role="option"
                aria-selected={itemIndex === index}
                data-row={itemIndex}
                tabIndex={-1}
                className={cn("flex h-8 w-full items-center gap-2 rounded-[calc(var(--kago-radius-md)+1px)] [corner-shape:squircle] px-2 text-left outline-none [&>.lucide]:text-muted", itemIndex === index && "kago-selection kago-selection-raised [&>.lucide]:text-inherit")}
                onMouseMove={() => itemIndex !== index && setIndex(itemIndex)}
                onClick={() => open(item)}
              >
                {item.icon}
                <span className="min-w-0 flex-1 truncate"><Matched label={item.label} query={typed} /></span>
                <span className={cn("max-w-[50%] truncate text-xs", itemIndex === index ? "opacity-80" : "text-muted")}>{item.hint}</span>
              </button>
            </li>
          </Fragment>
        ))}
      </ul>
      {/* The keys are of no use on a screen that is touched. */}
      <footer className="hidden h-8 shrink-0 items-center gap-3 border-t border-line px-3 text-xs text-muted pointer-fine:flex">
        <span className="flex items-center gap-1.5"><Key>↑</Key><Key>↓</Key>{t("to move")}</span>
        <span className="flex items-center gap-1.5"><Key>↩</Key>{t("to open")}</span>
        <span className="ml-auto flex items-center gap-1.5"><Key>esc</Key>{t("to close")}</span>
      </footer>
    </>
  );
}
