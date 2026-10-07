import type { ReactNode } from "react";
import { HardDrive, KeyRound, ScrollText, SlidersHorizontal, UserRound, UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "@/stores/workspace";

/** What is yours comes first; what an administrator runs for everyone is a group of its own. */
const groups: Array<{ label: string; adminOnly?: boolean; sections: Array<{ section: SettingsSection; label: string; icon: ReactNode }> }> = [
  { label: "個人", sections: [{ section: "general", label: "一般", icon: <SlidersHorizontal /> }] },
  {
    label: "管理",
    adminOnly: true,
    sections: [
      { section: "locations", label: "位置", icon: <HardDrive /> },
      { section: "users", label: "使用者", icon: <UserRound /> },
      { section: "groups", label: "群組", icon: <UsersRound /> },
      { section: "permissions", label: "權限", icon: <KeyRound /> },
      { section: "audit", label: "稽核紀錄", icon: <ScrollText /> }
    ]
  }
];

/** Body of the settings window: a category list on the left, the chosen section on the right. */
export function SettingsLayout({ section, isAdmin, onSection, children }: { section: SettingsSection; isAdmin: boolean; onSection: (section: SettingsSection) => void; children: ReactNode }) {
  const visible = groups.filter((group) => isAdmin || !group.adminOnly);

  return (
    <div className="flex min-h-0 flex-1">
      {visible.length > 1 ? (
        <nav aria-label="設定分類" className="flex w-44 shrink-0 flex-col gap-3 overflow-y-auto border-r border-line bg-elevated p-2">
          {visible.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="flex flex-col gap-px">
              <span className="px-2 pt-1 pb-1 text-xs font-medium text-faint">{group.label}</span>
              {group.sections.map((item) => (
                <button
                  key={item.section}
                  aria-current={section === item.section ? "page" : undefined}
                  className={cn(
                    "flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50 [&>.lucide]:text-muted",
                    section === item.section && "kago-selection font-medium hover:bg-transparent [&>.lucide]:text-inherit"
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
