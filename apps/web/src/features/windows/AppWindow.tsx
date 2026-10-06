import type { ReactNode } from "react";
import { ListChecks, Settings, Share2, Trash2 } from "lucide-react";
import { AuditPage } from "@/features/admin/AuditPage";
import { GroupsPage } from "@/features/admin/GroupsPage";
import { SettingsLayout } from "@/features/admin/SettingsLayout";
import { SettingsPage } from "@/features/admin/SettingsPage";
import { UsersPage } from "@/features/admin/UsersPage";
import { PermissionsPage } from "@/features/permissions/PermissionsPage";
import { SharesPage } from "@/features/shares/SharesPage";
import { TasksPage } from "@/features/tasks/TasksPage";
import { TrashPage } from "@/features/trash/TrashPage";
import { useWorkspaceStore, type AppKind, type AppWindow } from "@/stores/workspace";
import type { Actor, Root } from "@/types/kago";
import { KagoWindow } from "./KagoWindow";

export const appIcons: Record<AppKind, ReactNode> = {
  settings: <Settings />,
  tasks: <ListChecks />,
  shares: <Share2 />,
  trash: <Trash2 />
};

/** A built-in tool (settings, tasks, shares, trash) shown in the same window chrome as a folder. */
export function AppWindowView({ window, roots, user }: { window: AppWindow; roots: Root[]; user: Actor }) {
  const isAdmin = user.role === "ADMIN";

  return (
    <KagoWindow window={window} icon={<span className="flex text-muted">{appIcons[window.app]}</span>}>
      {window.app === "tasks" ? <TasksPage /> : null}
      {window.app === "shares" ? <SharesPage roots={roots} /> : null}
      {window.app === "trash" ? <TrashPage /> : null}
      {window.app === "settings" ? (
        <SettingsLayout section={isAdmin ? window.section : "general"} isAdmin={isAdmin} onSection={(section) => useWorkspaceStore.getState().setAppSection(window.id, section)}>
          {!isAdmin || window.section === "general" ? <SettingsPage roots={roots} isAdmin={isAdmin} /> : null}
          {isAdmin && window.section === "users" ? <UsersPage currentUserId={user.id} /> : null}
          {isAdmin && window.section === "groups" ? <GroupsPage /> : null}
          {isAdmin && window.section === "permissions" ? <PermissionsPage roots={roots} /> : null}
          {isAdmin && window.section === "audit" ? <AuditPage /> : null}
        </SettingsLayout>
      ) : null}
    </KagoWindow>
  );
}
