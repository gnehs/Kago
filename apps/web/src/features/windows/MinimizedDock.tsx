import { Folder } from "lucide-react";
import { useWorkspaceStore } from "@/stores/workspace";

/** Minimized windows wait here; clicking one restores and focuses it. */
export function MinimizedDock() {
  const minimized = useWorkspaceStore((state) => state.windows).filter((window) => window.minimized);
  if (minimized.length === 0) return null;

  function restore(id: string) {
    const store = useWorkspaceStore.getState();
    store.updateWindow(id, { minimized: false });
    store.focusWindow(id);
  }

  return (
    <div className="absolute bottom-3 left-3 z-[550] flex max-w-[60%] flex-wrap gap-1.5">
      {minimized.map((window) => (
        <button
          key={window.id}
          className="flex h-8 max-w-44 items-center gap-1.5 rounded-md bg-surface px-2.5 shadow-popup outline-none hover:bg-elevated focus-visible:ring-2 focus-visible:ring-accent/50"
          title={`${window.rootSlug}:${window.logicalPath}`}
          onClick={() => restore(window.id)}
        >
          <Folder className="fill-folder/25 text-folder" />
          <span className="truncate">{window.title}</span>
        </button>
      ))}
    </div>
  );
}
