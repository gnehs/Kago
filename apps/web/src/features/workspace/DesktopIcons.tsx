import type { ReactNode } from "react";
import { ExternalLink, FolderOpen, HardDrive, Lock, Share2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { KagoContextMenu, KagoMenuItem } from "@/components/kago/menu";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Root } from "@/types/kago";

/**
 * Desktop shortcuts: the places you go to. They sit underneath every window and double as
 * the root picker: Kago never opens a root on its own, the user picks one here.
 * Locations come first, in the folder colour; the two tools that are not locations follow a rule.
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
            icon={<HardDrive />}
            label={root.name}
            location
            readonly={Boolean(root.readonly)}
            onClick={(event) => (event.metaKey || event.ctrlKey ? openNew(root) : store().openRoot(root))}
            onAuxClick={(event) => event.button === 1 && openNew(root)}
          />
        </KagoContextMenu>
      ))}
      {roots.length > 0 ? <span aria-hidden className="mx-auto my-1.5 h-px w-10 bg-line-strong" /> : null}
      <DesktopIcon icon={<Share2 />} label="分享" onClick={() => store().openApp("shares")} />
      <DesktopIcon icon={<Trash2 />} label="垃圾桶" onClick={() => store().openApp("trash")} />
      {roots.length === 0 ? (
        <p className="m-0 w-20 px-1 pt-2 text-center text-xs text-muted">{isAdmin ? "/data 底下還沒有資料夾" : "尚無可用的位置，請聯絡管理員"}</p>
      ) : null}
    </div>
  );
}

function DesktopIcon({ icon, label, location, readonly, ...props }: React.ComponentProps<"button"> & { icon: ReactNode; label: string; location?: boolean; readonly?: boolean }) {
  return (
    <button
      type="button"
      title={readonly ? `${label}（唯讀）` : undefined}
      className="group flex w-20 flex-col items-center gap-1 rounded-lg px-1 py-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50"
      {...props}
    >
      <span className={cn("relative flex size-11 items-center justify-center rounded-lg bg-surface shadow-popup [&>.lucide]:size-5", location ? "text-folder [&>.lucide]:fill-folder/20" : "text-muted group-hover:text-ink")}>
        {icon}
        {readonly ? (
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-surface text-muted shadow-popup">
            <Lock aria-label="唯讀" className="size-2.5" />
          </span>
        ) : null}
      </span>
      <span className="line-clamp-2 max-w-full text-center leading-tight break-words">{label}</span>
    </button>
  );
}
