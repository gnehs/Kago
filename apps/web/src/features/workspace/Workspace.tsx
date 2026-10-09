import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useRoots } from "@/api/hooks";
import { KagoLoading } from "@/components/kago/empty-state";
import { ExternalAppDialogHost } from "@/features/apps/ExternalAppDialog";
import { FileWindowView } from "@/features/files/FileWindow";
import { Shelf } from "@/features/shelves/Shelf";
import { PreviewWindowView } from "@/features/files/PreviewWindow";
import { AppWindowView } from "@/features/windows/AppWindow";
import { loadSettings, useSettingsStore, wallpaperUrl } from "@/stores/settings";
import { setCanvasSize, setRootNames, useWorkspaceStore } from "@/stores/workspace";
import type { Actor, Root } from "@/types/kago";
import { CommandPalette } from "./CommandPalette";
import { DesktopIcons } from "./DesktopIcons";
import { appRouteFromPath } from "./routes";
import { TopBar } from "./TopBar";
import { useRealtime } from "./useRealtime";
import { useShortcuts } from "./useShortcuts";
import { useWorkspaceSync } from "./useWorkspaceSync";

export function Workspace({ user }: { user: Actor }) {
  const roots = useRoots();
  const sync = useWorkspaceSync();
  const settingsReady = useSettingsStore((state) => state.hydrated);
  const location = useLocation();
  const navigate = useNavigate();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  const isAdmin = user.role === "ADMIN";
  const rootList = roots.data ?? [];

  // Folders are shown the way the account says, so nothing is drawn until that is known.
  useEffect(() => {
    useSettingsStore.setState({ hydrated: false });
    void loadSettings();
  }, [user.id]);

  useRealtime(user.id, sync.onRemoteChange);
  useShortcuts({ enabled: !paletteOpen, onOpenPalette: openPalette });

  // Reserved /_kago/* URLs open the matching app window, then hand the URL back to the desktop.
  useEffect(() => {
    if (location.pathname === "/") return;
    const route = appRouteFromPath(location.pathname);
    if (route && (isAdmin || !route.adminOnly)) useWorkspaceStore.getState().openApp(route.app, route.section);
    navigate("/", { replace: true });
  }, [location.pathname, isAdmin, navigate]);

  return (
    <div className="kago-canvas flex h-full flex-col text-ink">
      <TopBar user={user} onOpenPalette={openPalette} />
      <main className="flex min-h-0 min-w-0 flex-1">
        {sync.isLoading || roots.isLoading || !settingsReady ? (
          <div className="flex-1"><KagoLoading /></div>
        ) : (
          <Canvas roots={rootList} user={user} />
        )}
      </main>
      {paletteOpen ? <CommandPalette roots={rootList} isAdmin={isAdmin} onClose={() => setPaletteOpen(false)} /> : null}
      <ExternalAppDialogHost isAdmin={isAdmin} />
    </div>
  );
}

/** The desktop: shortcuts underneath, file, app and preview windows on top, and the workspace-level shelf. */
function Canvas({ roots, user }: { roots: Root[]; user: Actor }) {
  const windows = useWorkspaceStore((state) => state.windows);
  const appWindows = useWorkspaceStore((state) => state.appWindows);
  const previewWindows = useWorkspaceStore((state) => state.previewWindows);
  const wallpaper = useSettingsStore((state) => state.settings.wallpaper);
  const element = useRef<HTMLDivElement>(null);
  // Windows and tabs are named by the store, which has to know what the locations are called before any is drawn.
  useMemo(() => setRootNames(roots), [roots]);
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
    <div ref={element} data-wallpaper={wallpaper ? "" : undefined} className="group/canvas relative isolate min-w-0 flex-1 overflow-hidden">
      {wallpaper ? <img key={wallpaper} alt="" aria-hidden draggable={false} src={wallpaperUrl(wallpaper)} className="pointer-events-none absolute inset-0 size-full object-cover select-none" /> : null}
      <DesktopIcons roots={roots} isAdmin={user.role === "ADMIN"} />
      {windows.map((window) => (
        <FileWindowView key={window.id} window={window} isAdmin={user.role === "ADMIN"} roots={roots} />
      ))}
      {appWindows.map((window) => (
        <AppWindowView key={window.id} window={window} roots={roots} user={user} />
      ))}
      {previewWindows.map((window) => (
        <PreviewWindowView key={window.id} window={window} />
      ))}
      <Shelf />
    </div>
  );
}
