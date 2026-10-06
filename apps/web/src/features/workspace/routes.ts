export type WorkspacePage = "tasks" | "shares" | "trash" | "users" | "groups" | "permissions" | "audit" | "settings";

export const pagePaths: Record<WorkspacePage, string> = {
  tasks: "/_kago/tasks",
  shares: "/_kago/shares",
  trash: "/_kago/trash",
  users: "/_kago/admin/users",
  groups: "/_kago/admin/groups",
  permissions: "/_kago/admin/permissions",
  audit: "/_kago/audit",
  settings: "/_kago/settings"
};

export function pageFromPath(pathname: string): WorkspacePage | null {
  const match = (Object.entries(pagePaths) as Array<[WorkspacePage, string]>).find(([, path]) => path === pathname);
  return match?.[0] ?? null;
}
