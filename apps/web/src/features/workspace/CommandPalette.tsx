import { useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Clock, Folder, HardDrive, Search } from "lucide-react";
import { baseName, normalizeLogicalPath } from "@/lib/paths";
import { cn } from "@/lib/utils";
import { useRecentStore, type RecentFolder } from "@/stores/recent";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Root } from "@/types/kago";

type Target = { rootSlug: string; logicalPath: string; label: string; recent?: boolean };

function suggestions(query: string, roots: Root[], activeRootSlug: string | undefined, recent: RecentFolder[]): Target[] {
  const trimmed = query.trim();
  const results = new Map<string, Target>();
  const push = (root: Root, rawPath: string) => {
    const logicalPath = normalizeLogicalPath(rawPath);
    if (!logicalPath) return;
    results.set(`${root.slug}:${logicalPath}`, { rootSlug: root.slug, logicalPath, label: logicalPath === "/" ? root.name : baseName(logicalPath) });
  };

  // "photos:/2026" opens a path inside a root; "/2026" resolves against the active window's root.
  const colon = trimmed.indexOf(":");
  const explicitRoot = colon > 0 ? roots.find((root) => root.slug === trimmed.slice(0, colon).trim()) : undefined;
  if (explicitRoot) push(explicitRoot, trimmed.slice(colon + 1));
  const activeRoot = roots.find((root) => root.slug === activeRootSlug);
  if (activeRoot && trimmed.startsWith("/")) push(activeRoot, trimmed);

  const lower = trimmed.toLowerCase();
  for (const root of roots) {
    if (!lower || root.name.toLowerCase().includes(lower) || root.slug.includes(lower)) push(root, "/");
  }
  // Recently visited folders fill in below the roots, filtered by the same query.
  for (const folder of recent) {
    const key = `${folder.rootSlug}:${folder.path}`;
    const label = baseName(folder.path);
    if (results.has(key) || !roots.some((root) => root.slug === folder.rootSlug)) continue;
    if (!lower || label.toLowerCase().includes(lower)) results.set(key, { rootSlug: folder.rootSlug, logicalPath: folder.path, label, recent: true });
  }
  return [...results.values()];
}

export function CommandPalette({ roots, onClose }: { roots: Root[]; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const activeRootSlug = useWorkspaceStore((state) => state.windows.find((window) => window.id === state.activeWindowId)?.rootSlug);
  const recent = useRecentStore((state) => state.folders);
  const items = useMemo(() => suggestions(query, roots, activeRootSlug, recent), [query, roots, activeRootSlug, recent]);

  function open(target: Target | undefined) {
    if (!target) return;
    useWorkspaceStore.getState().openWindow({ rootSlug: target.rootSlug, logicalPath: target.logicalPath, title: target.label });
    onClose();
  }

  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[900] bg-overlay" />
        <Dialog.Popup aria-label="快速開啟" className="fixed top-[18vh] left-1/2 z-[900] w-[min(520px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg bg-surface shadow-popup outline-none">
          <label className="flex h-11 items-center gap-2 border-b border-line px-3">
            <Search className="text-muted" />
            <input
              autoFocus
              className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
              placeholder="輸入位置名稱，或 photos:/2026 開啟指定路徑"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setIndex(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  if (items.length) setIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
                }
                if (event.key === "Enter") {
                  event.preventDefault();
                  open(items[index]);
                }
              }}
            />
          </label>
          <ul className="m-0 max-h-72 list-none overflow-y-auto p-1">
            {items.length === 0 ? <li className="px-3 py-6 text-center text-muted">找不到可開啟的位置</li> : null}
            {items.map((item, itemIndex) => (
              <li key={`${item.rootSlug}:${item.logicalPath}`}>
                <button
                  className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left", itemIndex === index && "bg-accent text-accent-fg")}
                  onMouseMove={() => setIndex(itemIndex)}
                  onClick={() => open(item)}
                >
                  {item.logicalPath === "/" ? <HardDrive /> : item.recent ? <Clock /> : <Folder />}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  <span className={cn("truncate text-xs", itemIndex === index ? "opacity-80" : "text-faint")}>{item.rootSlug}:{item.logicalPath}</span>
                </button>
              </li>
            ))}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
