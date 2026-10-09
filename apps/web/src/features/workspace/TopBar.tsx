import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Popover } from "@base-ui/react/popover";
import { ListChecks, LogOut, Search, Settings } from "lucide-react";
import { api } from "@/api/client";
import { useRoots, useTasks } from "@/api/hooks";
import { avatarUrl, KagoAvatar } from "@/components/kago/avatar";
import { KagoSpinner } from "@/components/kago/empty-state";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/features/auth/AuthCard";
import { markSignedOut } from "@/features/auth/sso";
import { TaskRow } from "@/features/tasks/TaskRow";
import { isActiveTask, isFinishedTask, isQuietTask } from "@/features/tasks/taskUtils";
import { useClearFinishedTasks } from "@/features/tasks/useClearFinishedTasks";
import { displayPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { ExternalAppGlyph } from "@/features/apps/ExternalAppIcon";
import { FileIcon } from "@/features/files/FileIcon";
import { appIcons } from "@/features/windows/AppWindow";
import { minimizeWindows, useWorkspaceStore, type WindowFrame } from "@/stores/workspace";
import type { Actor } from "@/types/kago";
import { t } from "@/lib/i18n";

/** The workspace's only chrome: open windows on the left, status and account on the right. */
export function TopBar({ user, onOpenPalette }: { user: Actor; onOpenPalette: () => void }) {
  const windows = useWorkspaceStore((state) => state.windows);
  const appWindows = useWorkspaceStore((state) => state.appWindows);
  const previewWindows = useWorkspaceStore((state) => state.previewWindows);
  const ordered = [...windows, ...appWindows, ...previewWindows].sort((a, b) => a.createdAt - b.createdAt);
  const anyVisible = ordered.some((window) => !window.minimized);
  const roots = useRoots().data;
  const rootName = (slug: string) => roots?.find((root) => root.slug === slug)?.name ?? slug;

  /** Taskbar behaviour: restore or focus a window, or minimize it when it is already in front. */
  function activate(window: WindowFrame) {
    const store = useWorkspaceStore.getState();
    if (window.focused && !window.minimized) {
      minimizeWindows([window.id]);
      return;
    }
    store.updateWindow(window.id, { minimized: false });
    store.focusWindow(window.id);
  }

  /** Clears the desktop by minimizing everything, or brings it all back when already clear. */
  function toggleDesktop() {
    if (anyVisible) {
      minimizeWindows(ordered.filter((window) => !window.minimized).map((window) => window.id));
      return;
    }
    const store = useWorkspaceStore.getState();
    for (const window of ordered) store.updateWindow(window.id, { minimized: false });
  }

  return (
    <header className="kago-chrome z-[1] flex h-10 shrink-0 items-center gap-1 border-b border-line-strong px-2">
      <button
        className="flex h-7 shrink-0 items-center gap-2 rounded-md pr-2.5 pl-1.5 font-semibold outline-none kago-flat focus-visible:ring-2 focus-visible:ring-accent/50"
        title={anyVisible ? t("Show desktop") : t("Restore all windows")}
        onClick={toggleDesktop}
      >
        <BrandMark className="size-5" />
        Kago
      </button>

      <nav aria-label={t("Open windows")} className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden px-1">
        {ordered.map((window) => (
          <button
            key={window.id}
            data-dock={window.id}
            title={"rootSlug" in window ? displayPath(rootName(window.rootSlug), window.logicalPath) : "preview" in window ? displayPath(rootName(window.preview.rootSlug), window.preview.item.path) : window.title}
            aria-pressed={window.focused && !window.minimized}
            className={cn(
              "flex h-7 max-w-40 min-w-0 items-center gap-1.5 rounded-md px-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
              window.focused && !window.minimized ? "kago-raised" : "kago-flat text-muted",
              window.minimized && "opacity-60"
            )}
            onClick={() => activate(window)}
          >
            {"app" in window ? (window.app === "external" ? <ExternalAppGlyph icon={window.external.icon} /> : appIcons[window.app]) : "preview" in window ? <FileIcon item={window.preview.item} /> : <FileIcon item={{ kind: "folder", type: "", name: "" }} />}
            <span className="truncate">{window.title}</span>
          </button>
        ))}
      </nav>

      <button
        className="kago-well flex h-7 shrink-0 items-center gap-2 rounded-full pr-2.5 pl-2.5 text-faint outline-none hover:text-muted focus-visible:ring-2 focus-visible:ring-accent/50"
        onClick={onOpenPalette}
      >
        <Search className="size-3.5" />
        <span className="hidden sm:inline">{t("Quick open")}</span>
        <kbd className="font-sans text-xs">⌘K</kbd>
      </button>
      <TaskStatus />
      <UserMenu user={user} />
    </header>
  );
}

/** Who is signed in, at the far end of the bar: their picture, and behind it what belongs to the account. */
function UserMenu({ user }: { user: Actor }) {
  const queryClient = useQueryClient();
  const name = user.displayName || user.email;
  const picture = avatarUrl(user.id, user.avatar);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    markSignedOut();
    await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
  }

  return (
    <KagoDropdownMenu
      label={t("Account")}
      className="size-7 rounded-full"
      menu={
        <>
          <div className="flex max-w-64 items-center gap-2.5 px-2 pt-1.5 pb-2">
            <KagoAvatar name={name} picture={picture} className="size-9 text-sm" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate font-medium">{user.displayName}</span>
              <span className="truncate text-xs text-muted">{user.email}</span>
            </div>
          </div>
          <KagoMenuSeparator />
          <KagoMenuItem icon={<Settings />} onClick={() => useWorkspaceStore.getState().openApp("settings")}>{t("Settings")}</KagoMenuItem>
          <KagoMenuItem icon={<LogOut />} onClick={() => void logout()}>{t("Sign out")}</KagoMenuItem>
        </>
      }
    >
      <KagoAvatar name={name} picture={picture} className="size-6" />
    </KagoDropdownMenu>
  );
}

