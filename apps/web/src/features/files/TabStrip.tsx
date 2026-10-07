import { X } from "lucide-react";
import { displayPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { folderTitle, useWorkspaceStore } from "@/stores/workspace";
import type { FileWindow, Root } from "@/types/kago";
import { FileIcon } from "./FileIcon";
import { t } from "@/lib/i18n";

const FOLDER = { kind: "folder", type: "", name: "" } as const;

/**
 * The folders a window holds open, as tabs in its title bar, where the name of a window with one folder would be.
 * What is left of the bar beside them still moves the window.
 */
export function TabStrip({ window, roots }: { window: FileWindow; roots: Root[] }) {
  const store = useWorkspaceStore.getState;
  const tabs = window.tabs ?? [];

  return (
    <div role="tablist" aria-label={t("Tabs")} className="flex min-w-0 flex-1 items-center gap-1">
      {tabs.map((tab) => {
        const active = tab.id === window.activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={displayPath(roots.find((root) => root.slug === tab.rootSlug)?.name ?? tab.rootSlug, tab.logicalPath)}
            className={cn(
              "group flex h-6 max-w-52 min-w-0 flex-1 basis-0 items-center gap-1.5 rounded-md pr-1 pl-2 outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
              active ? cn("kago-pressed font-medium", window.focused ? "text-ink" : "text-muted") : "text-muted hover:bg-hover hover:text-ink"
            )}
            onClick={() => store().activateTab(window.id, tab.id)}
            onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && store().activateTab(window.id, tab.id)}
            onAuxClick={(event) => event.button === 1 && store().closeTab(window.id, tab.id)}
            // Twice on a tab is not twice on the title bar, which would maximize the window.
            onDoubleClick={(event) => event.stopPropagation()}
          >
            <FileIcon item={FOLDER} />
            <span className="min-w-0 flex-1 truncate">{folderTitle(tab.rootSlug, tab.logicalPath)}</span>
            <button
              aria-label={t("Close tab")}
              title={t("Close tab")}
              tabIndex={-1}
              className={cn("flex size-4 shrink-0 items-center justify-center rounded-sm outline-none hover:bg-hover", !active && "opacity-0 group-hover:opacity-100")}
              onClick={(event) => {
                event.stopPropagation();
                store().closeTab(window.id, tab.id);
              }}
            >
              <X className="size-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
