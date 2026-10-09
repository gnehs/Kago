import type { AppKind, SettingsSection } from "@/stores/workspace";

/**
 * Reserved URLs from the product spec. Nothing is a page any more: visiting one opens the
 * matching app window on the desktop, so they keep working as deep links.
 */
const appRoutes: Record<string, { app: AppKind; section?: SettingsSection; adminOnly?: boolean }> = {
  "/_kago/tasks": { app: "tasks" },
  "/_kago/shares": { app: "shares" },
  "/_kago/trash": { app: "trash" },
  "/_kago/settings": { app: "settings", section: "general" },
  "/_kago/apps": { app: "settings", section: "apps" },
  "/_kago/sync": { app: "settings", section: "sync" },
  "/_kago/admin/locations": { app: "settings", section: "locations", adminOnly: true },
  "/_kago/admin/users": { app: "settings", section: "users", adminOnly: true },
  "/_kago/admin/groups": { app: "settings", section: "groups", adminOnly: true },
  "/_kago/admin/permissions": { app: "settings", section: "permissions", adminOnly: true },
  "/_kago/audit": { app: "settings", section: "audit", adminOnly: true }
};

export const appRouteFromPath = (pathname: string) => appRoutes[pathname] ?? null;
