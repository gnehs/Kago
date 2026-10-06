import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Popover } from "@base-ui/react/popover";
import { Folder, ListChecks, LogOut, Monitor, Moon, Search, Settings, Sun } from "lucide-react";
import { api } from "@/api/client";
import { useTasks } from "@/api/hooks";
import { KagoSpinner } from "@/components/kago/empty-state";
import { KagoIconButton } from "@/components/kago/icon-button";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/features/auth/AuthCard";
import { TaskRow } from "@/features/tasks/TaskRow";
import { isActiveTask } from "@/features/tasks/taskUtils";
import { getTheme, setTheme, type ThemePref } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { appIcons } from "@/features/windows/AppWindow";
import { useWorkspaceStore, type WindowFrame } from "@/stores/workspace";
import type { Actor } from "@/types/kago";

const themeOrder: ThemePref[] = ["system", "light", "dark"];
const themeMeta: Record<ThemePref, { label: string; icon: ReactNode }> = {
  system: { label: "外觀：跟隨系統", icon: <Monitor /> },
  light: { label: "外觀：淺色", icon: <Sun /> },
  dark: { label: "外觀：深色", icon: <Moon /> }
};

/** The workspace's only chrome: open windows on the left, status and account on the right. */
export function TopBar({ user, onOpenPalette }: { user: Actor; onOpenPalette: () => void }) {
  const queryClient = useQueryClient();
  const windows = useWorkspaceStore((state) => state.windows);
  const appWindows = useWorkspaceStore((state) => state.appWindows);
  const settingsFocused = appWindows.some((window) => window.app === "settings" && window.focused && !window.minimized);
  const [theme, setThemeState] = useState(getTheme);
  const ordered = [...windows, ...appWindows].sort((a, b) => a.createdAt - b.createdAt);
  const anyVisible = ordered.some((window) => !window.minimized);

  /** Taskbar behaviour: restore or focus a window, or minimize it when it is already in front. */
  function activate(window: WindowFrame) {
    const store = useWorkspaceStore.getState();
    if (window.focused && !window.minimized) {
      store.updateWindow(window.id, { minimized: true });
      return;
    }
    store.updateWindow(window.id, { minimized: false });
    store.focusWindow(window.id);
  }

  /** Clears the desktop by minimizing everything, or brings it all back when already clear. */
  function toggleDesktop() {
    const store = useWorkspaceStore.getState();
    for (const window of ordered) store.updateWindow(window.id, { minimized: anyVisible });
  }

  function cycleTheme() {
    const next = themeOrder[(themeOrder.indexOf(theme) + 1) % themeOrder.length]!;
    setTheme(next);
    setThemeState(next);
  }

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
  }

  return (
    <header className="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-elevated px-2">
      <button
        className="flex h-7 shrink-0 items-center gap-2 rounded-md pr-2.5 pl-1.5 font-semibold outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50"
        title={anyVisible ? "顯示桌面" : "還原所有視窗"}
        onClick={toggleDesktop}
      >
        <BrandMark className="size-5 text-xs" />
        Kago
      </button>

      <nav aria-label="開啟的視窗" className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden px-1">
        {ordered.map((window) => (
          <button
            key={window.id}
            title={"rootSlug" in window ? `${window.rootSlug}:${window.logicalPath}` : window.title}
            aria-pressed={window.focused && !window.minimized}
            className={cn(
              "flex h-7 max-w-40 min-w-0 items-center gap-1.5 rounded-md px-2 outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50",
              window.focused && !window.minimized ? "bg-surface ring-1 ring-line-strong hover:bg-surface" : "text-muted",
              window.minimized && "opacity-60"
            )}
            onClick={() => activate(window)}
          >
            {"app" in window ? appIcons[window.app] : <Folder className="fill-folder/25 text-folder" />}
            <span className="truncate">{window.title}</span>
          </button>
        ))}
      </nav>

      <button
        className="flex h-7 shrink-0 items-center gap-2 rounded-md border border-line bg-surface pr-1.5 pl-2 text-faint outline-none hover:border-line-strong focus-visible:ring-2 focus-visible:ring-accent/50"
        onClick={onOpenPalette}
      >
        <Search className="size-3.5" />
        <span className="hidden sm:inline">快速開啟</span>
        <kbd className="font-sans text-xs">⌘K</kbd>
      </button>
      <TaskStatus />
      <KagoIconButton label={themeMeta[theme].label} onClick={cycleTheme}>{themeMeta[theme].icon}</KagoIconButton>
      <KagoIconButton label="設定" active={settingsFocused} onClick={() => useWorkspaceStore.getState().openApp("settings")}><Settings /></KagoIconButton>
      <KagoIconButton label={`登出 ${user.email}`} onClick={() => void logout()}><LogOut /></KagoIconButton>
    </header>
  );
}

/** Live task indicator; the popover lists the latest tasks without leaving the desktop. */
function TaskStatus() {
  const tasks = useTasks();
  const [open, setOpen] = useState(false);
  const all = tasks.data ?? [];
  const activeCount = all.filter(isActiveTask).length;
  // Active tasks first, then the most recent finished ones.
  const visible = [...all.filter(isActiveTask), ...all.filter((task) => !isActiveTask(task))].slice(0, 5);

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={cn(
          "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-muted outline-none hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-accent/50 data-[popup-open]:bg-hover",
          activeCount > 0 && "text-accent hover:text-accent"
        )}
      >
        {activeCount > 0 ? <KagoSpinner className="text-accent" /> : <ListChecks />}
        {activeCount > 0 ? `${activeCount} 個任務進行中` : "任務"}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={6} align="end" className="z-[700]">
          <Popover.Popup className="flex w-80 flex-col rounded-lg bg-surface shadow-popup outline-none">
            {visible.length === 0 ? (
              <p className="m-0 px-4 py-6 text-center text-muted">目前沒有任務</p>
            ) : (
              <div className="flex max-h-96 flex-col divide-y divide-line overflow-y-auto px-3">
                {visible.map((task) => <TaskRow key={task.id} task={task} />)}
              </div>
            )}
            <Button
              variant="ghost"
              className="m-1.5 border-t border-transparent"
              onClick={() => {
                setOpen(false);
                useWorkspaceStore.getState().openApp("tasks");
              }}
            >
              查看所有任務
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
