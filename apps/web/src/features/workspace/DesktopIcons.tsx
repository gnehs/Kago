import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, HardDrive, Pencil, Plus, Server, Trash2 } from "lucide-react";
import { useExternalApps } from "@/api/hooks";
import { KagoAppIcon } from "@/components/kago/app-icon";
import { KagoContextMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { editExternalApp } from "@/features/apps/ExternalAppDialog";
import { ExternalAppIcon } from "@/features/apps/ExternalAppIcon";
import { appHref, openExternalApp, removeExternalApp } from "@/features/apps/externalApps";
import { copyText } from "@/lib/utils";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileWindow, Root } from "@/types/kago";
import { t } from "@/lib/i18n";
import { run } from "@/lib/run";

/**
 * Desktop shortcuts: the places you go to. They sit underneath every window.
 * Files stands for every location: which of them a window shows is picked in the window, from the tree down its side.
 * After Kago's own come the other services of the machine, each a link that opens in a tab of its own.
 */
export function DesktopIcons({ roots, isAdmin }: { roots: Root[]; isAdmin: boolean }) {
  const store = useWorkspaceStore.getState;
  const queryClient = useQueryClient();
  const apps = useExternalApps().data ?? [];
  // A new window starts in a location on this machine when there is one: it answers at once and is always there.
  const home = roots.find((root) => root.provider === "local") ?? roots[0];
  const openNew = (root: Root) => store().openWindow({ rootSlug: root.slug, logicalPath: "/", title: root.name });
  /** Brings back the file window last in front, and opens one only when there is none. */
  const openFiles = (home: Root) => {
    const front = store().windows.reduce<FileWindow | undefined>((top, window) => (top && top.zIndex > window.zIndex ? top : window), undefined);
    if (!front) return openNew(home);
    store().updateWindow(front.id, { minimized: false });
    store().focusWindow(front.id);
  };

  return (
    <div className="absolute inset-y-4 left-4 flex flex-col flex-wrap content-start gap-1">
      {home ? (
        <KagoContextMenu
          menu={
            <>
              <KagoMenuItem icon={<ExternalLink />} onClick={() => openNew(home)}>{t("Open in new window")}</KagoMenuItem>
              <KagoMenuSeparator />
              {roots.map((root) => (
                <KagoMenuItem key={root.id} icon={root.provider === "local" ? <HardDrive /> : <Server />} onClick={() => store().openRoot(root)}>{root.name}</KagoMenuItem>
              ))}
            </>
          }
        >
          <DesktopIcon
            icon={GLYPHS.files}
            tone="var(--kago-app-1)"
            label={t("Files")}
            onClick={(event) => (event.metaKey || event.ctrlKey ? openNew(home) : openFiles(home))}
            onAuxClick={(event) => event.button === 1 && openNew(home)}
          />
        </KagoContextMenu>
      ) : null}
      <DesktopIcon icon={GLYPHS.shares} tone="var(--kago-app-share)" label={t("Shares")} onClick={() => store().openApp("shares")} />
      <DesktopIcon icon={GLYPHS.trash} tone="var(--kago-app-trash)" label={t("Trash")} onClick={() => store().openApp("trash")} />
      {apps.map((app) => (
        <KagoContextMenu
          key={app.id}
          menu={
            <>
              <KagoMenuItem icon={<ExternalLink />} onClick={() => openExternalApp(app)}>{t("Open in new tab")}</KagoMenuItem>
              <KagoMenuItem icon={<Copy />} onClick={() => void run(() => copyText(app.url))}>{t("Copy address")}</KagoMenuItem>
              <KagoMenuSeparator />
              {app.editable ? (
                <>
                  <KagoMenuItem icon={<Pencil />} onClick={() => editExternalApp(app)}>{t("Edit…")}</KagoMenuItem>
                  <KagoMenuItem icon={<Trash2 />} destructive onClick={() => void removeExternalApp(queryClient, app)}>{t("Remove")}</KagoMenuItem>
                  <KagoMenuSeparator />
                </>
              ) : null}
              <KagoMenuItem icon={<Plus />} onClick={() => editExternalApp("new")}>{t("Add app…")}</KagoMenuItem>
            </>
          }
        >
          {/* A link, so that the browser's own ways of opening one (middle click, the address on hover) all work. */}
          <a href={appHref(app)} target="_blank" rel="noopener noreferrer" draggable={false} className={ICON_CLASS}>
            <DesktopIconBody icon={<ExternalAppIcon name={app.name} icon={app.icon} className="size-full" />} label={app.name} />
          </a>
        </KagoContextMenu>
      ))}
      {home ? null : (
        <p className="m-0 w-20 px-1 pt-2 text-center text-xs text-muted">{isAdmin ? t("No folders under /data yet") : t("No locations available. Contact an administrator")}</p>
      )}
    </div>
  );
}

