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
  // Lying across the top, the list can be longer than the window is wide: the section being shown is kept in sight.
  // Only the list is scrolled for that, by hand: asking the browser to show the button scrolls everything it is in.
  const reveal = (button: HTMLButtonElement | null) => {
    const list = button?.closest("nav");
    if (!button || !list) return;
    const item = button.getBoundingClientRect();
    const box = list.getBoundingClientRect();
    list.scrollLeft += item.left < box.left ? item.left - box.left - 8 : item.right > box.right ? item.right - box.right + 8 : 0;
    list.scrollTop += item.top < box.top ? item.top - box.top - 8 : item.bottom > box.bottom ? item.bottom - box.bottom + 8 : 0;
  };

  return (
    // In a window too narrow for a column of its own, the list lies across the top instead and scrolls sideways.
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col @xl:flex-row">
        {visible.some((group) => group.sections.length > 1) || visible.length > 1 ? (
          <nav
            aria-label={t("Settings sections")}
            className="flex shrink-0 gap-1 overflow-x-auto border-b border-line bg-elevated p-1.5 [scrollbar-width:none] @xl:w-44 @xl:flex-col @xl:gap-3 @xl:overflow-x-visible @xl:overflow-y-auto @xl:border-r @xl:border-b-0 @xl:p-2"
          >
            {visible.map((group, index) => (
              <div key={group.label} role="group" aria-label={group.label} className="flex shrink-0 items-center gap-1 @xl:flex-col @xl:items-stretch @xl:gap-px">
                {index > 0 ? <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-line-strong/70 @xl:hidden" /> : null}
                <span className="hidden px-2 pt-1 pb-1 text-xs font-medium text-faint @xl:block">{group.label}</span>
                {group.sections.map((item) => (
                  <button
                    key={item.section}
                    ref={section === item.section ? reveal : undefined}
                    aria-current={section === item.section ? "page" : undefined}
                    className={cn(
                      "flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-left whitespace-nowrap outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50 [&>.lucide]:text-muted",
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
    </div>
  );
}
