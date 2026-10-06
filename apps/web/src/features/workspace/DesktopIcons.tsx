import type { ReactNode } from "react";
import { HardDrive, Settings, Share2, Trash2 } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Root } from "@/types/kago";

/**
 * Desktop shortcuts. They sit underneath every window and double as the root picker:
 * Kago never opens a root on its own, the user picks one here.
 */
export function DesktopIcons({ roots, isAdmin }: { roots: Root[]; isAdmin: boolean }) {
  const store = useWorkspaceStore.getState;

  return (
    <div className="absolute inset-y-4 left-4 flex flex-col flex-wrap content-start gap-1">
      {roots.map((root) => (
        <DesktopIcon
          key={root.id}
          icon={<HardDrive />}
          label={root.name}
          hint={root.readonly ? "唯讀" : undefined}
          onClick={(event) => (event.metaKey || event.ctrlKey ? store().openWindow({ rootSlug: root.slug, logicalPath: "/", title: root.name }) : store().openRoot(root))}
          onAuxClick={(event) => event.button === 1 && store().openWindow({ rootSlug: root.slug, logicalPath: "/", title: root.name })}
        />
      ))}
      <DesktopIcon icon={<Share2 />} label="分享" onClick={() => store().openApp("shares")} />
      <DesktopIcon icon={<Trash2 />} label="垃圾桶" onClick={() => store().openApp("trash")} />
      <DesktopIcon icon={<Settings />} label="設定" onClick={() => store().openApp("settings")} />
      {roots.length === 0 ? (
        <p className="m-0 w-20 px-1 pt-2 text-center text-xs text-muted">{isAdmin ? "到「設定」新增第一個位置" : "尚無可用的位置，請聯絡管理員"}</p>
      ) : null}
    </div>
  );
}

function DesktopIcon({ icon, label, hint, ...props }: React.ComponentProps<"button"> & { icon: ReactNode; label: string; hint?: string }) {
  return (
    <button
      type="button"
      className="group flex w-20 flex-col items-center gap-1 rounded-lg px-1 py-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50"
      {...props}
    >
      <span className="flex size-11 items-center justify-center rounded-lg bg-surface text-muted shadow-popup group-hover:text-accent [&>.lucide]:size-5">{icon}</span>
      <span className="line-clamp-2 max-w-full text-center leading-tight break-words">{label}</span>
      {hint ? <span className="-mt-0.5 text-xs text-faint">{hint}</span> : null}
    </button>
  );
}