/** Which of the eight location colours a location wears. It follows from the slug, so it stays the same everywhere and every time. */
export function locationTone(slug: string) {
  let sum = 0;
  for (const character of slug) sum += character.codePointAt(0)!;
  return (sum % 8) + 1;
}

/** What each tile holds, on a 24px field. Nothing here has a colour: the tile paints it. */
const GLYPHS = {
  files: (
    <KagoAppIcon texture="weave">
      <path d="M2.5 6.7a2.2 2.2 0 0 1 2.2-2.2h3.8a2.2 2.2 0 0 1 1.8 1l.8 1.2a2.2 2.2 0 0 0 1.8 1h6.4a2.2 2.2 0 0 1 2.2 2.2v7.4a2.2 2.2 0 0 1-2.2 2.2H4.7a2.2 2.2 0 0 1-2.2-2.2z" fillOpacity={0.62} />
      <path d="M2.5 11.9a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2v5.4a2.2 2.2 0 0 1-2.2 2.2H4.7a2.2 2.2 0 0 1-2.2-2.2z" />
    </KagoAppIcon>
  ),
  shares: (
    <KagoAppIcon texture="rings">
      <path d="M17 6 7 12l10 6" fill="none" strokeWidth={2.2} />
      <circle cx="17.4" cy="5.8" r="3" />
      <circle cx="6.6" cy="12" r="3" />
      <circle cx="17.4" cy="18.2" r="3" />
    </KagoAppIcon>
  ),
  trash: (
    <KagoAppIcon texture="slats">
      <path d="M9.2 5v-.7a1.5 1.5 0 0 1 1.5-1.5h2.6a1.5 1.5 0 0 1 1.5 1.5V5h3.7a1.1 1.1 0 0 1 0 2.2h-13a1.1 1.1 0 0 1 0-2.2zm1.5 0h2.6v-.5a.3.3 0 0 0-.3-.3h-2a.3.3 0 0 0-.3.3z" fillRule="evenodd" />
      <path d="M6.3 8.7h11.4l-.8 10.3a2.2 2.2 0 0 1-2.2 2H9.3a2.2 2.2 0 0 1-2.2-2zm3.3 2.3a.7.7 0 0 0-.7.75l.4 6a.7.7 0 0 0 1.4-.1l-.4-6a.7.7 0 0 0-.7-.65zm4.8 0a.7.7 0 0 0-.7.65l-.4 6a.7.7 0 0 0 1.4.1l.4-6a.7.7 0 0 0-.7-.75z" fillRule="evenodd" />
    </KagoAppIcon>
  )
};

const ICON_CLASS = "group flex w-20 flex-col items-center gap-1.5 rounded-lg px-1 py-2 text-inherit no-underline outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50";

function DesktopIcon({ icon, label, tone, ...props }: React.ComponentProps<"button"> & { icon: ReactNode; label: string; /** The colour of the tile. */ tone: string }) {
  return (
    <button type="button" className={ICON_CLASS} {...props}>
      <DesktopIconBody icon={icon} label={label} tone={tone} />
    </button>
  );
}

/** What every desktop icon is made of, whether it is a button of Kago's or a link out of it. */
function DesktopIconBody({ icon, label, tone }: { icon: ReactNode; label: string; tone?: string }) {
  return (
    <>
      <span className="flex size-12 transition-transform group-active:scale-95" style={{ color: tone }}>{icon}</span>
      {/* Over a picture the name has to carry its own contrast. */}
      <span className="line-clamp-2 max-w-full text-center leading-tight break-words group-data-[wallpaper]/canvas:text-white group-data-[wallpaper]/canvas:[text-shadow:0_1px_3px_rgb(0_0_0/0.85)]">{label}</span>
    </>
  );
}
