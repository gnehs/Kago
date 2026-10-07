import type { ReactNode } from "react";
import { ExternalLink, FolderOpen, Lock } from "lucide-react";
import { KagoAppIcon } from "@/components/kago/app-icon";
import { KagoContextMenu, KagoMenuItem } from "@/components/kago/menu";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Root } from "@/types/kago";

/**
 * Desktop shortcuts: the places you go to. They sit underneath every window and double as
 * the root picker: Kago never opens a root on its own, the user picks one here.
 * Locations come first, each in a colour of its own so they can be told apart at a glance; the two tools that are not locations follow a rule.
 */
export function DesktopIcons({ roots, isAdmin }: { roots: Root[]; isAdmin: boolean }) {
  const store = useWorkspaceStore.getState;
  const openNew = (root: Root) => store().openWindow({ rootSlug: root.slug, logicalPath: "/", title: root.name });

  return (
    <div className="absolute inset-y-4 left-4 flex flex-col flex-wrap content-start gap-1">
      {roots.map((root) => (
        <KagoContextMenu
          key={root.id}
          menu={
            <>
              <KagoMenuItem icon={<FolderOpen />} onClick={() => store().openRoot(root)}>開啟</KagoMenuItem>
              <KagoMenuItem icon={<ExternalLink />} onClick={() => openNew(root)}>在新視窗開啟</KagoMenuItem>
            </>
          }
        >
          <DesktopIcon
            icon={GLYPHS.location}
            tone={`var(--kago-app-${locationTone(root.slug)})`}
            label={root.name}
            readonly={Boolean(root.readonly)}
            onClick={(event) => (event.metaKey || event.ctrlKey ? openNew(root) : store().openRoot(root))}
            onAuxClick={(event) => event.button === 1 && openNew(root)}
          />
        </KagoContextMenu>
      ))}
      {roots.length > 0 ? <span aria-hidden className="mx-auto my-1.5 h-px w-10 bg-line-strong" /> : null}
      <DesktopIcon icon={GLYPHS.shares} tone="var(--kago-app-share)" label="分享" onClick={() => store().openApp("shares")} />
      <DesktopIcon icon={GLYPHS.trash} tone="var(--kago-app-trash)" label="垃圾桶" onClick={() => store().openApp("trash")} />
      {roots.length === 0 ? (
        <p className="m-0 w-20 px-1 pt-2 text-center text-xs text-muted">{isAdmin ? "/data 底下還沒有資料夾" : "尚無可用的位置，請聯絡管理員"}</p>
      ) : null}
    </div>
  );
}

/** Which of the eight location colours a location wears. It follows from the slug, so it stays the same everywhere and every time. */
function locationTone(slug: string) {
  let sum = 0;
  for (const character of slug) sum += character.codePointAt(0)!;
  return (sum % 8) + 1;
}

/** What each tile holds, on a 24px field. Nothing here has a colour: the tile paints it. */
const GLYPHS = {
  location: (
    <KagoAppIcon texture="rays">
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
    <KagoAppIcon texture="mesh">
      <path d="M9.2 5v-.7a1.5 1.5 0 0 1 1.5-1.5h2.6a1.5 1.5 0 0 1 1.5 1.5V5h3.7a1.1 1.1 0 0 1 0 2.2h-13a1.1 1.1 0 0 1 0-2.2zm1.5 0h2.6v-.5a.3.3 0 0 0-.3-.3h-2a.3.3 0 0 0-.3.3z" fillRule="evenodd" />
      <path d="M6.3 8.7h11.4l-.8 10.3a2.2 2.2 0 0 1-2.2 2H9.3a2.2 2.2 0 0 1-2.2-2zm3.3 2.3a.7.7 0 0 0-.7.75l.4 6a.7.7 0 0 0 1.4-.1l-.4-6a.7.7 0 0 0-.7-.65zm4.8 0a.7.7 0 0 0-.7.65l-.4 6a.7.7 0 0 0 1.4.1l.4-6a.7.7 0 0 0-.7-.75z" fillRule="evenodd" />
    </KagoAppIcon>
  )
};

function DesktopIcon({ icon, label, tone, readonly, ...props }: React.ComponentProps<"button"> & { icon: ReactNode; label: string; /** The colour of the tile. */ tone: string; readonly?: boolean }) {
  return (
    <button
      type="button"
      title={readonly ? `${label}（唯讀）` : undefined}
      className="group flex w-20 flex-col items-center gap-1.5 rounded-lg px-1 py-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50"
      {...props}
    >
      <span className="relative flex size-12 transition-transform group-active:scale-95" style={{ color: tone }}>
        {icon}
        {readonly ? (
          <span className="kago-raised absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full text-muted">
            <Lock aria-label="唯讀" className="size-2.5" />
          </span>
        ) : null}
      </span>
      <span className="line-clamp-2 max-w-full text-center leading-tight break-words">{label}</span>
    </button>
  );
}
