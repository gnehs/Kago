import { X } from "lucide-react";
import { displayPath, nfc } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { folderTitle, useWorkspaceStore } from "@/stores/workspace";
import type { FileTab, FileWindow, Root } from "@/types/kago";
import { FileIcon } from "@/components/kago/file-icon";
import { t } from "@/lib/i18n";

const FOLDER = { kind: "folder", type: "", name: "" } as const;

/**
 * For tabs that share a name, the folders above each one, from the nearest up to the first that differs from the others,
 * so two "Trip" tabs read "Trip Photos 2024" and "Trip Photos 2025". Tabs alone in their name get nothing.
 */
function distinguishingParents(tabs: FileTab[], roots: Root[]) {
  const trail = (tab: FileTab) => [roots.find((root) => root.slug === tab.rootSlug)?.name ?? tab.rootSlug, ...tab.logicalPath.split("/").filter(Boolean).map(nfc)];
  const trails = new Map(tabs.map((tab) => [tab.id, trail(tab)]));
  const parents = new Map<string, string>();
  for (const tab of tabs) {
    const own = trails.get(tab.id)!;
    let depth = 0;
    for (const other of tabs) {
      const theirs = trails.get(other.id)!;
      if (other.id === tab.id || theirs.at(-1) !== own.at(-1)) continue;
      // How many folders up the two first part ways; none when they are the same folder.
      let up = 1;
      while (up < Math.max(own.length, theirs.length) && own.at(-1 - up) === theirs.at(-1 - up)) up++;
      if (up < Math.max(own.length, theirs.length)) depth = Math.max(depth, up);
    }
    // A location's own top folder has nothing above it to show.
    if (depth && own.length > 1) parents.set(tab.id, own.slice(Math.max(0, own.length - 1 - depth), -1).join("/"));
  }
  return parents;
}

/**
 * The folders a window holds open, as tabs in its title bar, where the name of a window with one folder would be.
 * What is left of the bar beside them still moves the window.
 */
export function TabStrip({ window, roots }: { window: FileWindow; roots: Root[] }) {
  const store = useWorkspaceStore.getState;
  const tabs = window.tabs ?? [];
  const parents = distinguishingParents(tabs, roots);

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
            <span className="flex min-w-0 flex-1 items-baseline gap-1">
              <span className="max-w-full shrink-0 truncate">{folderTitle(tab.rootSlug, tab.logicalPath)}</span>
              {parents.has(tab.id) ? <span className="min-w-0 truncate text-xs font-normal text-faint">{parents.get(tab.id)}</span> : null}
            </span>
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