/** Live task indicator; the popover lists the latest tasks without leaving the desktop. */
function TaskStatus() {
  const tasks = useTasks();
  const clear = useClearFinishedTasks();
  const [open, setOpen] = useState(false);
  const all = (tasks.data ?? []).filter((task) => !isQuietTask(task));
  const activeCount = all.filter(isActiveTask).length;
  // Active tasks first, then the most recent finished ones.
  const visible = [...all.filter(isActiveTask), ...all.filter((task) => !isActiveTask(task))].slice(0, 5);

  const label = activeCount > 0 ? t("{count} task in progress | {count} tasks in progress", { count: activeCount }) : t("Tasks");

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        aria-label={label}
        title={label}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center kago-flat rounded-md text-muted outline-none hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50",
          activeCount > 0 && "text-accent hover:text-accent"
        )}
      >
        {activeCount > 0 ? <KagoSpinner className="text-accent" /> : <ListChecks />}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-[700]">
          <Popover.Popup className="kago-glass kago-pop flex w-80 flex-col rounded-lg outline-none">
            {visible.length === 0 ? (
              <p className="m-0 px-4 py-6 text-center text-muted">{t("No tasks right now")}</p>
            ) : (
              <div className="flex max-h-96 flex-col divide-y divide-line overflow-y-auto px-3">
                {visible.map((task) => <TaskRow key={task.id} task={task} />)}
              </div>
            )}
            <div className="m-1.5 flex gap-1.5">
              <Button
                variant="ghost"
                className="flex-1"
                onClick={() => {
                  setOpen(false);
                  useWorkspaceStore.getState().openApp("tasks");
                }}
              >
                {t("See all tasks")}
              </Button>
              {all.some(isFinishedTask) ? (
                <Button variant="ghost" className="flex-1" onClick={() => void clear()}>
                  {t("Clear finished")}
                </Button>
              ) : null}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
