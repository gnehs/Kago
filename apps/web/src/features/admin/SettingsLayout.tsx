import type { ReactNode } from "react";
import { CircleUserRound, Fingerprint, HardDrive, KeyRound, LayoutGrid, RefreshCw, ScrollText, SlidersHorizontal, UserRound, UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "@/stores/workspace";
import { t } from "@/lib/i18n";

/** What is yours comes first; what an administrator runs for everyone is a group of its own. */
const groups: Array<{ label: string; adminOnly?: boolean; sections: Array<{ section: SettingsSection; label: string; icon: ReactNode }> }> = [
  {
    label: t("Personal"),
    sections: [
      { section: "general", label: t("General"), icon: <SlidersHorizontal /> },
      { section: "account", label: t("Account"), icon: <CircleUserRound /> },
      { section: "apps", label: t("Apps"), icon: <LayoutGrid /> },
      { section: "sync", label: t("Sync"), icon: <RefreshCw /> }
    ]
  },
  {
    label: t("Administration"),
    adminOnly: true,
    sections: [
      { section: "locations", label: t("Locations"), icon: <HardDrive /> },
      { section: "users", label: t("Users"), icon: <UserRound /> },
      { section: "groups", label: t("Groups"), icon: <UsersRound /> },
      { section: "sso", label: t("Single sign-on"), icon: <Fingerprint /> },
      { section: "permissions", label: t("Permissions"), icon: <KeyRound /> },
      { section: "audit", label: t("Audit log"), icon: <ScrollText /> }
    ]
  }
];

/** Body of the settings window: a category list on the left, the chosen section on the right. */
export function SettingsLayout({ section, isAdmin, onSection, children }: { section: SettingsSection; isAdmin: boolean; onSection: (section: SettingsSection) => void; children: ReactNode }) {
  const visible = groups.filter((group) => isAdmin || !group.adminOnly);

  return (
    <div className="flex min-h-0 flex-1">
      {visible.some((group) => group.sections.length > 1) || visible.length > 1 ? (
        <nav aria-label={t("Settings sections")} className="flex w-44 shrink-0 flex-col gap-3 overflow-y-auto border-r border-line bg-elevated p-2">
          {visible.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="flex flex-col gap-px">
              <span className="px-2 pt-1 pb-1 text-xs font-medium text-faint">{group.label}</span>
              {group.sections.map((item) => (
                <button
                  key={item.section}
                  aria-current={section === item.section ? "page" : undefined}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50 [&>.lucide]:text-muted",
                    section === item.section && "kago-selection kago-selection-raised font-medium hover:bg-transparent [&>.lucide]:text-inherit"
                  )}
                  onClick={() => onSection(item.section)}
                >
                  {item.icon}
                  {item.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      ) : null}
      {children}
    </div>
  );
}
