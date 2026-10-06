import type { ReactNode } from "react";
import { HardDrive, KeyRound, ScrollText, UserRound, UsersRound } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SettingsSection } from "@/stores/workspace";

const sections: Array<{ section: SettingsSection; label: string; icon: ReactNode; adminOnly?: boolean }> = [
  { section: "general", label: "一般與位置", icon: <HardDrive /> },
  { section: "users", label: "使用者", icon: <UserRound />, adminOnly: true },
  { section: "groups", label: "群組", icon: <UsersRound />, adminOnly: true },
  { section: "permissions", label: "權限", icon: <KeyRound />, adminOnly: true },
  { section: "audit", label: "稽核紀錄", icon: <ScrollText />, adminOnly: true }
];

/** Body of the settings window: a category list on the left, the chosen section on the right. */
export function SettingsLayout({ section, isAdmin, onSection, children }: { section: SettingsSection; isAdmin: boolean; onSection: (section: SettingsSection) => void; children: ReactNode }) {
  const visible = sections.filter((item) => isAdmin || !item.adminOnly);

  return (
    <div className="flex min-h-0 flex-1">
      {visible.length > 1 ? (
        <nav aria-label="設定分類" className="flex w-40 shrink-0 flex-col gap-px overflow-y-auto border-r border-line bg-elevated p-2">
          {visible.map((item) => (
            <button
              key={item.section}
              aria-current={section === item.section ? "page" : undefined}
              className={cn(
                "flex h-7 shrink-0 items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent/50 [&>.lucide]:text-muted",
                section === item.section && "bg-accent-soft hover:bg-accent-soft [&>.lucide]:text-accent"
              )}
              onClick={() => onSection(item.section)}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      ) : null}
      {children}
    </div>
  );
}
