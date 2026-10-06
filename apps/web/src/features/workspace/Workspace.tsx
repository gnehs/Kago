import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useRoots } from "@/api/hooks";
import { KagoLoading } from "@/components/kago/empty-state";
import { AuditPage } from "@/features/admin/AuditPage";
import { GroupsPage } from "@/features/admin/GroupsPage";
import { SettingsPage } from "@/features/admin/SettingsPage";
import { UsersPage } from "@/features/admin/UsersPage";
import { FileWindowView } from "@/features/files/FileWindow";
import { Inspector } from "@/features/files/Inspector";
import { PermissionsPage } from "@/features/permissions/PermissionsPage";
import { SharesPage } from "@/features/shares/SharesPage";
import { Shelf } from "@/features/shelves/Shelf";
import { TaskCenter } from "@/features/tasks/TaskCenter";
import { TasksPage } from "@/features/tasks/TasksPage";
import { TrashPage } from "@/features/trash/TrashPage";
import { MinimizedDock } from "@/features/windows/MinimizedDock";
import { setCanvasSize, useWorkspaceStore } from "@/stores/workspace";
import type { Actor, Root } from "@/types/kago";
import { CommandPalette } from "./CommandPalette";
import { RootPicker } from "./RootPicker";
import { pageFromPath, type WorkspacePage } from "./routes";
import { Sidebar } from "./Sidebar";
import { useRealtime } from "./useRealtime";
import { useShortcuts } from "./useShortcuts";
import { useWorkspaceSync } from "./useWorkspaceSync";

const adminPages: WorkspacePage[] = ["users", "groups", "permissions", "audit"];

export function Workspace({ user }: { user: Actor }) {
  const roots = useRoots();
  const sync = useWorkspaceSync();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const inspectorOpen = useWorkspaceStore((state) => Boolean(state.inspector.open));
  const isAdmin = user.role === "ADMIN";
  const requestedPage = pageFromPath(location.pathname);
  const page = requestedPage && (isAdmin || !adminPages.includes(requestedPage)) ? requestedPage : null;
  const rootList = roots.data ?? [];

  useRealtime(user.id, sync.onRemoteChange);
  useShortcuts({ enabled: !page && !paletteOpen, onOpenPalette: openPalette });

  return (
    <div className="flex h-full bg-canvas text-ink">
      <Sidebar user={user} roots={rootList} page={page} onOpenPalette={openPalette} />
      <main className="flex min-w-0 flex-1">
        {sync.isLoading || roots.isLoading ? (
          <div className="flex-1"><KagoLoading /></div>
        ) : page ? (
          <WorkspacePageView page={page} roots={rootList} user={user} />
        ) : (
          <>
            <Canvas roots={rootList} isAdmin={isAdmin} />
            {inspectorOpen ? <Inspector isAdmin={isAdmin} /> : null}
          </>
        )}
      </main>
      {paletteOpen ? <CommandPalette roots={rootList} onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  );
}

function WorkspacePageView({ page, roots, user }: { page: WorkspacePage; roots: Root[]; user: Actor }) {
  switch (page) {
    case "tasks":
      return <TasksPage />;
    case "shares":
      return <SharesPage roots={roots} />;
    case "trash":
      return <TrashPage />;
    case "users":
      return <UsersPage currentUserId={user.id} />;
    case "groups":
      return <GroupsPage />;
    case "permissions":
      return <PermissionsPage roots={roots} />;
    case "audit":
      return <AuditPage />;
    case "settings":
      return <SettingsPage roots={roots} isAdmin={user.role === "ADMIN"} />;
  }
}

/** The desktop: file windows plus the workspace-level shelf and task centre. */
function Canvas({ roots, isAdmin }: { roots: Root[]; isAdmin: boolean }) {
  const windows = useWorkspaceStore((state) => state.windows);
  const element = useRef<HTMLDivElement>(null);
  // Bumped on resize so canvas-relative children (the shelf) re-clamp.
  const [, setResizeTick] = useState(0);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const observer = new ResizeObserver(() => {
      // Unmounting reports a 0×0 box; refitting against that would shrink every window.
      if (!node.isConnected || node.clientWidth === 0 || node.clientHeight === 0) return;
      setCanvasSize(node.clientWidth, node.clientHeight);
      useWorkspaceStore.getState().refitWindows();
      setResizeTick((tick) => tick + 1);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={element} className="relative isolate min-w-0 flex-1 overflow-hidden">
      {windows.length === 0 ? <RootPicker roots={roots} isAdmin={isAdmin} /> : null}
      {windows.map((window) => (
        <FileWindowView key={window.id} window={window} rootName={roots.find((root) => root.slug === window.rootSlug)?.name ?? window.rootSlug} />
      ))}
      <MinimizedDock />
      <Shelf />
      <TaskCenter />
    </div>
  );
}
