import type { ReactNode } from "react";
import { ListChecks, Settings, Share2, Trash2 } from "lucide-react";
import { AuditPage } from "@/features/admin/AuditPage";
import { GroupsPage } from "@/features/admin/GroupsPage";
import { LocationsPage } from "@/features/admin/LocationsPage";
import { SettingsLayout } from "@/features/admin/SettingsLayout";
import { SettingsPage } from "@/features/admin/SettingsPage";
import { UsersPage } from "@/features/admin/UsersPage";
import { PermissionsPage } from "@/features/permissions/PermissionsPage";
import { SharesPage } from "@/features/shares/SharesPage";
import { SyncPage } from "@/features/sync/SyncPage";
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
  // The sections that are everyone's stay open to everyone; the rest fall back to the first of them.
  const section = isAdmin || window.section === "sync" ? window.section : "general";

  return (
    <KagoWindow window={window} icon={<span className="flex text-muted">{appIcons[window.app]}</span>}>
      {window.app === "tasks" ? <TasksPage /> : null}
      {window.app === "shares" ? <SharesPage roots={roots} /> : null}
      {window.app === "trash" ? <TrashPage /> : null}
      {window.app === "settings" ? (
        <SettingsLayout section={section} isAdmin={isAdmin} onSection={(next) => useWorkspaceStore.getState().setAppSection(window.id, next)}>
          {section === "general" ? <SettingsPage user={user} /> : null}
          {section === "sync" ? <SyncPage roots={roots} user={user} /> : null}
          {isAdmin && window.section === "locations" ? <LocationsPage roots={roots} /> : null}
          {isAdmin && window.section === "users" ? <UsersPage currentUserId={user.id} /> : null}
          {isAdmin && window.section === "groups" ? <GroupsPage /> : null}
          {isAdmin && window.section === "permissions" ? <PermissionsPage roots={roots} /> : null}
          {isAdmin && window.section === "audit" ? <AuditPage /> : null}
        </SettingsLayout>
      ) : null}
    </KagoWindow>
  );
}
