import type { ReactNode } from "react";
import { CircleUserRound, Fingerprint, HardDrive, KeyRound, LayoutGrid, RefreshCw, ScrollText, SlidersHorizontal, UserRound, UsersRound } from "lucide-react";
import { KagoDivider } from "@/components/kago/divider";
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

/** How far from an edge of the list the section being shown is kept: the depth of the fade there, and a little more. */
const REVEAL_MARGIN = 32;

/** Body of the settings window: a category list on the left, the chosen section on the right. */
export function SettingsLayout({ section, isAdmin, onSection, children }: { section: SettingsSection; isAdmin: boolean; onSection: (section: SettingsSection) => void; children: ReactNode }) {
  const visible = groups.filter((group) => isAdmin || !group.adminOnly);
  // Lying across the top, the list can be longer than the window is wide: the section being shown is kept in sight.
  // Only the list is scrolled for that, by hand: asking the browser to show the button scrolls everything it is in.
  const reveal = (button: HTMLButtonElement | null) => {
    const scroller = button?.closest("nav > div");
    if (!button || !scroller) return;
    const item = button.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    // The list fades out at an edge it goes on past, so the section is brought clear of the fade and not just of the edge.
    const past = (start: number, end: number, from: number, to: number) => (start < from + REVEAL_MARGIN ? start - from - REVEAL_MARGIN : end > to - REVEAL_MARGIN ? end - to + REVEAL_MARGIN : 0);
    scroller.scrollLeft += past(item.left, item.right, box.left, box.right);
    scroller.scrollTop += past(item.top, item.bottom, box.top, box.bottom);
  };

  return (
    // In a window too narrow for a column of its own, the list lies across the top instead and scrolls sideways.
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col @xl:flex-row">
        {visible.some((group) => group.sections.length > 1) || visible.length > 1 ? (
          // The scrollbar is hidden, so the fade at an edge is what says the list goes on. It dissolves the list and not the strip it lies on.
          <nav aria-label={t("Settings sections")} className="flex shrink-0 border-b border-line bg-elevated @xl:w-44 @xl:border-r @xl:border-b-0">
            <div className="flex min-w-0 flex-1 scroll-fade-x scroll-fade-6 gap-1 overflow-x-auto p-1.5 [scrollbar-width:none] @xl:scroll-fade @xl:scroll-fade-8 @xl:flex-col @xl:gap-3 @xl:overflow-x-visible @xl:overflow-y-auto @xl:p-2">
              {visible.map((group, index) => (
                <div key={group.label} role="group" aria-label={group.label} className="flex shrink-0 items-center gap-1 @xl:flex-col @xl:items-stretch @xl:gap-px">
                  {index > 0 ? <KagoDivider className="@xl:hidden" /> : null}
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
            </div>
          </nav>
        ) : null}
        {children}
      </div>
    </div>
  );
}
