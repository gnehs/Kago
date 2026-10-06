import type { ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Clock, HardDrive, KeyRound, ListChecks, LogOut, Monitor, Moon, PanelLeft, ScrollText, Search, Settings, Share2, Sun, Trash2, UserRound, UsersRound } from "lucide-react";
import { api } from "@/api/client";
import { useTasks } from "@/api/hooks";
import { KagoBadge } from "@/components/kago/badge";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoTooltip } from "@/components/kago/tooltip";
import { BrandMark } from "@/features/auth/AuthCard";
import { isActiveTask } from "@/features/tasks/taskUtils";
import { baseName } from "@/lib/paths";
import { getTheme, setTheme, type ThemePref } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { useRecentStore } from "@/stores/recent";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Actor, Root } from "@/types/kago";
import { useState } from "react";
import { pagePaths, type WorkspacePage } from "./routes";

const themeOrder: ThemePref[] = ["system", "light", "dark"];
const themeMeta: Record<ThemePref, { label: string; icon: ReactNode }> = {
  system: { label: "外觀：跟隨系統", icon: <Monitor /> },
  light: { label: "外觀：淺色", icon: <Sun /> },
  dark: { label: "外觀：深色", icon: <Moon /> }
};

export function Sidebar({ user, roots, page, onOpenPalette }: { user: Actor; roots: Root[]; page: WorkspacePage | null; onOpenPalette: () => void }) {
  const collapsed = useWorkspaceStore((state) => Boolean(state.sidebar.collapsed));
  const activeRootSlug = useWorkspaceStore((state) => state.windows.find((window) => window.id === state.activeWindowId)?.rootSlug);
  const recent = useRecentStore((state) => state.folders);
  const tasks = useTasks();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [theme, setThemeState] = useState(getTheme);
  const activeTaskCount = (tasks.data ?? []).filter(isActiveTask).length;
  const store = useWorkspaceStore.getState;

  function openRoot(root: Root, newWindow: boolean) {
    if (page) navigate("/");
    if (newWindow) store().openWindow({ rootSlug: root.slug, logicalPath: "/", title: root.name });
    else store().openRoot(root);
  }

  function openRecent(rootSlug: string, path: string) {
    if (page) navigate("/");
    store().openWindow({ rootSlug, logicalPath: path, title: baseName(path) });
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

  const pageItem = (target: WorkspacePage, icon: ReactNode, label: string, trailing?: ReactNode) => (
    <SidebarItem icon={icon} label={label} collapsed={collapsed} active={page === target} trailing={trailing} onClick={() => navigate(pagePaths[target])} />
  );

  return (
    <aside className={cn("flex shrink-0 flex-col border-r border-line bg-elevated transition-[width] duration-150", collapsed ? "w-12" : "w-56")}>
      <header className={cn("flex h-11 shrink-0 items-center gap-2 px-2.5", collapsed && "justify-center px-0")}>
        {collapsed ? null : (
          <>
            <BrandMark className="size-6 text-xs" />
            <strong className="flex-1 font-semibold">Kago</strong>
          </>
        )}
        <KagoIconButton label={collapsed ? "展開側邊欄" : "收合側邊欄"} onClick={() => store().updateSidebar({ collapsed: !collapsed })}>
          <PanelLeft />
        </KagoIconButton>
      </header>

      <nav className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2">
        <SidebarSection>
          <SidebarItem icon={<Search />} label="快速開啟" collapsed={collapsed} trailing={<kbd className="font-sans text-xs text-faint">⌘K</kbd>} onClick={onOpenPalette} />
        </SidebarSection>

        <SidebarSection title="位置" collapsed={collapsed}>
          {roots.map((root) => (
            <SidebarItem
              key={root.id}
              icon={<HardDrive />}
              label={root.name}
              collapsed={collapsed}
              active={!page && activeRootSlug === root.slug}
              trailing={root.readonly ? <KagoBadge>唯讀</KagoBadge> : null}
              onClick={(event) => openRoot(root, event.metaKey || event.ctrlKey)}
              onAuxClick={(event) => event.button === 1 && openRoot(root, true)}
            />
          ))}
          {roots.length === 0 && !collapsed ? <p className="m-0 px-2 py-1 text-faint">尚無可用的位置</p> : null}
        </SidebarSection>

        {recent.length > 0 && !collapsed ? (
          <SidebarSection title="最近" collapsed={collapsed}>
            {recent.map((folder) => (
              <SidebarItem key={`${folder.rootSlug}:${folder.path}`} icon={<Clock />} label={baseName(folder.path)} title={`${folder.rootSlug}:${folder.path}`} collapsed={collapsed} onClick={() => openRecent(folder.rootSlug, folder.path)} />
            ))}
          </SidebarSection>
        ) : null}

        <SidebarSection title="工作區" collapsed={collapsed}>
          {pageItem("tasks", <ListChecks />, "任務", activeTaskCount > 0 ? <KagoBadge tone="accent">{activeTaskCount}</KagoBadge> : null)}
          {pageItem("shares", <Share2 />, "分享")}
          {pageItem("trash", <Trash2 />, "垃圾桶")}
        </SidebarSection>

        {user.role === "ADMIN" ? (
          <SidebarSection title="管理" collapsed={collapsed}>
            {pageItem("users", <UserRound />, "使用者")}
            {pageItem("groups", <UsersRound />, "群組")}
            {pageItem("permissions", <KeyRound />, "權限")}
            {pageItem("audit", <ScrollText />, "稽核紀錄")}
          </SidebarSection>
        ) : null}
      </nav>

      <footer className={cn("flex shrink-0 items-center gap-1 border-t border-line p-2", collapsed && "flex-col")}>
        {collapsed ? null : (
          <div className="min-w-0 flex-1 px-1">
            <div className="truncate font-medium">{user.displayName}</div>
            <div className="truncate text-xs text-muted">{user.email}</div>
          </div>
        )}
        <KagoIconButton label={themeMeta[theme].label} onClick={cycleTheme}>{themeMeta[theme].icon}</KagoIconButton>
        <KagoIconButton label="設定" active={page === "settings"} onClick={() => navigate(pagePaths.settings)}><Settings /></KagoIconButton>
        <KagoIconButton label="登出" onClick={() => void logout()}><LogOut /></KagoIconButton>
      </footer>
    </aside>
  );
}

function SidebarSection({ title, collapsed, children }: { title?: string; collapsed?: boolean; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-px">
      {title && !collapsed ? <h2 className="m-0 px-2 pb-1 text-xs font-medium text-faint">{title}</h2> : null}
      {children}
    </section>
  );
}

function SidebarItem({ icon, label, title, collapsed, active, trailing, ...props }: React.ComponentProps<"button"> & { icon: ReactNode; label: string; collapsed: boolean; active?: boolean; trailing?: ReactNode }) {
  const button = (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      aria-label={collapsed ? label : undefined}
      title={collapsed ? undefined : title}
      className={cn(
        "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-ink outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50 [&>.lucide]:text-muted",
        active && "bg-accent-soft hover:bg-accent-soft [&>.lucide]:text-accent",
        collapsed && "justify-center px-0"
      )}
      {...props}
    >
      {icon}
      {collapsed ? null : (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing}
        </>
      )}
    </button>
  );
  return collapsed ? <KagoTooltip label={label}>{button}</KagoTooltip> : button;
}
