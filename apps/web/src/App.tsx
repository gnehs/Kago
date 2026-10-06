import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router";
import { Archive, Boxes, Check, ChevronLeft, ChevronRight, Circle, CirclePlus, Columns3, Download, FileText, Folder, FolderOpen, HardDrive, Home, KeyRound, LayoutGrid, List, Loader2, LogOut, Maximize2, Minimize2, PanelRight, Pencil, Plus, RefreshCw, Search, Server, Settings, Share2, ShieldAlert, SlidersHorizontal, Star, Tags, Trash2, Upload, UserPlus, Users, X } from "lucide-react";
import { ApiError, api, downloadUrl, previewUrl, thumbnailUrl } from "./api/client";
import { useAudit, useFileList, useFileMeta, useFileTags, useGroups, useMe, usePathPermissions, usePermissions, useRoots, useSaveWorkspace, useSetupStatus, useShares, useShelves, useTasks, useTrash, useUsers, useWorkspace } from "./api/hooks";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { useWorkspaceStore } from "./stores/workspace";
import type { FileItem, FileTask, FileWindow, Root, WorkspaceState } from "./types/kago";

export function App() {
  return (
    <Routes>
      <Route path="/" element={<AppGate />} />
      <Route path="/login" element={<AppGate />} />
      <Route path="/_kago/*" element={<AppGate />} />
      <Route path="/s/:token" element={<PublicShareRoute />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function PublicShareRoute() {
  const { token } = useParams();
  if (!token) return <Navigate to="/" replace />;
  return <PublicSharePage token={token} />;
}

function AppGate() {
  const setup = useSetupStatus();

  if (setup.isLoading) return <ShellLoading />;
  if (setup.data?.needsSetup) return <SetupAdmin />;

  return <AuthenticatedApp />;
}

function AuthenticatedApp() {
  const me = useMe();

  if (me.isLoading) return <ShellLoading />;
  if (!me.data?.user) return <Login />;
  return <Workspace userId={me.data.user.id} userEmail={me.data.user.email} />;
}

function ShellLoading() {
  return (
    <main className="loading-screen">
      <Loader2 className="spin" />
    </main>
  );
}

function PublicSharePage({ token }: { token: string }) {
  const [share, setShare] = useState<PublicShareInfo | null>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState(false);

  useEffect(() => {
    void loadShare();
  }, [token]);

  async function loadShare() {
    setError("");
    try {
      const info = await api<PublicShareInfo>(`/s/${token}`, { headers: { Accept: "application/json" } });
      setShare(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : "分享連結無法使用");
    }
  }

  async function authenticate(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api(`/s/${token}/auth`, { method: "POST", body: JSON.stringify({ password }) });
      setPassword("");
      await loadShare();
    } catch (err) {
      setError(err instanceof Error ? err.message : "密碼驗證失敗");
    } finally {
      setBusy(false);
    }
  }

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files?.length) return;
    setBusy(true);
    setError("");
    setUploaded(false);
    try {
      const form = new FormData();
      for (const file of files) form.append("file", file);
      await api(`/s/${token}/upload`, { method: "POST", body: form });
      setUploaded(true);
      event.target.value = "";
    } catch (err) {
      setError(err instanceof Error ? err.message : "上傳失敗");
    } finally {
      setBusy(false);
    }
  }

  const needsPassword = share?.requiresPassword && !share.authenticated;
  const shareTitle = share?.path ? share.path.split("/").filter(Boolean).at(-1) ?? share.rootSlug ?? "分享連結" : "受保護分享";

  return (
    <main className="share-screen">
      <section className="share-window">
        <header>
          <div className="traffic-lights"><span /><span /><span /></div>
          <strong><Share2 /> Kago Share</strong>
        </header>
        <div className="share-body">
          <div className="share-file-mark">
            {share?.mode === "upload_only" ? <Upload /> : <Download />}
          </div>
          <h1>{share ? shareTitle : "分享連結"}</h1>
          {share?.rootSlug && share.path ? <p>{share.rootSlug}:{share.path}</p> : null}
          {error && <div className="inline-error">{error}</div>}
          {!share && !error && <Loader2 className="spin" />}
          {needsPassword && (
            <form className="share-password" onSubmit={authenticate}>
              <label>
                分享密碼
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
              </label>
              <button className="primary-button" disabled={busy || !password}>
                {busy ? <Loader2 className="spin" /> : <Check />}
                解鎖
              </button>
            </form>
          )}
          {share && !needsPassword && (
            <div className="share-actions">
              {share.mode === "download" && (
                <a className="primary-button" href={`/s/${token}/download`}>
                  <Download />
                  下載
                </a>
              )}
              {share.mode === "view_only" && (
                <a className="primary-button" href={`/s/${token}/preview`} target="_blank" rel="noreferrer">
                  <FileText />
                  檢視
                </a>
              )}
              {share.mode === "upload_only" && (
                <label className="primary-button file-input">
                  {busy ? <Loader2 className="spin" /> : <Upload />}
                  上傳檔案
                  <input type="file" multiple onChange={upload} disabled={busy} />
                </label>
              )}
              {uploaded && <span className="share-success"><Check /> 已上傳</span>}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function SetupAdmin() {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();
  const passwordTooShort = Boolean(password && password.length < 8);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (passwordTooShort) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/setup", {
        method: "POST",
        body: JSON.stringify({ email, displayName: displayName || email.split("@")[0] || "Admin", password })
      });
      await queryClient.invalidateQueries({ queryKey: ["auth", "setup"] });
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "初始化失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen setup-screen">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-row">
          <div className="brand-mark">K</div>
          <div>
            <h1>Kago</h1>
            <p>建立第一位管理員</p>
          </div>
        </div>
        <label>
          Email
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
        </label>
        <label>
          Display name
          <Input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" />
        </label>
        <label>
          Password
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" required />
        </label>
        {passwordTooShort && <div className="inline-error">密碼至少需要 8 個字元</div>}
        {error && <div className="inline-error">{error}</div>}
        <Button className="primary-button" disabled={busy || !email || password.length < 8}>
          {busy ? <Loader2 className="spin" /> : <Check />}
          Create admin
        </Button>
      </form>
    </main>
  );
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const queryClient = useQueryClient();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "登入失敗");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <form className="login-panel" onSubmit={submit}>
        <div className="brand-row">
          <div className="brand-mark">K</div>
          <div>
            <h1>Kago</h1>
            <p>NAS desktop workspace</p>
          </div>
        </div>
        <label>
          Email
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
        </label>
        <label>
          Password
          <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
        </label>
        {error && <div className="inline-error">{error}</div>}
        <Button className="primary-button" disabled={busy || !email || !password}>
          {busy ? <Loader2 className="spin" /> : <Check />}
          Sign in
        </Button>
      </form>
    </main>
  );
}

type PublicShareInfo = {
  id: string;
  mode: "view_only" | "download" | "upload_only";
  path?: string;
  rootSlug?: string;
  requiresPassword: boolean;
  authenticated: boolean;
};

type RoutePanel = "shelf" | "tasks" | "shares" | "users" | "groups" | "permissions" | "settings" | "trash" | "audit";
type PointerDragState = { pointerId: number; startX: number; startY: number; x: number; y: number };
type PointerResizeState = { pointerId: number; startX: number; startY: number; width: number; height: number };
type SelectionDragState = { pointerId: number; startX: number; startY: number; currentX: number; currentY: number };

function routePanelFromPath(pathname: string): RoutePanel | null {
  if (pathname === "/_kago/shelf") return "shelf";
  if (pathname === "/_kago/tasks") return "tasks";
  if (pathname === "/_kago/shares") return "shares";
  if (pathname === "/_kago/admin/users") return "users";
  if (pathname === "/_kago/admin/groups") return "groups";
  if (pathname === "/_kago/admin/permissions") return "permissions";
  if (pathname === "/_kago/settings") return "settings";
  if (pathname === "/_kago/trash") return "trash";
  if (pathname === "/_kago/audit") return "audit";
  return null;
}

function routePanelPath(panel: RoutePanel): string {
  const paths: Record<RoutePanel, string> = {
    shelf: "/_kago/shelf",
    tasks: "/_kago/tasks",
    shares: "/_kago/shares",
    users: "/_kago/admin/users",
    groups: "/_kago/admin/groups",
    permissions: "/_kago/admin/permissions",
    settings: "/_kago/settings",
    trash: "/_kago/trash",
    audit: "/_kago/audit"
  };
  return paths[panel];
}

const permissionActions = [
  "list",
  "read",
  "download",
  "upload",
  "create_folder",
  "rename",
  "move",
  "copy",
  "delete",
  "share",
  "manage_tags",
  "manage_permissions",
  "run_rsync",
  "compress",
  "extract"
] as const;

type PermissionAction = (typeof permissionActions)[number];

function Workspace({ userId, userEmail }: { userId: string; userEmail: string }) {
  const workspaceQuery = useWorkspace();
  const roots = useRoots();
  const saveWorkspace = useSaveWorkspace();
  const store = useWorkspaceStore();
  const queryClient = useQueryClient();
  const routerLocation = useLocation();
  const navigate = useNavigate();
  const saveTimer = useRef<number | null>(null);
  const prevWorkspace = useRef<WorkspaceState | null>(null);
  const noticeTimer = useRef<number | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandPaletteQuery, setCommandPaletteQuery] = useState("");
  const [commandPaletteIndex, setCommandPaletteIndex] = useState(0);
  const [remoteWorkspaceRequestedAt, setRemoteWorkspaceRequestedAt] = useState(0);
  const rootList = roots.data ?? [];
  const activeWindow = store.windows.find((window) => window.id === store.activeWindowId) ?? null;
  const commandPaletteItems = getCommandPaletteSuggestions(commandPaletteQuery, rootList, activeWindow);
  const routePanel = routePanelFromPath(routerLocation.pathname);

  useEffect(() => {
    if (!workspaceQuery.data) return;
    const hasFreshRemoteWorkspace = remoteWorkspaceRequestedAt > 0 && workspaceQuery.dataUpdatedAt >= remoteWorkspaceRequestedAt;
    if (!store.hydrated || hasFreshRemoteWorkspace) {
      store.hydrate(workspaceQuery.data);
      prevWorkspace.current = workspaceQuery.data;
      if (hasFreshRemoteWorkspace) setRemoteWorkspaceRequestedAt(0);
    }
  }, [workspaceQuery.data, workspaceQuery.dataUpdatedAt, store, remoteWorkspaceRequestedAt]);

  useEffect(() => {
    if (!store.hydrated) return;
    const current = store.snapshot();
    const previous = prevWorkspace.current;

    if (!previous) {
      prevWorkspace.current = current;
      return;
    }

    const previousWindows = new Map(previous.windows.map((window) => [window.id, window]));
    let hasOpenClose = current.windows.length !== previous.windows.length;
    let hasPathOrViewSortChange = false;
    let hasGeometryChange = false;

    for (const window of current.windows) {
      const prevWindow = previousWindows.get(window.id);
      if (!prevWindow) {
        hasOpenClose = true;
        continue;
      }
      if (
        window.logicalPath !== prevWindow.logicalPath ||
        window.viewMode !== prevWindow.viewMode ||
        window.sortBy !== prevWindow.sortBy ||
        window.sortDirection !== prevWindow.sortDirection
      ) {
        hasPathOrViewSortChange = true;
      }
      if (window.x !== prevWindow.x || window.y !== prevWindow.y || window.width !== prevWindow.width || window.height !== prevWindow.height) {
        hasGeometryChange = true;
      }
    }

    if (!hasOpenClose) {
      for (const prevWindow of previous.windows) {
        if (!current.windows.some((window) => window.id === prevWindow.id)) {
          hasOpenClose = true;
          break;
        }
      }
    }

    if (saveTimer.current) window.clearTimeout(saveTimer.current);

    if (hasOpenClose || hasPathOrViewSortChange) {
      prevWorkspace.current = current;
      saveWorkspace.mutate(current);
      return;
    }

    let delay = 700;
    if (store.activeWindowId !== previous.activeWindowId) delay = 300;
    else if (hasGeometryChange) delay = 1000;

    saveTimer.current = window.setTimeout(() => {
      saveWorkspace.mutate(current);
      prevWorkspace.current = current;
    }, delay);

    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [store.windows, store.activeWindowId, store.sidebar, store.inspector, store.shelf]);

  useEffect(() => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    if (!store.notice) return;
    noticeTimer.current = window.setTimeout(() => {
      store.clearNotice();
    }, 2600);
    return () => {
      if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    };
  }, [store, store.notice]);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    let closed = false;
    let retryCount = 0;
    let reconnectTimer: number | null = null;
    let socket: WebSocket | null = null;

    const refetchRealtimeState = () => {
      void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      void queryClient.invalidateQueries({ queryKey: ["shelves"] });
      void queryClient.invalidateQueries({ queryKey: ["shares"] });
      void queryClient.invalidateQueries({ queryKey: ["permissions"] });
      void queryClient.invalidateQueries({ queryKey: ["roots"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    };

    const handleMessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data) as { type?: string; userId?: string };
      if (String(message.type).startsWith("task.")) {
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        if (message.type === "task.done") void queryClient.invalidateQueries({ queryKey: ["fs"] });
      }
      if (message.type === "shelf.updated") void queryClient.invalidateQueries({ queryKey: ["shelves"] });
      if (message.type === "share.updated") void queryClient.invalidateQueries({ queryKey: ["shares"] });
      if (message.type === "permission.updated") {
        void queryClient.invalidateQueries({ queryKey: ["permissions"] });
        void queryClient.invalidateQueries({ queryKey: ["roots"] });
        void queryClient.invalidateQueries({ queryKey: ["fs"] });
      }
      if (message.type === "workspace.updated" && message.userId === userId) {
        setRemoteWorkspaceRequestedAt(Date.now());
        void queryClient.invalidateQueries({ queryKey: ["workspace"] });
      }
    };

    const connect = () => {
      if (closed) return;
      const ws = new WebSocket(`${protocol}://${location.host}/ws`);
      socket = ws;
      ws.onopen = () => {
        retryCount = 0;
        refetchRealtimeState();
      };
      ws.onmessage = handleMessage;
      ws.onerror = () => ws.close();
      ws.onclose = () => {
        if (closed) return;
        retryCount += 1;
        const delay = Math.min(15000, 500 * 2 ** Math.min(retryCount, 5));
        reconnectTimer = window.setTimeout(connect, delay);
      };
    };

    connect();
    return () => {
      closed = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [queryClient, userId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const active = store.windows.find((window) => window.id === store.activeWindowId);
      const mod = event.metaKey || event.ctrlKey;

      if (commandPaletteOpen) {
        if (event.key === "Escape") {
          event.preventDefault();
          setCommandPaletteOpen(false);
          return;
        }
        if (event.key === "ArrowDown" && commandPaletteItems.length > 0) {
          event.preventDefault();
          setCommandPaletteIndex((previous) => (previous + 1) % commandPaletteItems.length);
          return;
        }
        if (event.key === "ArrowUp" && commandPaletteItems.length > 0) {
          event.preventDefault();
          setCommandPaletteIndex((previous) => (previous - 1 + commandPaletteItems.length) % commandPaletteItems.length);
          return;
        }
        if (event.key === "Enter" && commandPaletteItems.length > 0) {
          event.preventDefault();
          const selected = commandPaletteItems[commandPaletteIndex];
          if (!selected) return;
          openCommandPaletteTarget(selected, setCommandPaletteOpen, setCommandPaletteQuery, store);
          return;
        }
        return;
      }

      if (mod && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setCommandPaletteQuery("");
        setCommandPaletteIndex(0);
        setCommandPaletteOpen(true);
        return;
      }

      if (!active) return;
      if (isEditableTarget(event.target) && event.key !== "Escape") return;
      if (mod && event.key.toLowerCase() === "w") {
        event.preventDefault();
        store.closeWindow(active.id);
      }
      if (mod && event.key.toLowerCase() === "n") {
        event.preventDefault();
        store.openWindow({ rootSlug: active.rootSlug, logicalPath: active.logicalPath, title: active.title });
      }
      if (mod && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void queryClient.invalidateQueries({ queryKey: ["fs", "list", active.rootSlug, active.logicalPath] });
      }
      if (mod && event.key.toLowerCase() === "l") {
        event.preventDefault();
        const address = document.querySelector<HTMLElement>(`[data-window="${active.id}"] [data-address-target]`);
        address?.focus();
        if (address instanceof HTMLInputElement) address.select();
      }
      if (event.key === "Backspace" && active.logicalPath !== "/") {
        event.preventDefault();
        store.updateWindow(active.id, { logicalPath: parentPath(active.logicalPath), selectedItems: [] });
      }
      if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const items = document.querySelectorAll(`[data-window="${active.id}"] [data-file-path]`);
        store.selectItems(active.id, Array.from(items).map((node) => (node as HTMLElement).dataset.filePath!).filter(Boolean));
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        const rows = Array.from(document.querySelectorAll<HTMLElement>(`[data-window="${active.id}"] [data-file-path]`));
        if (rows.length === 0) return;
        event.preventDefault();
        const selectedPath = active.selectedItems[0];
        const selectedIndex = rows.findIndex((row) => row.dataset.filePath === selectedPath);
        const nextIndex =
          event.key === "ArrowDown"
            ? Math.min(selectedIndex + 1, rows.length - 1)
            : Math.max(selectedIndex === -1 ? rows.length - 1 : selectedIndex - 1, 0);
        const nextPath = rows[nextIndex]?.dataset.filePath;
        if (nextPath) store.selectItems(active.id, [nextPath]);
      }
      if (event.key === "Enter") {
        const selectedPath = active.selectedItems[0];
        if (!selectedPath) return;
        const row = Array.from(document.querySelectorAll<HTMLElement>(`[data-window="${active.id}"] [data-file-path]`)).find(
          (item) => item.dataset.filePath === selectedPath
        );
        if (!row) return;
        event.preventDefault();
        if (row.dataset.fileKind === "folder") {
          if (mod) store.openWindow({ rootSlug: active.rootSlug, logicalPath: selectedPath, title: selectedPath.split("/").filter(Boolean).at(-1) ?? active.title });
          else store.updateWindow(active.id, { logicalPath: selectedPath, selectedItems: [] });
        } else {
          row.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
        }
      }
      if (event.key === "Escape") store.selectItems(active.id, []);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [queryClient, store, commandPaletteOpen, commandPaletteItems, commandPaletteIndex]);

  if (workspaceQuery.isLoading || roots.isLoading) return <ShellLoading />;

  const showInspector = Boolean(!routePanel && activeWindow?.selectedItems.length && store.inspector.open !== false);
  const sidebarCollapsed = Boolean(store.sidebar.collapsed);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
  }

  return (
    <main className="app-shell">
      <DesktopTopBar
        userEmail={userEmail}
        onOpenFileStation={() => {
          const firstRoot = rootList[0];
          if (firstRoot) store.openRoot(firstRoot);
        }}
        onOpenAudit={() => navigate(routePanelPath("audit"))}
        onOpenCommandPalette={() => {
          setCommandPaletteQuery("");
          setCommandPaletteIndex(0);
          setCommandPaletteOpen(true);
        }}
        onLogout={logout}
      />
      <aside className={`workspace-sidebar-shell ${sidebarCollapsed ? "collapsed" : ""}`}>
        <Sidebar
          roots={rootList}
          userEmail={userEmail}
          activePanel={routePanel}
          onShowDesktop={() => navigate("/")}
          onOpenPanel={(panel) => navigate(routePanelPath(panel))}
          onOpenTrash={() => navigate(routePanelPath("trash"))}
          onOpenAudit={() => navigate(routePanelPath("audit"))}
        />
      </aside>
      <section className={`workspace-canvas desktop-canvas ${showInspector ? "inspector-visible" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        {store.notice ? <div className="workspace-notice">{store.notice}</div> : null}
        {commandPaletteOpen ? (
          <CommandPalette
            roots={rootList}
            activeWindow={activeWindow ?? null}
            query={commandPaletteQuery}
            onClose={() => setCommandPaletteOpen(false)}
            onQueryChange={(nextQuery) => {
              setCommandPaletteQuery(nextQuery);
              setCommandPaletteIndex(0);
            }}
            onOpen={(target) => openCommandPaletteTarget(target, setCommandPaletteOpen, setCommandPaletteQuery, store)}
            selectedIndex={commandPaletteIndex}
          />
        ) : null}
        {routePanel ? (
          <RoutePanelView panel={routePanel} roots={rootList} onClose={() => navigate("/")} />
        ) : (
          <>
            {store.windows.length === 0 ? <RootPicker roots={rootList} /> : null}
            {store.windows.map((window) => (
              <FileWindowView key={window.id} window={window} />
            ))}
            <FloatingShelf />
            <TaskCenter />
            <TrashCenter open={trashOpen} onClose={() => setTrashOpen(false)} />
            <AuditCenter open={auditOpen} onClose={() => setAuditOpen(false)} />
          </>
        )}
      </section>
      {showInspector ? <Inspector /> : null}
    </main>
  );
}

type CommandPaletteTarget = {
  rootSlug: string;
  logicalPath: string;
  label: string;
};

function CommandPalette({
  roots,
  activeWindow,
  query,
  onQueryChange,
  onClose,
  onOpen,
  selectedIndex
}: {
  roots: Root[];
  activeWindow: FileWindow | null;
  query: string;
  onQueryChange: (query: string) => void;
  onClose: () => void;
  onOpen: (target: CommandPaletteTarget) => void;
  selectedIndex: number;
}) {
  const suggestions = getCommandPaletteSuggestions(query, roots, activeWindow);

  return (
    <div className="command-palette-overlay" onMouseDown={onClose}>
      <section className="command-palette" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <Search />
          <input autoFocus value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="輸入 root 或 root:/path 開啟" />
        </header>
        <div className="command-palette-list">
          {suggestions.length === 0 ? <div className="command-palette-empty">找不到可開啟的目標</div> : null}
          {suggestions.map((suggestion, index) => (
            <button
              key={`${suggestion.rootSlug}:${suggestion.logicalPath}`}
              className={selectedIndex === index ? "selected" : ""}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onOpen(suggestion)}
            >
              <span>{suggestion.label}</span>
              <small>{`${suggestion.rootSlug}:${suggestion.logicalPath}`}</small>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function getCommandPaletteSuggestions(
  query: string,
  roots: Root[],
  activeWindow: FileWindow | null
): CommandPaletteTarget[] {
  const trimmed = query.trim();
  const result: CommandPaletteTarget[] = [];
  const lower = trimmed.toLowerCase();
  const seen = new Set<string>();

  const pushSuggestion = (rootSlug: string, logicalPath: string) => {
    const path = normalizeCommandPalettePath(logicalPath);
    if (!path) return;
    const key = `${rootSlug}:${path}`;
    if (seen.has(key)) return;
    const label = path === "/" ? rootSlug : path.split("/").filter(Boolean).at(-1) ?? rootSlug;
    seen.add(key);
    result.push({ rootSlug, logicalPath: path, label });
  };

  const rootsBySlug = roots.map((root) => root.slug);

  if (trimmed === "") {
    for (const root of roots) {
      pushSuggestion(root.slug, "/");
    }
    return result;
  }

  const colonIndex = trimmed.indexOf(":");
  if (colonIndex > 0) {
    const left = trimmed.slice(0, colonIndex).trim();
    const right = trimmed.slice(colonIndex + 1).trim();
    if (right && rootsBySlug.includes(left)) {
      pushSuggestion(left, `/${right}`);
    }
  }

  for (const root of roots) {
    if ((root.name.toLowerCase().includes(lower) || root.slug.includes(lower)) && root.slug !== "s") {
      pushSuggestion(root.slug, "/");
    }
  }

  if (activeWindow && trimmed.startsWith("/")) {
    pushSuggestion(activeWindow.rootSlug, trimmed);
  }

  return result;
}

function openCommandPaletteTarget(
  target: CommandPaletteTarget,
  setPaletteOpen: (value: boolean) => void,
  setPaletteQuery: (value: string) => void,
  store: ReturnType<typeof useWorkspaceStore.getState>
) {
  store.openWindow({
    rootSlug: target.rootSlug,
    logicalPath: target.logicalPath,
    title: target.label
  });
  setPaletteOpen(false);
  setPaletteQuery("");
}

function normalizeCommandPalettePath(value: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === "/") return "/";
  if (trimmed.includes("..")) return null;
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = withLeading.split("/").filter(Boolean);
  if (!parts.length) return "/";
  const sanitized = parts.join("/");
  return `/${sanitized}`;
}

function DesktopTopBar({
  userEmail,
  onOpenFileStation,
  onOpenAudit,
  onOpenCommandPalette,
  onLogout
}: { userEmail: string; onOpenFileStation: () => void; onOpenAudit: () => void; onOpenCommandPalette: () => void; onLogout: () => void }) {
  return (
    <header className="desktop-topbar product-topbar">
      <div className="product-topbar-brand">
        <div className="brand-mark">K</div>
        <strong>Kago</strong>
        <span>檔案管理器</span>
      </div>
      <div className="product-topbar-actions">
        <button onClick={onOpenFileStation}><FolderOpen /> <span>開啟 Root</span></button>
        <button onClick={onOpenCommandPalette}><Search /> <span>快速開啟</span></button>
        <button onClick={onOpenAudit}><SlidersHorizontal /> <span>稽核</span></button>
        <button onClick={onLogout} title={`登出 ${userEmail}`}><LogOut /> <span>登出</span></button>
      </div>
    </header>
  );
}

function RoutePanelView({ panel, roots, onClose }: { panel: RoutePanel; roots: Root[]; onClose: () => void }) {
  const titles: Record<RoutePanel, { icon: React.ReactNode; title: string }> = {
    shelf: { icon: <Archive />, title: "中轉區" },
    tasks: { icon: <Boxes />, title: "任務" },
    shares: { icon: <Share2 />, title: "分享" },
    users: { icon: <UserPlus />, title: "使用者" },
    groups: { icon: <Users />, title: "群組" },
    permissions: { icon: <KeyRound />, title: "權限" },
    settings: { icon: <Settings />, title: "設定" },
    trash: { icon: <Trash2 />, title: "垃圾桶" },
    audit: { icon: <SlidersHorizontal />, title: "稽核紀錄" }
  };
  return (
    <section className="route-panel">
      <header>
        <strong>{titles[panel].icon}{titles[panel].title}</strong>
        <button className="icon-button" onClick={onClose} title="回到桌面"><X /></button>
      </header>
      {panel === "shelf" ? <ShelfRoutePanel /> : null}
      {panel === "tasks" ? <TasksRoutePanel /> : null}
      {panel === "shares" ? <SharesRoutePanel roots={roots} /> : null}
      {panel === "users" ? <UsersRoutePanel /> : null}
      {panel === "groups" ? <GroupsRoutePanel /> : null}
      {panel === "permissions" ? <PermissionsRoutePanel roots={roots} /> : null}
      {panel === "settings" ? <SettingsRoutePanel roots={roots} /> : null}
      {panel === "trash" ? <TrashRoutePanel /> : null}
      {panel === "audit" ? <AuditRoutePanel /> : null}
    </section>
  );
}

function ShelfRoutePanel() {
  const shelves = useShelves();
  return (
    <div className="route-panel-body">
      {(shelves.data ?? []).map((shelf) => (
        <section className="route-card" key={shelf.id}>
          <h3>{shelf.name}</h3>
          <div className="route-list">
            {shelf.items.length === 0 ? <div className="empty-state">沒有中轉項目</div> : null}
            {shelf.items.map((item) => (
              <div className="route-row" key={item.id}>
                <Archive />
                <div><strong>{item.name}</strong><span>{item.root_slug}:{item.path}</span></div>
                <small>{item.kind === "folder" ? "資料夾" : "檔案"} · {formatSize(item.size)}</small>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TasksRoutePanel() {
  const tasks = useTasks();
  const queryClient = useQueryClient();
  async function action(taskId: string, verb: "cancel" | "pause" | "resume" | "retry") {
    await api(`/api/tasks/${taskId}/${verb}`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    if (verb === "retry") await queryClient.invalidateQueries({ queryKey: ["fs"] });
  }
  return (
    <div className="route-panel-body">
      <section className="route-card">
        <div className="route-list">
          {tasks.isLoading ? <div className="empty-state"><Loader2 className="spin" /> Loading</div> : null}
          {!tasks.isLoading && !tasks.data?.length ? <div className="empty-state">目前沒有任務</div> : null}
          {tasks.data?.map((task) => {
            const downloadTarget = completedCompressDownloadTarget(task);
            return (
              <div className="route-row task-route-row" key={task.id}>
                <Boxes />
                <div>
                  <strong>{task.type}</strong>
                  <span>{taskProgressLabel(task)}</span>
                  {task.error_message ? <small>{task.error_message}</small> : null}
                </div>
                <span className={`status ${task.status}`}>{task.status}</span>
                <progress value={taskProgressValue(task)} max={taskProgressMax(task)} />
                <div className="route-actions">
                  {downloadTarget ? (
                    <a className="task-action" href={downloadUrl(downloadTarget.rootSlug, downloadTarget.path)}><Download /> 下載</a>
                  ) : null}
                  {task.status === "queued" ? <button onClick={() => void action(task.id, "pause")}>暫停</button> : null}
                  {["queued", "paused"].includes(task.status) ? <button onClick={() => void action(task.id, "cancel")}>取消</button> : null}
                  {task.status === "paused" ? <button onClick={() => void action(task.id, "resume")}>繼續</button> : null}
                  {["failed", "cancelled", "interrupted"].includes(task.status) ? <button onClick={() => void action(task.id, "retry")}>重試</button> : null}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function SharesRoutePanel({ roots }: { roots: Root[] }) {
  const shares = useShares();
  const queryClient = useQueryClient();
  const [rootSlug, setRootSlug] = useState(roots[0]?.slug ?? "");
  const [sharePath, setSharePath] = useState("/");
  const [mode, setMode] = useState<"download" | "view_only" | "upload_only">("download");
  const [password, setPassword] = useState("");
  const [expiresDays, setExpiresDays] = useState("");
  const [maxDownloads, setMaxDownloads] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const passwordInvalid = Boolean(password && password.length < 8);

  useEffect(() => {
    if (!rootSlug && roots[0]) setRootSlug(roots[0].slug);
  }, [rootSlug, roots]);

  async function createShare() {
    if (!rootSlug || !sharePath || passwordInvalid) return;
    const days = Number(expiresDays);
    const downloads = Number(maxDownloads);
    const share = await api<{ token: string }>("/api/shares", {
      method: "POST",
      body: JSON.stringify({
        rootSlug,
        path: normalizePermissionInput(sharePath),
        mode,
        ...(password ? { password } : {}),
        ...(Number.isFinite(days) && days > 0 ? { expiresAt: Math.floor(Date.now() / 1000) + days * 86400 } : {}),
        ...(Number.isFinite(downloads) && downloads > 0 ? { maxDownloads: downloads } : {})
      })
    });
    setShareUrl(`${location.origin}/s/${share.token}`);
    setPassword("");
    setExpiresDays("");
    setMaxDownloads("");
    await queryClient.invalidateQueries({ queryKey: ["shares"] });
  }

  async function setDisabled(shareId: string, disabled: boolean) {
    await api(`/api/shares/${shareId}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
    await queryClient.invalidateQueries({ queryKey: ["shares"] });
  }

  async function remove(shareId: string) {
    await api(`/api/shares/${shareId}`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["shares"] });
  }

  return (
    <div className="route-panel-body">
      <section className="route-card route-form-grid">
        <select value={rootSlug} onChange={(event) => setRootSlug(event.target.value)}>
          {roots.map((root) => <option key={root.id} value={root.slug}>{root.name}</option>)}
        </select>
        <input value={sharePath} onChange={(event) => setSharePath(event.target.value)} placeholder="/public/file.jpg" />
        <select value={mode} onChange={(event) => setMode(event.target.value as "download" | "view_only" | "upload_only")}>
          <option value="download">下載</option>
          <option value="view_only">檢視</option>
          <option value="upload_only">只允許上傳</option>
        </select>
        <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="密碼（選填）" />
        <input type="number" min="1" value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)} placeholder="有效天數" />
        <input type="number" min="1" value={maxDownloads} onChange={(event) => setMaxDownloads(event.target.value)} placeholder="下載上限" />
        <button className="tool-button" onClick={createShare} disabled={!rootSlug || !sharePath || passwordInvalid}><Share2 /> 建立分享</button>
        {shareUrl ? <input readOnly value={shareUrl} /> : null}
      </section>
      <section className="route-card">
        <div className="route-list">
          {shares.data?.map((share) => (
            <div className="route-row" key={share.id}>
              <Share2 />
              <div>
                <strong>{rootById.get(share.root_id)?.slug ?? share.root_id}:{share.path}</strong>
                <span>{shareModeLabel(parseShareMode(share.permission_json))} · {share.disabled ? "已停用" : "啟用中"} · {share.download_count}{share.max_downloads ? `/${share.max_downloads}` : ""}</span>
              </div>
              <div className="route-actions">
                <button onClick={() => void setDisabled(share.id, !share.disabled)}>{share.disabled ? "啟用" : "停用"}</button>
                <button className="danger" onClick={() => void remove(share.id)}>刪除</button>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function UsersRoutePanel() {
  const users = useUsers();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<"ADMIN" | "USER" | "GUEST">("USER");
  async function createUser() {
    if (!email || password.length < 8) return;
    await api("/api/users", { method: "POST", body: JSON.stringify({ email, displayName: displayName || email.split("@")[0], password, role }) });
    setEmail("");
    setDisplayName("");
    setPassword("");
    setRole("USER");
    await queryClient.invalidateQueries({ queryKey: ["users"] });
  }
  return (
    <div className="route-panel-body">
      <section className="route-card route-form-grid">
        <input type="email" placeholder="user@example.test" value={email} onChange={(event) => setEmail(event.target.value)} />
        <input placeholder="顯示名稱" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
        <input type="password" placeholder="初始密碼" value={password} onChange={(event) => setPassword(event.target.value)} />
        <select value={role} onChange={(event) => setRole(event.target.value as "ADMIN" | "USER" | "GUEST")}>
          <option value="USER">USER</option>
          <option value="GUEST">GUEST</option>
          <option value="ADMIN">ADMIN</option>
        </select>
        <button className="tool-button" onClick={createUser} disabled={!email || password.length < 8}><UserPlus /> 新增使用者</button>
      </section>
      <section className="route-card">
        {users.error ? <div className="empty-state error">需要管理員權限</div> : null}
        <div className="route-list">
          {users.data?.map((user) => (
            <div className="route-row" key={user.id}>
              <UserPlus />
              <div><strong>{user.email}</strong><span>{user.display_name} · {user.role}</span></div>
              <span className={`status ${user.disabled ? "failed" : "done"}`}>{user.disabled ? "disabled" : "active"}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function GroupsRoutePanel() {
  const groups = useGroups();
  const users = useUsers();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState("");
  const [userId, setUserId] = useState("");
  async function createGroup() {
    if (!name) return;
    await api("/api/groups", { method: "POST", body: JSON.stringify({ name }) });
    setName("");
    await queryClient.invalidateQueries({ queryKey: ["groups"] });
  }
  async function addMember() {
    if (!groupId || !userId) return;
    await api(`/api/groups/${groupId}/members`, { method: "POST", body: JSON.stringify({ userId }) });
    setUserId("");
  }
  return (
    <div className="route-panel-body">
      <section className="route-card route-form-grid">
        <input placeholder="群組名稱" value={name} onChange={(event) => setName(event.target.value)} />
        <button className="tool-button" onClick={createGroup} disabled={!name}><Users /> 新增群組</button>
        <select value={groupId} onChange={(event) => setGroupId(event.target.value)}>
          <option value="">群組</option>
          {groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <select value={userId} onChange={(event) => setUserId(event.target.value)}>
          <option value="">使用者</option>
          {users.data?.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
        </select>
        <button className="tool-button" onClick={addMember} disabled={!groupId || !userId}>加入群組</button>
      </section>
      <section className="route-card">
        {groups.error ? <div className="empty-state error">需要管理員權限</div> : null}
        <div className="route-list">
          {groups.data?.map((group) => (
            <div className="route-row" key={group.id}><Users /><div><strong>{group.name}</strong><span>{formatUnixDate(group.created_at)}</span></div></div>
          ))}
        </div>
      </section>
    </div>
  );
}

function PermissionsRoutePanel({ roots }: { roots: Root[] }) {
  const users = useUsers();
  const groups = useGroups();
  const queryClient = useQueryClient();
  const [rootId, setRootId] = useState(roots[0]?.id ?? "");
  const [pathPrefix, setPathPrefix] = useState("/");
  const [principalType, setPrincipalType] = useState<"user" | "group">("group");
  const [principalId, setPrincipalId] = useState("");
  const [allow, setAllow] = useState<PermissionAction[]>(["list", "read"]);
  const [deny, setDeny] = useState<PermissionAction[]>([]);
  const [recursive, setRecursive] = useState(true);
  const permissions = usePermissions(rootId, Boolean(rootId));

  useEffect(() => {
    if (!rootId && roots[0]) setRootId(roots[0].id);
  }, [rootId, roots]);

  function toggleAction(action: PermissionAction, kind: "allow" | "deny") {
    const update = kind === "allow" ? setAllow : setDeny;
    const otherUpdate = kind === "allow" ? setDeny : setAllow;
    update((items) => items.includes(action) ? items.filter((item) => item !== action) : [...items, action]);
    otherUpdate((items) => items.filter((item) => item !== action));
  }

  async function createRule() {
    if (!rootId || !principalId || (allow.length === 0 && deny.length === 0)) return;
    await api("/api/permissions", {
      method: "POST",
      body: JSON.stringify({ principalType, principalId, rootId, pathPrefix: normalizePermissionInput(pathPrefix), allow, deny, recursive })
    });
    await queryClient.invalidateQueries({ queryKey: ["permissions"] });
    await queryClient.invalidateQueries({ queryKey: ["roots"] });
    await queryClient.invalidateQueries({ queryKey: ["fs"] });
  }

  async function deleteRule(ruleId: string) {
    await api(`/api/permissions/${ruleId}`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["permissions"] });
  }

  return (
    <div className="route-panel-body">
      <section className="route-card route-form-grid permission-editor">
        <select value={rootId} onChange={(event) => setRootId(event.target.value)}>
          {roots.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
        </select>
        <input value={pathPrefix} onChange={(event) => setPathPrefix(event.target.value)} placeholder="/public" />
        <select value={principalType} onChange={(event) => { setPrincipalType(event.target.value as "user" | "group"); setPrincipalId(""); }}>
          <option value="group">群組</option>
          <option value="user">使用者</option>
        </select>
        <select value={principalId} onChange={(event) => setPrincipalId(event.target.value)}>
          <option value="">Principal</option>
          {principalType === "group"
            ? groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)
            : users.data?.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
        </select>
        <label className="compact-check"><input type="checkbox" checked={recursive} onChange={(event) => setRecursive(event.target.checked)} /> 遞迴</label>
        <div className="permission-action-grid">
          {permissionActions.map((action) => (
            <div className="permission-action-row" key={action}>
              <span>{action}</span>
              <label><input type="checkbox" checked={allow.includes(action)} onChange={() => toggleAction(action, "allow")} /> allow</label>
              <label><input type="checkbox" checked={deny.includes(action)} onChange={() => toggleAction(action, "deny")} /> deny</label>
            </div>
          ))}
        </div>
        <button className="tool-button" onClick={createRule} disabled={!rootId || !principalId || (allow.length === 0 && deny.length === 0)}><KeyRound /> 儲存規則</button>
      </section>
      <section className="route-card">
        {permissions.error ? <div className="empty-state error">無法讀取權限規則</div> : null}
        <div className="route-list">
          {permissions.data?.map((rule) => (
            <div className="route-row" key={rule.id}>
              <KeyRound />
              <div>
                <strong>{rule.principal_type}:{rule.principal_id}</strong>
                <span>{rule.path_prefix}{rule.recursive ? "/*" : ""}</span>
                <div className="permission-badges">
                  {parseJsonArray(rule.allow_json).map((item) => <span className="allow" key={`${rule.id}-allow-${item}`}>{item}</span>)}
                  {parseJsonArray(rule.deny_json).map((item) => <span className="deny" key={`${rule.id}-deny-${item}`}>{item}</span>)}
                </div>
              </div>
              <button className="task-action" onClick={() => void deleteRule(rule.id)}>刪除</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function SettingsRoutePanel({ roots }: { roots: Root[] }) {
  return (
    <div className="route-panel-body">
      <section className="route-card">
        <div className="route-list">
          <div className="route-row">
            <HardDrive />
            <div><strong>Roots</strong><span>{roots.length}</span></div>
          </div>
          <div className="route-row">
            <Settings />
            <div><strong>Runtime</strong><span>single container</span></div>
          </div>
        </div>
      </section>
    </div>
  );
}

function TrashRoutePanel() {
  const trash = useTrash(true);
  const queryClient = useQueryClient();
  async function restore(itemId: string) {
    await api(`/api/trash/${itemId}/restore`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["trash"] });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["fs"] });
  }
  return (
    <div className="route-panel-body">
      <section className="route-card">
        <div className="route-list">
          {trash.isLoading ? <div className="empty-state"><Loader2 className="spin" /> Loading</div> : null}
          {!trash.isLoading && !trash.data?.length ? <div className="empty-state">沒有待還原的項目</div> : null}
          {trash.data?.map((item) => (
            <div className="route-row" key={item.id}>
              <Trash2 />
              <div><strong>{item.original_path.split("/").filter(Boolean).at(-1) ?? item.original_path}</strong><span>{item.original_path}</span></div>
              <small>{formatUnixDate(item.deleted_at)}</small>
              <button className="tool-button" onClick={() => void restore(item.id)}><RefreshCw /> 還原</button>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function AuditRoutePanel() {
  const audit = useAudit(true);
  return (
    <div className="route-panel-body">
      <section className="route-card">
        <div className="route-list">
          {audit.isLoading ? <div className="empty-state"><Loader2 className="spin" /> Loading</div> : null}
          {!audit.isLoading && !audit.data?.length ? <div className="empty-state">目前沒有稽核紀錄</div> : null}
          {audit.data?.map((item) => (
            <div className="route-row" key={item.id}>
              <span className={`audit-result ${item.result}`}>{item.result}</span>
              <div><strong>{item.action}</strong><span>{item.path ?? summarizeAuditTarget(item.target_json)}</span></div>
              <span>{item.actor_type}</span>
              <time>{formatUnixDate(item.created_at)}</time>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function Sidebar({
  roots,
  userEmail,
  activePanel,
  onShowDesktop,
  onOpenPanel,
  onOpenTrash,
  onOpenAudit
}: {
  roots: Root[];
  userEmail: string;
  activePanel: RoutePanel | null;
  onShowDesktop: () => void;
  onOpenPanel: (panel: RoutePanel) => void;
  onOpenTrash: () => void;
  onOpenAudit: () => void;
}) {
  const store = useWorkspaceStore();
  const queryClient = useQueryClient();
  const [rootName, setRootName] = useState("");
  const [rootSlug, setRootSlug] = useState("");
  const [rootBasePath, setRootBasePath] = useState("");
  const [rootReadonly, setRootReadonly] = useState(false);
  const collapsed = Boolean(store.sidebar.collapsed);

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
  }

  async function createRoot() {
    if (!rootSlug) return;
    await api("/api/roots", {
      method: "POST",
      body: JSON.stringify({
        slug: rootSlug,
        name: rootName || rootSlug,
        ...(rootBasePath.trim() ? { basePath: rootBasePath.trim() } : {}),
        readonly: rootReadonly
      })
    });
    setRootName("");
    setRootSlug("");
    setRootBasePath("");
    setRootReadonly(false);
    await queryClient.invalidateQueries({ queryKey: ["roots"] });
  }

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="brand-row compact">
        <div className="brand-mark">K</div>
        <strong>Kago</strong>
        <button className="icon-button" title={collapsed ? "展開側邊欄" : "收合側邊欄"} onClick={() => store.updateSidebar({ collapsed: !collapsed })}>
          <PanelRight />
        </button>
      </div>
      <nav className="side-nav">
        <span className="side-section">工作區</span>
        <button className={`side-item ${activePanel === null ? "active" : ""}`} onClick={onShowDesktop}><HardDrive /> Roots</button>
        <button className={`side-item ${activePanel === "shelf" ? "active" : ""}`} onClick={() => onOpenPanel("shelf")}><Archive /> 中轉區</button>
        <button className={`side-item ${activePanel === "tasks" ? "active" : ""}`} onClick={() => onOpenPanel("tasks")}><Boxes /> 任務</button>
        <button className={`side-item ${activePanel === "shares" ? "active" : ""}`} onClick={() => onOpenPanel("shares")}><Share2 /> 分享</button>
        <button className={`side-item ${activePanel === "trash" ? "active" : ""}`} onClick={onOpenTrash}><Trash2 /> 垃圾桶</button>
        <span className="side-section">管理</span>
        <button className={`side-item ${activePanel === "users" ? "active" : ""}`} onClick={() => onOpenPanel("users")}><UserPlus /> 使用者</button>
        <button className={`side-item ${activePanel === "groups" ? "active" : ""}`} onClick={() => onOpenPanel("groups")}><Users /> 群組</button>
        <button className={`side-item ${activePanel === "permissions" ? "active" : ""}`} onClick={() => onOpenPanel("permissions")}><KeyRound /> 權限</button>
        <button className={`side-item ${activePanel === "settings" ? "active" : ""}`} onClick={() => onOpenPanel("settings")}><Settings /> 設定</button>
        <button className={`side-item ${activePanel === "audit" ? "active" : ""}`} onClick={onOpenAudit}><SlidersHorizontal /> 稽核紀錄</button>
      </nav>
      <div className="root-list">
        <span className="side-section">Roots</span>
        {roots.map((root) => (
          <div className="root-row" key={root.id}>
            <button className="root-button" onClick={() => store.openRoot(root)}>
              <FolderOpen />
              <span>{root.name}</span>
              {root.readonly ? <span className="badge">RO</span> : null}
            </button>
            <button
              className="icon-button root-new-window"
              title="以新視窗開啟"
              onClick={() => store.openWindow({ rootSlug: root.slug, logicalPath: "/", title: root.name })}
            >
              <CirclePlus />
            </button>
          </div>
        ))}
      </div>
      <div className="mini-form">
        <input placeholder="root slug" value={rootSlug} onChange={(event) => setRootSlug(event.target.value)} />
        <input placeholder="顯示名稱" value={rootName} onChange={(event) => setRootName(event.target.value)} />
        <input placeholder="/data/photos" value={rootBasePath} onChange={(event) => setRootBasePath(event.target.value)} />
        <label className="compact-check">
          <input type="checkbox" checked={rootReadonly} onChange={(event) => setRootReadonly(event.target.checked)} />
          唯讀
        </label>
        <button onClick={createRoot}><Plus /> 新增 Root</button>
      </div>
      <div className="sidebar-footer">
        <span>{userEmail}</span>
        <button className="icon-button" onClick={logout} title="Logout"><LogOut /></button>
      </div>
    </aside>
  );
}

function RootPicker({ roots }: { roots: Root[] }) {
  const store = useWorkspaceStore();
  const queryClient = useQueryClient();
  const [rootName, setRootName] = useState("");
  const [rootSlug, setRootSlug] = useState("");
  const [rootBasePath, setRootBasePath] = useState("");
  const [rootReadonly, setRootReadonly] = useState(false);

  async function createRoot(event: React.FormEvent) {
    event.preventDefault();
    if (!rootSlug) return;
    await api("/api/roots", {
      method: "POST",
      body: JSON.stringify({
        slug: rootSlug,
        name: rootName || rootSlug,
        ...(rootBasePath.trim() ? { basePath: rootBasePath.trim() } : {}),
        readonly: rootReadonly
      })
    });
    setRootName("");
    setRootSlug("");
    setRootBasePath("");
    setRootReadonly(false);
    await queryClient.invalidateQueries({ queryKey: ["roots"] });
  }

  return (
    <section className="root-picker">
      <div className="root-picker-inner">
        <div className="root-picker-mark"><HardDrive /></div>
        <h2>選擇一個 Root</h2>
        <p>從左側建立或開啟 NAS 掛載點，Kago 會替每個位置開啟獨立檔案視窗。</p>
        <div className="picker-grid">
          {roots.map((root) => (
            <button key={root.id} onClick={() => store.openRoot(root)}>
              <FolderOpen />
              <span>{root.name}</span>
            </button>
          ))}
        </div>
        <form className="root-create-form" onSubmit={createRoot}>
          <input placeholder="root slug" value={rootSlug} onChange={(event) => setRootSlug(event.target.value)} />
          <input placeholder="顯示名稱" value={rootName} onChange={(event) => setRootName(event.target.value)} />
          <input placeholder="/data/photos" value={rootBasePath} onChange={(event) => setRootBasePath(event.target.value)} />
          <label className="compact-check">
            <input type="checkbox" checked={rootReadonly} onChange={(event) => setRootReadonly(event.target.checked)} />
            唯讀
          </label>
          <button className="tool-button" disabled={!rootSlug.trim()}><Plus /> 新增 Root</button>
        </form>
      </div>
    </section>
  );
}

function FileWindowView({ window }: { window: FileWindow }) {
  const store = useWorkspaceStore();
  const queryClient = useQueryClient();
  const fileList = useFileList(window.rootSlug, window.logicalPath);
  const readonly = Boolean(fileList.data?.readonly);
  const [drag, setDrag] = useState<PointerDragState | null>(null);
  const [resize, setResize] = useState<PointerResizeState | null>(null);
  const [selectionDrag, setSelectionDrag] = useState<SelectionDragState | null>(null);
  const [dropChoice, setDropChoice] = useState<{ items: Array<{ rootSlug: string; path: string }> } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ item: FileItem; x: number; y: number } | null>(null);
  const [previewItem, setPreviewItem] = useState<FileItem | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [addressDraft, setAddressDraft] = useState(window.logicalPath);
  const [addressEditing, setAddressEditing] = useState(false);
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);
  const [operationError, setOperationError] = useState("");
  const [busyAction, setBusyAction] = useState<"mkdir" | "upload" | null>(null);

  useEffect(() => {
    function move(event: PointerEvent) {
      if (drag && event.pointerId === drag.pointerId) {
        const minX = globalThis.innerWidth > 980 ? (store.sidebar.collapsed ? 96 : 276) : 8;
        const maxX = Math.max(minX, globalThis.innerWidth - 120);
        const maxY = Math.max(46, globalThis.innerHeight - 80);
        store.updateWindow(window.id, {
          x: Math.min(maxX, Math.max(minX, drag.x + event.clientX - drag.startX)),
          y: Math.min(maxY, Math.max(46, drag.y + event.clientY - drag.startY))
        });
      }
      if (resize && event.pointerId === resize.pointerId) {
        const maxWidth = Math.max(360, globalThis.innerWidth - window.x - 16);
        const maxHeight = Math.max(280, globalThis.innerHeight - window.y - 16);
        store.updateWindow(window.id, {
          width: Math.min(maxWidth, Math.max(360, resize.width + event.clientX - resize.startX)),
          height: Math.min(maxHeight, Math.max(280, resize.height + event.clientY - resize.startY))
        });
      }
    }
    function up(event: PointerEvent) {
      if (drag && event.pointerId === drag.pointerId) setDrag(null);
      if (resize && event.pointerId === resize.pointerId) setResize(null);
    }
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", up);
    globalThis.addEventListener("pointercancel", up);
    return () => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", up);
      globalThis.removeEventListener("pointercancel", up);
    };
  }, [drag, resize, store, window.id, window.width, window.x]);

  useEffect(() => {
    if (!contextMenu) return;
    function closeMenu(event: MouseEvent | KeyboardEvent) {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      setContextMenu(null);
    }
    globalThis.addEventListener("click", closeMenu);
    globalThis.addEventListener("keydown", closeMenu);
    return () => {
      globalThis.removeEventListener("click", closeMenu);
      globalThis.removeEventListener("keydown", closeMenu);
    };
  }, [contextMenu]);

  useEffect(() => {
    if (!addressEditing) setAddressDraft(window.logicalPath);
  }, [addressEditing, window.logicalPath]);

  const sortedItems = useMemo(() => {
    const items = [...(fileList.data?.items ?? [])];
    const direction = window.sortDirection === "asc" ? 1 : -1;
    items.sort((a, b) => {
      let result = 0;
      if (window.sortBy === "size") result = a.size - b.size;
      else if (window.sortBy === "mtime") result = a.mtime - b.mtime;
      else {
        const av = window.sortBy === "type" ? a.type : a.name;
        const bv = window.sortBy === "type" ? b.type : b.name;
        result = av.localeCompare(bv, undefined, { numeric: true, sensitivity: "base" });
      }
      if (result === 0) result = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      return result * direction;
    });
    return items;
  }, [fileList.data, window.sortBy, window.sortDirection]);

  const visibleItems = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return sortedItems;
    return sortedItems.filter((item) => {
      const haystack = `${item.name} ${item.path} ${item.kind} ${item.type}`.toLocaleLowerCase();
      return haystack.includes(query);
    });
  }, [searchQuery, sortedItems]);
  const fileWindowError = classifyFileWindowError(fileList.error);
  const visibleWindowItems = fileWindowError ? [] : visibleItems;
  const selectedColumnItem = window.viewMode === "columns" ? visibleWindowItems.find((item) => item.path === window.selectedItems[0]) ?? null : null;

  useEffect(() => {
    if (fileWindowError?.kind === "forbidden" && window.selectedItems.length > 0) {
      store.selectItems(window.id, []);
    }
  }, [fileWindowError?.kind, store, window.id, window.selectedItems.length]);

  async function createTask(type: "copy" | "move") {
    if (!dropChoice || readonly) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ type, sources: dropChoice.items, destination: { rootSlug: window.rootSlug, path: window.logicalPath } })
    });
    setDropChoice(null);
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function mkdir() {
    if (readonly) return;
    const name = prompt("Folder name");
    if (!name) return;
    setBusyAction("mkdir");
    setOperationError("");
    try {
      await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: window.logicalPath, name }) });
      await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "建立資料夾失敗");
    } finally {
      setBusyAction(null);
    }
  }

  async function compressSelection() {
    if (readonly || window.selectedItems.length === 0) return;
    const name = prompt("壓縮檔名稱", `${window.title || "archive"}.zip`);
    if (!name) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "compress",
        sources: window.selectedItems.map((path) => ({ rootSlug: window.rootSlug, path })),
        destination: { rootSlug: window.rootSlug, path: joinLogicalPath(window.logicalPath, ensureZipName(name)) }
      })
    });
    store.selectItems(window.id, []);
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function downloadSelection() {
    if (window.selectedItems.length === 0) return;
    if (window.selectedItems.length === 1) {
      globalThis.open(downloadUrl(window.rootSlug, window.selectedItems[0]!), "_blank");
      return;
    }
    const stamp = new Date().toISOString().replaceAll(":", "").replace(/\.\d+Z$/, "Z");
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "compress",
        sources: window.selectedItems.map((path) => ({ rootSlug: window.rootSlug, path })),
        destination: { rootSlug: window.rootSlug, path: joinLogicalPath(window.logicalPath, ensureZipName(`download-${stamp}.zip`)) }
      })
    });
    store.selectItems(window.id, []);
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function extractSelection() {
    if (readonly || window.selectedItems.length === 0) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "extract",
        sources: window.selectedItems.map((path) => ({ rootSlug: window.rootSlug, path })),
        destination: { rootSlug: window.rootSlug, path: window.logicalPath }
      })
    });
    store.selectItems(window.id, []);
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    if (readonly) {
      event.target.value = "";
      return;
    }
    const files = event.target.files;
    if (!files?.length) return;
    const form = new FormData();
    form.append("rootSlug", window.rootSlug);
    form.append("path", window.logicalPath);
    for (const file of files) form.append("file", file);
    setBusyAction("upload");
    setOperationError("");
    try {
      await api("/api/fs/upload", { method: "POST", body: form });
      event.target.value = "";
      await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "上傳失敗");
    } finally {
      setBusyAction(null);
    }
  }

  function openContextMenu(event: React.MouseEvent<HTMLElement>, item: FileItem) {
    event.preventDefault();
    event.stopPropagation();
    if (!window.selectedItems.includes(item.path)) {
      store.selectItems(window.id, [item.path]);
      setLastSelectedPath(item.path);
    }
    const host = event.currentTarget.closest(".file-window") as HTMLElement | null;
    const rect = host?.getBoundingClientRect();
    const x = rect ? event.clientX - rect.left : event.clientX;
    const y = rect ? event.clientY - rect.top : event.clientY;
    setContextMenu({ item, x: Math.max(8, Math.min(x, window.width - 190)), y: Math.max(44, Math.min(y, window.height - 250)) });
  }

  function openItem(item: FileItem, newWindow = false) {
    setContextMenu(null);
    if (item.kind === "folder") {
      if (newWindow) store.openWindow({ rootSlug: window.rootSlug, logicalPath: item.path, title: item.name });
      else store.updateWindow(window.id, { logicalPath: item.path, selectedItems: [] });
      return;
    }
    setPreviewItem(item);
  }

  function commitAddressDraft(value = addressDraft) {
    const nextPath = normalizeAddressInput(value, window.rootSlug);
    if (!nextPath) {
      setAddressDraft(window.logicalPath);
      setAddressEditing(false);
      setOperationError("路徑格式無效");
      return;
    }
    setAddressDraft(nextPath);
    setAddressEditing(false);
    setOperationError("");
    if (nextPath !== window.logicalPath) store.updateWindow(window.id, { logicalPath: nextPath, selectedItems: [] });
  }

  function beginSelectionDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!isPrimaryPointerStart(event) || isEditableTarget(event.target)) return;
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(".file-row, .file-header, .column-detail, button, a, input, label")) return;
    if (fileWindowError || visibleWindowItems.length === 0) return;
    const point = localPointerPoint(event, event.currentTarget);
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelectionDrag({ pointerId: event.pointerId, startX: point.x, startY: point.y, currentX: point.x, currentY: point.y });
    store.selectItems(window.id, []);
    setLastSelectedPath(null);
  }

  function updateSelectionDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!selectionDrag || event.pointerId !== selectionDrag.pointerId) return;
    const point = localPointerPoint(event, event.currentTarget);
    const nextDrag = { ...selectionDrag, currentX: point.x, currentY: point.y };
    setSelectionDrag(nextDrag);
    const selectedPaths = pathsIntersectingSelection(event.currentTarget, nextDrag);
    store.selectItems(window.id, selectedPaths);
    if (selectedPaths.length > 0) setLastSelectedPath(selectedPaths.at(-1) ?? null);
  }

  function endSelectionDrag(event: React.PointerEvent<HTMLDivElement>) {
    if (!selectionDrag || event.pointerId !== selectionDrag.pointerId) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
    setSelectionDrag(null);
  }

  async function addItemToShelf(item: FileItem) {
    setContextMenu(null);
    const shelves = await api<Array<{ id: string }>>("/api/shelves");
    const shelfId = shelves[0]?.id;
    if (!shelfId) return;
    await api(`/api/shelves/${shelfId}/items`, { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: item.path }) });
    await queryClient.invalidateQueries({ queryKey: ["shelves"] });
  }

  async function renameContextItem(item: FileItem) {
    setContextMenu(null);
    if (readonly || item.readonly) return;
    const nextName = prompt("新的名稱", item.name);
    if (!nextName || nextName === item.name) return;
    await api("/api/fs/rename", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: item.path, name: nextName }) });
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
  }

  async function trashContextItem(item: FileItem) {
    setContextMenu(null);
    if (readonly || item.readonly) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ type: "delete_to_trash", sources: [{ rootSlug: window.rootSlug, path: item.path }] })
    });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
  }

  function selectItem(event: React.MouseEvent<HTMLElement>, item: FileItem) {
    const visiblePaths = visibleItems.map((entry) => entry.path);
    const selected = window.selectedItems.includes(item.path);
    if (event.shiftKey && visiblePaths.length > 0) {
      const anchor = lastSelectedPath ?? window.selectedItems.at(-1) ?? item.path;
      const anchorIndex = Math.max(0, visiblePaths.indexOf(anchor));
      const itemIndex = visiblePaths.indexOf(item.path);
      if (itemIndex !== -1) {
        const [start, end] = anchorIndex < itemIndex ? [anchorIndex, itemIndex] : [itemIndex, anchorIndex];
        store.selectItems(window.id, visiblePaths.slice(start, end + 1));
        return;
      }
    }
    if (event.metaKey || event.ctrlKey) {
      store.selectItems(window.id, selected ? window.selectedItems.filter((path) => path !== item.path) : [...window.selectedItems, item.path]);
      setLastSelectedPath(item.path);
      return;
    }
    store.selectItems(window.id, selected && window.selectedItems.length === 1 ? [] : [item.path]);
    setLastSelectedPath(item.path);
  }

  function updateSort(sortBy: FileWindow["sortBy"]) {
    const sameField = window.sortBy === sortBy;
    store.updateWindow(window.id, {
      sortBy,
      sortDirection: sameField ? (window.sortDirection === "asc" ? "desc" : "asc") : defaultSortDirection(sortBy),
      selectedItems: []
    });
  }

  function sortHeader(sortBy: FileWindow["sortBy"], label: string) {
    const active = window.sortBy === sortBy;
    const nextDirection = active ? (window.sortDirection === "asc" ? "desc" : "asc") : defaultSortDirection(sortBy);
    return (
      <button
        type="button"
        className={`sort-header ${active ? "active" : ""}`}
        aria-sort={active ? (window.sortDirection === "asc" ? "ascending" : "descending") : "none"}
        aria-label={`依${label}${nextDirection === "asc" ? "升冪" : "降冪"}排序`}
        onClick={() => updateSort(sortBy)}
      >
        <span>{label}</span>
        <span className="sort-indicator">{active ? (window.sortDirection === "asc" ? "↑" : "↓") : "↕"}</span>
      </button>
    );
  }

  return (
    <section
      className={`file-window ${window.focused ? "focused" : ""} ${window.maximized ? "maximized" : ""}`}
      style={window.maximized ? { zIndex: window.zIndex } : { left: window.x, top: window.y, width: window.width, height: window.height, zIndex: window.zIndex }}
      onMouseDown={() => store.focusWindow(window.id)}
      data-window={window.id}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        if (readonly) return;
        const rawItems = event.dataTransfer.getData("application/kago-files");
        const rawItem = event.dataTransfer.getData("application/kago-file");
        try {
          const items = rawItems
            ? JSON.parse(rawItems) as Array<{ rootSlug: string; path: string }>
            : rawItem ? [JSON.parse(rawItem) as { rootSlug: string; path: string }] : [];
          if (items.length > 0) setDropChoice({ items });
        } catch {
          setDropChoice(null);
        }
      }}
    >
      <div
        className="window-titlebar"
        onPointerDown={(event) => {
          if (!isPrimaryPointerStart(event) || isInteractiveTarget(event.target)) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: window.x, y: window.y });
        }}
        onDoubleClick={() => store.updateWindow(window.id, { maximized: !window.maximized })}
      >
        <div className="traffic-lights"><span /><span /><span /></div>
        <Folder className="title-folder" />
        <strong>{window.title}</strong>
        <span>{window.title} · {window.rootSlug}:{window.logicalPath}</span>
        {readonly ? <span className="readonly-pill">唯讀</span> : null}
        <div className="window-controls">
          <button className="icon-button" onClick={(event) => { event.stopPropagation(); store.updateWindow(window.id, { minimized: !window.minimized }); }}><Minimize2 /></button>
          <button className="icon-button" onClick={(event) => { event.stopPropagation(); store.updateWindow(window.id, { maximized: !window.maximized }); }}><Maximize2 /></button>
          <button className="icon-button danger" onClick={(event) => { event.stopPropagation(); store.closeWindow(window.id); }}><X /></button>
        </div>
      </div>
      {!window.minimized && (
        <>
          <div className="finder-window-body">
            <aside className="window-finder-sidebar">
              <WindowFolderSidebar activeLabel={window.title} rootSlug={window.rootSlug} />
            </aside>
            <div className="window-content">
              <div className="file-station-toolbar">
                <div className="address-row">
                  <div className="nav-cluster">
                    <button className="icon-button" disabled={window.logicalPath === "/"} onClick={() => store.updateWindow(window.id, { logicalPath: parentPath(window.logicalPath), selectedItems: [] })}><ChevronLeft /></button>
                    <button className="icon-button" disabled><ChevronRight /></button>
                    <button className="icon-button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] })}><RefreshCw /></button>
                  </div>
                  <div className={`address-field ${addressEditing ? "editing" : ""}`}>
                    <span className="address-root">{window.rootSlug}</span>
                    <input
                      aria-label="目前路徑"
                      data-address-target
                      value={addressDraft}
                      onFocus={() => {
                        setAddressDraft(window.logicalPath);
                        setAddressEditing(true);
                      }}
                      onBlur={(event) => commitAddressDraft(event.currentTarget.value)}
                      onChange={(event) => setAddressDraft(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          commitAddressDraft(event.currentTarget.value);
                          event.currentTarget.blur();
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setAddressDraft(window.logicalPath);
                          setAddressEditing(false);
                          event.currentTarget.blur();
                        }
                      }}
                    />
                    <Star />
                  </div>
                  <label className="search-pill window-search">
                    <Search />
                    <input
                      aria-label="搜尋目前資料夾"
                      placeholder="搜尋目前資料夾"
                      value={searchQuery}
                      onChange={(event) => {
                        setSearchQuery(event.target.value);
                        store.selectItems(window.id, []);
                        setLastSelectedPath(null);
                      }}
                    />
                    {searchQuery ? (
                      <button
                        type="button"
                        className="search-clear"
                        aria-label="清除搜尋"
                        onClick={() => {
                          setSearchQuery("");
                          store.selectItems(window.id, []);
                          setLastSelectedPath(null);
                        }}
                      >
                        <X />
                      </button>
                    ) : null}
                  </label>
                </div>
                <div className="action-row">
                  <button className="tool-button" onClick={mkdir} disabled={readonly || Boolean(busyAction)}>
                    {busyAction === "mkdir" ? <Loader2 className="spin" /> : <Folder />} 建立資料夾
                  </button>
                  <label className={`tool-button file-input ${readonly || busyAction ? "disabled" : ""}`} aria-disabled={readonly || Boolean(busyAction)}>
                    {busyAction === "upload" ? <Loader2 className="spin" /> : <Upload />} 上傳檔案<input type="file" multiple onChange={upload} disabled={readonly || Boolean(busyAction)} />
                  </label>
                  {window.selectedItems.length > 0 ? (
                    <>
                      <button className="tool-button" onClick={() => void downloadSelection()}><Download /> 下載選取</button>
                      <button className="tool-button" onClick={() => void compressSelection()} disabled={readonly}><Archive /> 壓縮</button>
                      <button className="tool-button" onClick={() => void extractSelection()} disabled={readonly}><FolderOpen /> 解壓縮</button>
                    </>
                  ) : null}
                  <button
                    className={`tool-button ${store.inspector.open === false ? "" : "selected"}`}
                    onClick={() => store.updateInspector({ open: store.inspector.open === false })}
                  >
                    <PanelRight /> 檢閱器
                  </button>
                  <div className="window-view-tools">
                    <button className={window.viewMode === "list" ? "selected" : ""} onClick={() => store.updateWindow(window.id, { viewMode: "list" })}><List /></button>
                    <button className={window.viewMode === "grid" ? "selected" : ""} onClick={() => store.updateWindow(window.id, { viewMode: "grid" })}><LayoutGrid /></button>
                    <button className={window.viewMode === "columns" ? "selected" : ""} onClick={() => store.updateWindow(window.id, { viewMode: "columns" })}><Columns3 /></button>
                  </div>
                </div>
              </div>
              {operationError ? <div className="inline-error window-operation-error">{operationError}</div> : null}
              <div
                className={`file-list ${window.viewMode} ${selectionDrag ? "selecting" : ""}`}
                onPointerDown={beginSelectionDrag}
                onPointerMove={updateSelectionDrag}
                onPointerUp={endSelectionDrag}
                onPointerCancel={endSelectionDrag}
              >
                {window.viewMode === "list" && (
                  <div className="file-header">
                    {sortHeader("name", "名稱")}
                    {sortHeader("size", "大小")}
                    {sortHeader("type", "種類")}
                    {sortHeader("mtime", "加入日期")}
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                )}
                {fileList.isLoading && <div className="empty-state"><Loader2 className="spin" /> Loading</div>}
                {!fileList.isLoading && fileWindowError ? (
                  <WindowErrorState
                    error={fileWindowError}
                    window={window}
                    onClose={() => store.closeWindow(window.id)}
                    onGoToRoot={() => store.updateWindow(window.id, { logicalPath: "/", selectedItems: [] })}
                  />
                ) : null}
                {!fileList.isLoading && !fileWindowError && fileList.data && visibleWindowItems.length === 0 && (
                  <div className="empty-state file-empty">
                    <FolderOpen />
                    <strong>{searchQuery ? "沒有符合的項目" : "資料夾是空的"}</strong>
                    <span>
                      {searchQuery
                        ? `找不到符合「${searchQuery.trim()}」的檔案或資料夾。`
                        : readonly ? "這個 root 是唯讀模式。" : "你可以建立資料夾或上傳檔案。"}
                    </span>
                  </div>
                )}
                {visibleWindowItems.map((item) => (
                  <FileRow
                    key={item.path}
                    item={item}
                    window={window}
                    readonly={readonly}
                    onOpenContext={openContextMenu}
                    onSelect={selectItem}
                    onOpen={openItem}
                  />
                ))}
                {window.viewMode === "columns" ? (
                  <aside className="column-detail">
                    {selectedColumnItem ? (
                      <>
                        <div className="column-detail-icon">
                          {selectedColumnItem.kind === "folder" ? <FolderOpen /> : <FileText />}
                        </div>
                        <strong>{selectedColumnItem.name}</strong>
                        <small>{selectedColumnItem.path}</small>
                        <dl>
                          <dt>種類</dt><dd>{selectedColumnItem.kind === "folder" ? "資料夾" : selectedColumnItem.type}</dd>
                          <dt>大小</dt><dd>{formatSize(selectedColumnItem.size)}</dd>
                          <dt>修改時間</dt><dd>{formatDate(selectedColumnItem.mtime)}</dd>
                        </dl>
                        <div className="column-detail-actions">
                          <button onClick={() => openItem(selectedColumnItem)}>
                            {selectedColumnItem.kind === "folder" ? <FolderOpen /> : <FileText />} 開啟
                          </button>
                          {selectedColumnItem.kind === "folder" ? (
                            <button onClick={() => openItem(selectedColumnItem, true)}><CirclePlus /> 新視窗</button>
                          ) : null}
                        </div>
                      </>
                    ) : (
                      <div className="column-detail-empty">
                        <Columns3 />
                        <strong>直欄預覽</strong>
                        <span>選取項目後顯示摘要。</span>
                      </div>
                    )}
                  </aside>
                ) : null}
                {selectionDrag ? <div className="selection-marquee" style={selectionMarqueeStyle(selectionDrag)} /> : null}
              </div>
              <div className="statusbar">
                <span className="pathbar"><HardDrive /> {window.rootSlug} <ChevronRight /> {window.logicalPath === "/" ? window.title : window.logicalPath.split("/").filter(Boolean).join(" › ")}</span>
                <span>{fileWindowError ? "無法讀取目前位置" : searchQuery ? `${visibleWindowItems.length} / ${sortedItems.length} 個項目` : `${sortedItems.length} 個項目`}</span>
                <button onClick={() => store.updateWindow(window.id, { viewMode: nextViewMode(window.viewMode) })}><List /> {viewModeLabel(window.viewMode)}</button>
              </div>
            </div>
          </div>
          <div
            className="resize-handle"
            onPointerDown={(event) => {
              if (!isPrimaryPointerStart(event)) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              setResize({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, width: window.width, height: window.height });
            }}
          />
        </>
      )}
      {dropChoice && (
        <div className="drop-popover">
          <strong>{dropChoice.items.length} 個項目</strong>
          {readonly ? <span>這個視窗是唯讀目的地</span> : null}
          <button onClick={() => void createTask("copy")} disabled={readonly}>複製到這裡</button>
          <button onClick={() => void createTask("move")} disabled={readonly}>搬移到這裡</button>
          <button onClick={() => setDropChoice(null)}>取消</button>
        </div>
      )}
      {contextMenu ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(event) => event.stopPropagation()}
        >
          <button onClick={() => openItem(contextMenu.item)}>
            {contextMenu.item.kind === "folder" ? <FolderOpen /> : <FileText />} 開啟
          </button>
          {contextMenu.item.kind === "folder" ? (
            <button onClick={() => openItem(contextMenu.item, true)}><CirclePlus /> 在新視窗開啟</button>
          ) : (
            <a href={downloadUrl(window.rootSlug, contextMenu.item.path)}><Download /> 下載</a>
          )}
          <button onClick={() => void addItemToShelf(contextMenu.item)}><Archive /> 加入中轉區</button>
          <span />
          <button disabled={readonly || contextMenu.item.readonly} onClick={() => void renameContextItem(contextMenu.item)}><Pencil /> 重新命名</button>
          <button className="danger" disabled={readonly || contextMenu.item.readonly} onClick={() => void trashContextItem(contextMenu.item)}><Trash2 /> 移到垃圾桶</button>
        </div>
      ) : null}
      {previewItem ? (
        <div className="preview-modal" onMouseDown={(event) => event.stopPropagation()}>
          <div className="preview-window">
            <header>
              <strong><FileText /> {previewItem.name}</strong>
              <div>
                <a className="icon-button" href={downloadUrl(window.rootSlug, previewItem.path)} title="下載"><Download /></a>
                <button className="icon-button" onClick={() => setPreviewItem(null)} title="關閉預覽"><X /></button>
              </div>
            </header>
            <iframe title={previewItem.name} src={previewUrl(window.rootSlug, previewItem.path)} />
          </div>
        </div>
      ) : null}
    </section>
  );
}

function WindowFolderSidebar({ activeLabel, rootSlug }: { activeLabel: string; rootSlug: string }) {
  return (
    <nav className="window-side-nav">
      <button className="tree-root"><Server /> {rootSlug || activeLabel || "Root"}</button>
      <button className="tree-child selected"><ChevronRight /> <Folder /> 目前資料夾</button>
      <span>此視窗</span>
      <button><Share2 /> 已共享</button>
      <button><Trash2 /> 垃圾桶</button>
    </nav>
  );
}

function FileRow({
  item,
  window,
  readonly,
  onOpenContext,
  onSelect,
  onOpen
}: {
  item: FileItem;
  window: FileWindow;
  readonly: boolean;
  onOpenContext: (event: React.MouseEvent<HTMLElement>, item: FileItem) => void;
  onSelect: (event: React.MouseEvent<HTMLElement>, item: FileItem) => void;
  onOpen: (item: FileItem, newWindow?: boolean) => void;
}) {
  const store = useWorkspaceStore();
  const selected = window.selectedItems.includes(item.path);
  const queryClient = useQueryClient();
  const canWrite = !readonly && !item.readonly;

  async function addToShelf() {
    const shelves = await api<Array<{ id: string }>>("/api/shelves");
    const shelfId = shelves[0]?.id;
    if (!shelfId) return;
    await api(`/api/shelves/${shelfId}/items`, { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: item.path }) });
    await queryClient.invalidateQueries({ queryKey: ["shelves"] });
  }

  return (
    <div
      className={`file-row ${selected ? "selected" : ""}`}
      data-file-path={item.path}
      data-file-kind={item.kind}
      data-download-url={item.kind === "file" ? downloadUrl(window.rootSlug, item.path) : undefined}
      data-preview-url={item.kind === "file" ? previewUrl(window.rootSlug, item.path) : undefined}
      draggable
      onDragStart={(event) => {
        const paths = selected && window.selectedItems.length > 0 ? window.selectedItems : [item.path];
        const items = paths.map((path) => ({ rootSlug: window.rootSlug, path }));
        event.dataTransfer.setData("application/kago-files", JSON.stringify(items));
        event.dataTransfer.setData("application/kago-file", JSON.stringify(items[0]));
      }}
      onMouseDown={(event) => {
        if (event.button === 1 && item.kind === "folder") {
          event.preventDefault();
          onOpen(item, true);
        }
      }}
      onClick={(event) => onSelect(event, item)}
      onContextMenu={(event) => onOpenContext(event, item)}
      onDoubleClick={() => {
        if (item.kind === "folder") onOpen(item);
        else onOpen(item);
      }}
    >
      <FileGlyph item={item} window={window} />
      <span className="file-name">{item.name}</span>
      <span>{formatSize(item.size)}</span>
      <span>{item.kind === "folder" ? "檔案夾" : item.type}</span>
      <span>{formatDate(item.mtime)}</span>
      <a className="icon-button" href={downloadUrl(window.rootSlug, item.path)} onClick={(event) => event.stopPropagation()}><Download /></a>
      <button className="icon-button" disabled={!canWrite} onClick={(event) => { event.stopPropagation(); void renameItem(); }} title={canWrite ? "重新命名" : "唯讀項目"}><Pencil /></button>
      <button className="icon-button" onClick={(event) => { event.stopPropagation(); void addToShelf(); }} title="加入中轉區"><Archive /></button>
      <button className="icon-button danger" disabled={!canWrite} onClick={(event) => { event.stopPropagation(); void trashItem(); }} title={canWrite ? "移到垃圾桶" : "唯讀項目"}><Trash2 /></button>
    </div>
  );

  async function renameItem() {
    if (!canWrite) return;
    const nextName = prompt("新的名稱", item.name);
    if (!nextName || nextName === item.name) return;
    await api("/api/fs/rename", {
      method: "POST",
      body: JSON.stringify({ rootSlug: window.rootSlug, path: item.path, name: nextName })
    });
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
  }

  async function trashItem() {
    if (!canWrite) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ type: "delete_to_trash", sources: [{ rootSlug: window.rootSlug, path: item.path }] })
    });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
  }
}

function WindowErrorState({
  error,
  window,
  onClose,
  onGoToRoot
}: {
  error: FileWindowErrorState;
  window: FileWindow;
  onClose: () => void;
  onGoToRoot: () => void;
}) {
  async function requestAccess() {
    const subject = encodeURIComponent(`Kago access request: ${window.rootSlug}${window.logicalPath}`);
    const body = encodeURIComponent(`Root: ${window.rootSlug}\nPath: ${window.logicalPath}\n\nPlease grant access to this folder.`);
    globalThis.open(`mailto:?subject=${subject}&body=${body}`, "_blank");
  }

  return (
    <div className={`empty-state file-window-error ${error.kind}`}>
      {error.kind === "root_missing" ? <HardDrive /> : error.kind === "path_missing" ? <FolderOpen /> : <ShieldAlert />}
      <strong>{error.title}</strong>
      <span>{error.message}</span>
      <div className="window-error-actions">
        {error.kind === "path_missing" ? <button className="tool-button" onClick={onGoToRoot}><Home /> 回到 Root</button> : null}
        {error.kind === "forbidden" ? <button className="tool-button" onClick={() => void requestAccess()}><Share2 /> 申請存取</button> : null}
        <button className="tool-button" onClick={onClose}><X /> 關閉視窗</button>
      </div>
    </div>
  );
}

function FileGlyph({ item, window }: { item: FileItem; window: FileWindow }) {
  if (window.viewMode === "grid") {
    return (
      <span className="thumbnail-frame">
        <img alt="" src={thumbnailUrl(window.rootSlug, item.path)} loading="lazy" />
      </span>
    );
  }
  return item.kind === "folder" ? <FolderOpen className="folder-glyph" /> : <FileIcon />;
}

function FileIcon() {
  return <div className="file-icon" />;
}

function FloatingShelf() {
  const shelves = useShelves();
  const store = useWorkspaceStore();
  const active = store.windows.find((window) => window.id === store.activeWindowId);
  const activeList = useFileList(active?.rootSlug ?? "", active?.logicalPath ?? "/", Boolean(active));
  const activeReadonly = Boolean(activeList.data?.readonly);
  const queryClient = useQueryClient();
  const [shelfDrag, setShelfDrag] = useState<PointerDragState | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const [dropError, setDropError] = useState("");
  const shelf = shelves.data?.[0];
  const shelfCollapsed = Boolean(store.shelf.collapsed);
  const rawShelfX = store.shelf.x ?? 320;
  const rawShelfY = store.shelf.y ?? 620;
  const viewportWidth = typeof globalThis.innerWidth === "number" ? globalThis.innerWidth : 1280;
  const viewportHeight = typeof globalThis.innerHeight === "number" ? globalThis.innerHeight : 820;
  const shelfWidth = shelfCollapsed ? 178 : 280;
  const shelfX = clampNumber(rawShelfX, 8, viewportWidth - shelfWidth - 12);
  const shelfY = clampNumber(rawShelfY, 56, viewportHeight - 140);

  useEffect(() => {
    if (shelfX !== rawShelfX || shelfY !== rawShelfY) store.updateShelf({ x: shelfX, y: shelfY });
  }, [rawShelfX, rawShelfY, shelfX, shelfY, store]);

  useEffect(() => {
    if (!shelfDrag) return;
    const currentDrag = shelfDrag;
    function move(event: PointerEvent) {
      if (event.pointerId !== currentDrag.pointerId) return;
      store.updateShelf({
        x: clampNumber(currentDrag.x + event.clientX - currentDrag.startX, 8, globalThis.innerWidth - shelfWidth - 12),
        y: clampNumber(currentDrag.y + event.clientY - currentDrag.startY, 56, globalThis.innerHeight - 140)
      });
    }
    function up(event: PointerEvent) {
      if (event.pointerId !== currentDrag.pointerId) return;
      setShelfDrag(null);
    }
    globalThis.addEventListener("pointermove", move);
    globalThis.addEventListener("pointerup", up);
    globalThis.addEventListener("pointercancel", up);
    return () => {
      globalThis.removeEventListener("pointermove", move);
      globalThis.removeEventListener("pointerup", up);
      globalThis.removeEventListener("pointercancel", up);
    };
  }, [shelfDrag, shelfWidth, store]);

  if (!shelf) return null;
  const shelfId = shelf.id;
  const shelfItems = shelf.items;

  async function addDroppedItems(event: React.DragEvent<HTMLElement>) {
    event.preventDefault();
    setDropActive(false);
    setDropError("");
    const rawItems = event.dataTransfer.getData("application/kago-files");
    const rawItem = event.dataTransfer.getData("application/kago-file");
    try {
      const items = rawItems
        ? JSON.parse(rawItems) as Array<{ rootSlug: string; path: string }>
        : rawItem ? [JSON.parse(rawItem) as { rootSlug: string; path: string }] : [];
      if (items.length === 0) return;
      await Promise.all(
        items.map((item) =>
          api(`/api/shelves/${shelfId}/items`, {
            method: "POST",
            body: JSON.stringify({ rootSlug: item.rootSlug, path: item.path })
          })
        )
      );
      await queryClient.invalidateQueries({ queryKey: ["shelves"] });
    } catch (error) {
      setDropError(error instanceof Error ? error.message : "無法加入中轉區");
    }
  }

  async function createShelfTask(type: "copy" | "move" | "compress", destinationPath: string) {
    if (!active || activeReadonly || shelfItems.length === 0) return;
    await api(`/api/shelves/${shelfId}/tasks`, {
      method: "POST",
      body: JSON.stringify({ type, destination: { rootSlug: active.rootSlug, path: destinationPath } })
    });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function copyToActive() {
    if (!active) return;
    await createShelfTask("copy", active.logicalPath);
  }

  async function moveToActive() {
    if (!active) return;
    await createShelfTask("move", active.logicalPath);
  }

  async function compressToActive() {
    if (!active || activeReadonly || shelfItems.length === 0) return;
    const name = prompt("壓縮檔名稱", "shelf.zip");
    if (!name) return;
    await createShelfTask("compress", joinLogicalPath(active.logicalPath, ensureZipName(name)));
  }

  async function removeShelfItem(itemId: string) {
    await api(`/api/shelves/${shelfId}/items/${itemId}`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["shelves"] });
  }

  return (
    <aside
      className={`floating-shelf ${dropActive ? "drop-active" : ""} ${shelfCollapsed ? "collapsed" : ""}`}
      style={{ left: shelfX, top: shelfY }}
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={(event) => void addDroppedItems(event)}
    >
      <header
        onPointerDown={(event) => {
          if (!isPrimaryPointerStart(event) || isInteractiveTarget(event.target)) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          setShelfDrag({ pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: shelfX, y: shelfY });
        }}
      >
        <Archive /> 中轉區 <span>{shelfItems.length}</span>
        <button
          className="icon-button"
          title={shelfCollapsed ? "展開中轉區" : "收合中轉區"}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => store.updateShelf({ collapsed: !shelfCollapsed })}
        >
          <Minimize2 />
        </button>
      </header>
      {!shelfCollapsed ? (
        <>
          <div className="shelf-items">
            {shelfItems.length === 0 ? (
              <div className="shelf-empty"><span>拖放檔案到這裡</span><small>中轉區只保存 reference，不會立即複製。</small></div>
            ) : null}
            {shelfItems.map((item) => (
              <div
                className="shelf-item"
                key={item.id}
                draggable
                onDragStart={(event) => {
                  const dragItem = { rootSlug: item.root_slug, path: item.path };
                  event.dataTransfer.setData("application/kago-files", JSON.stringify([dragItem]));
                  event.dataTransfer.setData("application/kago-file", JSON.stringify(dragItem));
                }}
              >
                <span>{item.name}</span>
                <small>{item.kind === "folder" ? "資料夾" : "檔案"} · {formatSize(item.size)}</small>
                <small>{item.root_slug}:{item.path}</small>
                <button className="icon-button" title="從中轉區移除" onClick={() => void removeShelfItem(item.id)}><X /></button>
              </div>
            ))}
          </div>
          {dropError ? <small className="readonly-note">{dropError}</small> : null}
          {activeReadonly ? <small className="readonly-note">目前視窗是唯讀目的地</small> : null}
          <button className="tool-button" onClick={copyToActive} disabled={!active || activeReadonly || shelfItems.length === 0}>複製到目前視窗</button>
          <button className="tool-button" onClick={moveToActive} disabled={!active || activeReadonly || shelfItems.length === 0}>搬移到目前視窗</button>
          <button className="tool-button" onClick={compressToActive} disabled={!active || activeReadonly || shelfItems.length === 0}>壓縮到目前視窗</button>
        </>
      ) : null}
    </aside>
  );
}

function TaskCenter() {
  const tasks = useTasks();
  const queryClient = useQueryClient();
  if (!tasks.data?.length) return null;

  async function cancelTask(taskId: string) {
    await api(`/api/tasks/${taskId}/cancel`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function pauseTask(taskId: string) {
    await api(`/api/tasks/${taskId}/pause`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function resumeTask(taskId: string) {
    await api(`/api/tasks/${taskId}/resume`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function retryTask(taskId: string) {
    await api(`/api/tasks/${taskId}/retry`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["fs"] });
  }

  return (
    <aside className="task-center">
      <header><Boxes /> 任務</header>
      <div className="task-list">
        {tasks.data?.slice(0, 6).map((task) => {
          const downloadTarget = completedCompressDownloadTarget(task);
          return (
            <div className="task-item" key={task.id}>
              <strong>{task.type}</strong>
              <span className={`status ${task.status}`}>{task.status}</span>
              <progress value={taskProgressValue(task)} max={taskProgressMax(task)} />
              <small>{taskProgressLabel(task)}</small>
              {task.error_message && <small>{task.error_message}</small>}
              <div className="task-actions">
                {downloadTarget ? (
                  <a className="task-action" href={downloadUrl(downloadTarget.rootSlug, downloadTarget.path)}><Download /> 下載</a>
                ) : null}
                {task.status === "queued" ? (
                  <>
                    <button className="task-action" onClick={() => void pauseTask(task.id)}><Minimize2 /> 暫停</button>
                    <button className="task-action" onClick={() => void cancelTask(task.id)}><X /> 取消</button>
                  </>
                ) : null}
                {task.status === "paused" ? (
                  <>
                    <button className="task-action" onClick={() => void resumeTask(task.id)}><RefreshCw /> 繼續</button>
                    <button className="task-action" onClick={() => void cancelTask(task.id)}><X /> 取消</button>
                  </>
                ) : null}
                {["failed", "cancelled", "interrupted"].includes(task.status) ? (
                  <button className="task-action" onClick={() => void retryTask(task.id)}><RefreshCw /> 重試</button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </aside>
  );
}

function TrashCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const trash = useTrash(open);
  const queryClient = useQueryClient();
  if (!open) return null;

  async function restore(itemId: string) {
    await api(`/api/trash/${itemId}/restore`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["trash"] });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["fs"] });
  }

  return (
    <aside className="trash-center">
      <header>
        <div className="traffic-lights"><span /><span /><span /></div>
        <strong><Trash2 /> 垃圾桶</strong>
        <button className="icon-button" onClick={onClose} title="關閉"><X /></button>
      </header>
      <div className="trash-list">
        {trash.isLoading && <div className="empty-state"><Loader2 className="spin" /> Loading</div>}
        {trash.error && <div className="empty-state error">{trash.error.message}</div>}
        {!trash.isLoading && !trash.data?.length && <div className="empty-state">沒有待還原的項目</div>}
        {trash.data?.map((item) => (
          <div className="trash-item" key={item.id}>
            <FileIcon />
            <div>
              <strong>{item.original_path.split("/").filter(Boolean).at(-1) ?? item.original_path}</strong>
              <span>{item.original_path}</span>
            </div>
            <span>{formatUnixDate(item.deleted_at)}</span>
            <button className="tool-button" onClick={() => void restore(item.id)}><RefreshCw /> 還原</button>
          </div>
        ))}
      </div>
    </aside>
  );
}

function AuditCenter({ open, onClose }: { open: boolean; onClose: () => void }) {
  const audit = useAudit(open);
  if (!open) return null;

  return (
    <aside className="audit-center">
      <header>
        <div className="traffic-lights"><span /><span /><span /></div>
        <strong><SlidersHorizontal /> 稽核紀錄</strong>
        <button className="icon-button" onClick={onClose} title="關閉"><X /></button>
      </header>
      <div className="audit-list">
        {audit.isLoading && <div className="empty-state"><Loader2 className="spin" /> Loading</div>}
        {audit.error && <div className="empty-state error">{audit.error.message}</div>}
        {!audit.isLoading && !audit.data?.length && <div className="empty-state">目前沒有稽核紀錄</div>}
        {audit.data?.map((item) => (
          <div className="audit-item" key={item.id}>
            <span className={`audit-result ${item.result}`}>{item.result}</span>
            <div>
              <strong>{item.action}</strong>
              <span>{item.path ?? summarizeAuditTarget(item.target_json)}</span>
            </div>
            <span>{item.actor_type}</span>
            <time>{formatUnixDate(item.created_at)}</time>
          </div>
        ))}
      </div>
    </aside>
  );
}

function Inspector() {
  const store = useWorkspaceStore();
  const roots = useRoots();
  const users = useUsers();
  const groups = useGroups();
  const queryClient = useQueryClient();
  const activeWindow = store.windows.find((window) => window.id === store.activeWindowId);
  const selectedPath = activeWindow?.selectedItems[0] ?? null;
  const selectedCount = activeWindow?.selectedItems.length ?? 0;
  const meta = useFileMeta(activeWindow?.rootSlug ?? "", selectedPath ?? "/", Boolean(activeWindow && selectedPath));
  const fileTags = useFileTags(activeWindow?.rootSlug ?? "", selectedPath ?? "/", Boolean(activeWindow && selectedPath));
  const shares = useShares();
  const activeRoot = roots.data?.find((root) => root.slug === activeWindow?.rootSlug);
  const selectedShares = (shares.data ?? []).filter((share) => share.root_id === activeRoot?.id && share.path === selectedPath);
  const permissions = usePathPermissions(activeWindow?.rootSlug ?? "", selectedPath ?? "/", Boolean(activeWindow && selectedPath));
  const selectedPermissionRules = permissions.data ?? [];
  const [tagName, setTagName] = useState("");
  const [shareMode, setShareMode] = useState<"download" | "view_only" | "upload_only">("download");
  const [shareUrl, setShareUrl] = useState("");
  const [sharePassword, setSharePassword] = useState("");
  const [shareExpiresDays, setShareExpiresDays] = useState("");
  const [shareMaxDownloads, setShareMaxDownloads] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [userDisplayName, setUserDisplayName] = useState("");
  const [userPassword, setUserPassword] = useState("");
  const [userRole, setUserRole] = useState<"ADMIN" | "USER" | "GUEST">("USER");
  const [groupName, setGroupName] = useState("");
  const [memberGroupId, setMemberGroupId] = useState("");
  const [memberUserId, setMemberUserId] = useState("");
  const [permissionPrincipalType, setPermissionPrincipalType] = useState<"user" | "group">("group");
  const [permissionPrincipalId, setPermissionPrincipalId] = useState("");
  const [permissionRootId, setPermissionRootId] = useState("");
  const [permissionPathPrefix, setPermissionPathPrefix] = useState("/");
  const [inspectorResize, setInspectorResize] = useState<{ startX: number; width: number } | null>(null);
  const inspectorWidth = Math.max(260, Math.min(480, store.inspector.width ?? 320));
  const canCreateUser = Boolean(userEmail && userPassword.length >= 8);

  useEffect(() => {
    if (!inspectorResize) return;
    const currentResize = inspectorResize;
    function move(event: MouseEvent) {
      store.updateInspector({ width: Math.max(260, Math.min(480, currentResize.width + currentResize.startX - event.clientX)) });
    }
    function up() {
      setInspectorResize(null);
    }
    globalThis.addEventListener("mousemove", move);
    globalThis.addEventListener("mouseup", up);
    return () => {
      globalThis.removeEventListener("mousemove", move);
      globalThis.removeEventListener("mouseup", up);
    };
  }, [inspectorResize, store]);

  useEffect(() => {
    if (activeRoot && !permissionRootId) setPermissionRootId(activeRoot.id);
    if (activeWindow && permissionPathPrefix === "/") {
      setPermissionPathPrefix(selectedPath ?? activeWindow.logicalPath);
    }
  }, [activeRoot, activeWindow, permissionPathPrefix, permissionRootId, selectedPath]);

  async function addTag() {
    if (!activeWindow || !selectedPath || !tagName) return;
    const tag = await api<{ id: string }>("/api/tags", { method: "POST", body: JSON.stringify({ name: tagName, color: "#007aff" }) });
    const tagIds = [...new Set([...(fileTags.data ?? []).map((item) => item.id), tag.id])];
    await api("/api/tags/file", {
      method: "PUT",
      body: JSON.stringify({ rootSlug: activeWindow.rootSlug, path: selectedPath, tagIds })
    });
    setTagName("");
    await queryClient.invalidateQueries({ queryKey: ["tags", "file", activeWindow.rootSlug, selectedPath] });
  }

  async function removeTag(tagId: string) {
    if (!activeWindow || !selectedPath) return;
    await api("/api/tags/file", {
      method: "PUT",
      body: JSON.stringify({
        rootSlug: activeWindow.rootSlug,
        path: selectedPath,
        tagIds: (fileTags.data ?? []).filter((tag) => tag.id !== tagId).map((tag) => tag.id)
      })
    });
    await queryClient.invalidateQueries({ queryKey: ["tags", "file", activeWindow.rootSlug, selectedPath] });
  }

  async function createShare() {
    if (!activeWindow || !selectedPath) return;
    const expiresDays = Number(shareExpiresDays);
    const maxDownloads = Number(shareMaxDownloads);
    const body = {
      rootSlug: activeWindow.rootSlug,
      path: selectedPath,
      mode: shareMode,
      ...(sharePassword ? { password: sharePassword } : {}),
      ...(Number.isFinite(expiresDays) && expiresDays > 0 ? { expiresAt: Math.floor(Date.now() / 1000) + expiresDays * 86400 } : {}),
      ...(Number.isFinite(maxDownloads) && maxDownloads > 0 ? { maxDownloads } : {})
    };
    const share = await api<{ token: string }>("/api/shares", {
      method: "POST",
      body: JSON.stringify(body)
    });
    setShareUrl(`${location.origin}/s/${share.token}`);
    setSharePassword("");
    setShareExpiresDays("");
    setShareMaxDownloads("");
    await queryClient.invalidateQueries({ queryKey: ["shares"] });
  }

  const sharePasswordInvalid = Boolean(sharePassword && sharePassword.length < 8);

  async function setShareDisabled(shareId: string, disabled: boolean) {
    await api(`/api/shares/${shareId}`, { method: "PATCH", body: JSON.stringify({ disabled }) });
    await queryClient.invalidateQueries({ queryKey: ["shares"] });
  }

  async function deleteShare(shareId: string) {
    await api(`/api/shares/${shareId}`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["shares"] });
  }

  async function createUser() {
    if (!canCreateUser) return;
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({
        email: userEmail,
        password: userPassword,
        displayName: userDisplayName || userEmail.split("@")[0],
        role: userRole
      })
    });
    setUserEmail("");
    setUserDisplayName("");
    setUserPassword("");
    setUserRole("USER");
    await queryClient.invalidateQueries({ queryKey: ["users"] });
  }

  async function createGroup() {
    if (!groupName) return;
    await api("/api/groups", { method: "POST", body: JSON.stringify({ name: groupName }) });
    setGroupName("");
    await queryClient.invalidateQueries({ queryKey: ["groups"] });
  }

  async function addGroupMember() {
    if (!memberGroupId || !memberUserId) return;
    await api(`/api/groups/${memberGroupId}/members`, {
      method: "POST",
      body: JSON.stringify({ userId: memberUserId })
    });
    setMemberUserId("");
  }

  async function grantReadPermission() {
    if (!permissionPrincipalId || !permissionRootId || !permissionPathPrefix) return;
    await api("/api/permissions", {
      method: "POST",
      body: JSON.stringify({
        principalType: permissionPrincipalType,
        principalId: permissionPrincipalId,
        rootId: permissionRootId,
        pathPrefix: permissionPathPrefix,
        allow: ["list", "read", "download"],
        deny: [],
        recursive: true
      })
    });
    await queryClient.invalidateQueries({ queryKey: ["roots"] });
    await queryClient.invalidateQueries({ queryKey: ["permissions"] });
  }

  async function deletePermissionRule(ruleId: string) {
    await api(`/api/permissions/${ruleId}`, { method: "DELETE" });
    await queryClient.invalidateQueries({ queryKey: ["permissions"] });
  }

  return (
    <aside className="inspector" style={{ width: inspectorWidth }}>
      <div
        className="inspector-resize-handle"
        onMouseDown={(event) => setInspectorResize({ startX: event.clientX, width: inspectorWidth })}
      />
      <header>
        <Search /> 檢閱器
        <button className="icon-button" title="關閉檢閱器" onClick={() => store.updateInspector({ open: false })}><X /></button>
      </header>
      <section className="inspector-card inspector-summary">
        <h3>Preview</h3>
        {meta.isLoading ? <div className="inspector-preview"><Loader2 className="spin" /></div> : null}
        {meta.error ? <div className="inline-error">{meta.error.message}</div> : null}
        {meta.data && (
          <>
            <div className="inspector-preview">
              {meta.data.kind === "file" && meta.data.type.startsWith("image/") ? (
                <img alt="" src={previewUrl(meta.data.rootSlug, meta.data.path)} />
              ) : meta.data.kind === "folder" ? (
                <FolderOpen />
              ) : (
                <FileText />
              )}
            </div>
            <strong>{meta.data.name}</strong>
            <p>{meta.data.rootSlug}:{meta.data.path}</p>
            <dl className="meta-grid">
              <dt>種類</dt><dd>{meta.data.kind === "folder" ? "資料夾" : meta.data.type}</dd>
              <dt>大小</dt><dd>{formatSize(meta.data.size)}</dd>
              <dt>修改時間</dt><dd>{formatDate(meta.data.mtime)}</dd>
              <dt>選取數</dt><dd>{selectedCount}</dd>
            </dl>
          </>
        )}
        {!selectedPath ? <p>選取檔案後可檢視標籤、權限、分享狀態與預覽資訊。</p> : null}
      </section>
      <section className="inspector-card">
        <h3>標籤</h3>
        <div className="tag-list">
          {fileTags.isLoading ? <span className="tag-empty">讀取標籤...</span> : null}
          {!fileTags.isLoading && !fileTags.data?.length ? <span className="tag-empty">尚未套用標籤</span> : null}
          {fileTags.data?.map((tag) => (
            <button key={tag.id} className="tag-chip" onClick={() => void removeTag(tag.id)} title="移除此標籤">
              <Circle style={{ color: tag.color ?? "#007aff" }} />
              {tag.name}
              <X />
            </button>
          ))}
        </div>
        <div className="inline-form">
          <input placeholder="標籤名稱" value={tagName} onChange={(event) => setTagName(event.target.value)} />
          <button className="tool-button" onClick={addTag} disabled={!selectedPath || !tagName.trim()}><Tags /> 套用</button>
        </div>
      </section>
      <section className="inspector-card">
        <h3>分享</h3>
        <div className="share-status-list">
          {shares.isLoading ? <span className="tag-empty">讀取分享狀態...</span> : null}
          {!shares.isLoading && selectedPath && selectedShares.length === 0 ? <span className="tag-empty">此項目尚未建立分享</span> : null}
          {selectedShares.map((share) => (
            <div className="share-status-item" key={share.id}>
              <div>
                <strong>{shareModeLabel(parseShareMode(share.permission_json))}</strong>
                <small>
                  {share.disabled ? "已停用" : "啟用中"} · {share.has_password ? "有密碼 · " : ""}{share.download_count}{share.max_downloads ? `/${share.max_downloads}` : ""} 次下載
                </small>
                {share.expires_at ? <small>到期於 {formatUnixDate(share.expires_at)}</small> : null}
                <small>建立於 {formatUnixDate(share.created_at)}</small>
              </div>
              <div className="share-status-actions">
                <button className="task-action" onClick={() => void setShareDisabled(share.id, !share.disabled)}>
                  {share.disabled ? "啟用" : "停用"}
                </button>
                <button className="task-action danger" onClick={() => void deleteShare(share.id)}>刪除</button>
              </div>
            </div>
          ))}
        </div>
        <div className="inline-form">
          <select value={shareMode} onChange={(event) => setShareMode(event.target.value as "download" | "view_only" | "upload_only")}>
            <option value="download">下載</option>
            <option value="view_only">檢視</option>
            <option value="upload_only">只允許上傳</option>
          </select>
          <button className="tool-button" onClick={createShare} disabled={!selectedPath || sharePasswordInvalid}><Share2 /> 建立</button>
        </div>
        <div className="share-options-grid">
          <input
            type="password"
            placeholder="密碼（至少 8 字）"
            value={sharePassword}
            onChange={(event) => setSharePassword(event.target.value)}
          />
          <input
            type="number"
            min="1"
            placeholder="有效天數"
            value={shareExpiresDays}
            onChange={(event) => setShareExpiresDays(event.target.value)}
          />
          <input
            type="number"
            min="1"
            placeholder="下載上限"
            value={shareMaxDownloads}
            onChange={(event) => setShareMaxDownloads(event.target.value)}
          />
        </div>
        {shareUrl && <input readOnly value={shareUrl} />}
      </section>
      <section className="inspector-card">
        <h3>管理</h3>
        <div className="share-options-grid">
          <input type="email" placeholder="使用者 email" value={userEmail} onChange={(event) => setUserEmail(event.target.value)} />
          <input placeholder="顯示名稱" value={userDisplayName} onChange={(event) => setUserDisplayName(event.target.value)} />
          <input type="password" placeholder="初始密碼（至少 8 字）" value={userPassword} onChange={(event) => setUserPassword(event.target.value)} />
          <select value={userRole} onChange={(event) => setUserRole(event.target.value as "ADMIN" | "USER" | "GUEST")}>
            <option value="USER">USER</option>
            <option value="GUEST">GUEST</option>
            <option value="ADMIN">ADMIN</option>
          </select>
          <button className="tool-button" onClick={createUser} disabled={!canCreateUser}>新增使用者</button>
        </div>
        <div className="inline-form">
          <input placeholder="群組名稱" value={groupName} onChange={(event) => setGroupName(event.target.value)} />
          <button className="tool-button" onClick={createGroup}>新增群組</button>
        </div>
        <div className="inline-form">
          <select value={memberGroupId} onChange={(event) => setMemberGroupId(event.target.value)}>
            <option value="">群組</option>
            {groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
          </select>
          <select value={memberUserId} onChange={(event) => setMemberUserId(event.target.value)}>
            <option value="">使用者</option>
            {users.data?.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
          </select>
          <button className="tool-button" onClick={addGroupMember} disabled={!memberGroupId || !memberUserId}>加入群組</button>
        </div>
        {users.error || groups.error ? <span className="tag-empty">需要管理員權限才能管理使用者與群組</span> : null}
      </section>
      <section className="inspector-card">
        <h3>權限</h3>
        <div className="permission-rule-list">
          {permissions.isLoading ? <span className="tag-empty">讀取權限規則...</span> : null}
          {permissions.error ? <span className="tag-empty">需要管理員權限才能檢視規則</span> : null}
          {!permissions.isLoading && !permissions.error && selectedPermissionRules.length === 0 ? <span className="tag-empty">目前路徑沒有明確規則</span> : null}
          {selectedPermissionRules.map((rule) => {
            const allow = parseJsonArray(rule.allow_json);
            const deny = parseJsonArray(rule.deny_json);
            return (
              <div className="permission-rule-item" key={rule.id}>
                <div>
                  <strong>{rule.principal_type}:{rule.principal_id}</strong>
                  <small>{rule.path_prefix}{rule.recursive ? "/*" : ""}</small>
                  <div className="permission-badges">
                    {allow.map((item) => <span className="allow" key={`allow-${rule.id}-${item}`}>{item}</span>)}
                    {deny.map((item) => <span className="deny" key={`deny-${rule.id}-${item}`}>{item}</span>)}
                  </div>
                </div>
                <button className="task-action" onClick={() => void deletePermissionRule(rule.id)}>刪除</button>
              </div>
            );
          })}
        </div>
        <div className="share-options-grid">
          <select
            value={permissionPrincipalType}
            onChange={(event) => {
              const type = event.target.value as "user" | "group";
              setPermissionPrincipalType(type);
              setPermissionPrincipalId("");
            }}
          >
            <option value="group">群組</option>
            <option value="user">使用者</option>
          </select>
          <select value={permissionPrincipalId} onChange={(event) => setPermissionPrincipalId(event.target.value)}>
            <option value="">Principal</option>
            {permissionPrincipalType === "group"
              ? groups.data?.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)
              : users.data?.map((user) => <option key={user.id} value={user.id}>{user.email}</option>)}
          </select>
          <select value={permissionRootId} onChange={(event) => setPermissionRootId(event.target.value)}>
            <option value="">Root</option>
            {roots.data?.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
          </select>
          <input placeholder="/public" value={permissionPathPrefix} onChange={(event) => setPermissionPathPrefix(normalizePermissionInput(event.target.value))} />
          <button className="tool-button" onClick={grantReadPermission} disabled={!permissionPrincipalId || !permissionRootId || !permissionPathPrefix}>授予讀取</button>
        </div>
      </section>
    </aside>
  );
}

function parentPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function normalizeAddressInput(value: string, rootSlug: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/");
  const withoutRoot = trimmed.startsWith(`${rootSlug}:`) ? trimmed.slice(rootSlug.length + 1).trim() : trimmed;
  if (!withoutRoot || withoutRoot === "/") return "/";
  if (withoutRoot.includes("\0")) return null;
  const clean = withoutRoot.startsWith("/") ? withoutRoot : `/${withoutRoot}`;
  if (clean === "/data" || clean.startsWith("/data/")) return null;
  const parts = clean.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) return null;
  const normalized = parts.filter((part) => part !== ".").join("/");
  return normalized ? `/${normalized}` : "/";
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("button, a, input, textarea, select, label"));
}

function isPrimaryPointerStart(event: React.PointerEvent<HTMLElement>): boolean {
  return event.isPrimary && event.button === 0;
}

function localPointerPoint(event: React.PointerEvent<HTMLElement>, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return {
    x: event.clientX - rect.left + element.scrollLeft,
    y: event.clientY - rect.top + element.scrollTop
  };
}

function selectionMarqueeStyle(drag: SelectionDragState) {
  const bounds = selectionBounds(drag);
  return {
    left: bounds.left,
    top: bounds.top,
    width: bounds.right - bounds.left,
    height: bounds.bottom - bounds.top
  };
}

function pathsIntersectingSelection(container: HTMLElement, drag: SelectionDragState): string[] {
  const bounds = selectionBounds(drag);
  const containerRect = container.getBoundingClientRect();
  const rows = Array.from(container.querySelectorAll<HTMLElement>(".file-row[data-file-path]"));
  return rows
    .filter((row) => {
      const rowRect = row.getBoundingClientRect();
      const localRow = {
        left: rowRect.left - containerRect.left + container.scrollLeft,
        right: rowRect.right - containerRect.left + container.scrollLeft,
        top: rowRect.top - containerRect.top + container.scrollTop,
        bottom: rowRect.bottom - containerRect.top + container.scrollTop
      };
      return rectanglesIntersect(bounds, localRow);
    })
    .map((row) => row.dataset.filePath)
    .filter((path): path is string => Boolean(path));
}

function selectionBounds(drag: SelectionDragState) {
  return {
    left: Math.min(drag.startX, drag.currentX),
    right: Math.max(drag.startX, drag.currentX),
    top: Math.min(drag.startY, drag.currentY),
    bottom: Math.max(drag.startY, drag.currentY)
  };
}

function rectanglesIntersect(
  a: { left: number; right: number; top: number; bottom: number },
  b: { left: number; right: number; top: number; bottom: number }
) {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

function joinLogicalPath(parent: string, name: string) {
  const cleanName = name.replaceAll("\\", "-").replaceAll("/", "-").replaceAll("\0", "");
  const base = parent === "/" ? "" : parent;
  return `${base}/${cleanName}`;
}

function clampNumber(value: number, min: number, max: number) {
  const upper = Math.max(min, max);
  return Math.min(upper, Math.max(min, value));
}

function normalizePermissionInput(value: string) {
  const trimmed = value.trim().replaceAll("\\", "/");
  if (!trimmed || trimmed === "/") return "/";
  const clean = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const parts = clean.split("/").filter(Boolean).filter((part) => part !== "." && part !== "..");
  return parts.length ? `/${parts.join("/")}` : "/";
}

function ensureZipName(value: string) {
  const trimmed = value.trim() || "archive";
  return trimmed.toLowerCase().endsWith(".zip") ? trimmed : `${trimmed}.zip`;
}

function defaultSortDirection(sortBy: FileWindow["sortBy"]): FileWindow["sortDirection"] {
  return sortBy === "size" || sortBy === "mtime" ? "desc" : "asc";
}

function nextViewMode(mode: FileWindow["viewMode"]): FileWindow["viewMode"] {
  if (mode === "list") return "grid";
  if (mode === "grid") return "columns";
  return "list";
}

function taskProgressValue(task: { processed_files: number; processed_bytes: number; total_bytes: number }) {
  return task.total_bytes > 0 ? task.processed_bytes : task.processed_files;
}

function taskProgressMax(task: { total_files: number; total_bytes: number }) {
  return Math.max(task.total_bytes > 0 ? task.total_bytes : task.total_files, 1);
}

function taskProgressLabel(task: { processed_files: number; total_files: number; processed_bytes: number; total_bytes: number }) {
  if (task.total_bytes > 0) {
    return `${formatSize(task.processed_bytes)} / ${formatSize(task.total_bytes)} · ${task.processed_files}/${Math.max(task.total_files, 1)} 項`;
  }
  return `${task.processed_files}/${Math.max(task.total_files, 1)} 項`;
}

function completedCompressDownloadTarget(task: FileTask): { rootSlug: string; path: string } | null {
  if (task.type !== "compress" || task.status !== "done" || !task.destination) return null;
  try {
    const destination = JSON.parse(task.destination) as unknown;
    if (!isRecord(destination)) return null;
    const rootSlug = destination.rootSlug;
    const path = destination.path;
    if (typeof rootSlug !== "string" || typeof path !== "string" || !rootSlug || !path) return null;
    return { rootSlug, path };
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function formatDate(mtime: number) {
  return new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
    new Date(mtime)
  );
}

function formatUnixDate(value: number) {
  return new Intl.DateTimeFormat("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(
    new Date(value * 1000)
  );
}

function parseShareMode(value: string): "download" | "view_only" | "upload_only" {
  try {
    const parsed = JSON.parse(value) as { mode?: unknown };
    if (parsed.mode === "download" || parsed.mode === "view_only" || parsed.mode === "upload_only") return parsed.mode;
  } catch {
    return "download";
  }
  return "download";
}

function shareModeLabel(mode: "download" | "view_only" | "upload_only") {
  if (mode === "view_only") return "檢視";
  if (mode === "upload_only") return "只允許上傳";
  return "下載";
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function summarizeAuditTarget(value: string | null) {
  if (!value) return "—";
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const first = Object.entries(parsed)[0];
    if (!first) return "—";
    return `${first[0]}: ${String(first[1])}`;
  } catch {
    return value;
  }
}

function viewModeLabel(mode: FileWindow["viewMode"]) {
  if (mode === "grid") return "圖像";
  if (mode === "columns") return "直欄";
  return "列表";
}

type FileWindowErrorState = {
  kind: "root_missing" | "path_missing" | "forbidden";
  title: string;
  message: string;
};

function classifyFileWindowError(error: unknown): FileWindowErrorState | null {
  if (!(error instanceof ApiError)) return null;
  if (error.code === "ROOT_NOT_FOUND") {
    return {
      kind: "root_missing",
      title: "Root not found",
      message: "這個視窗原本指向的 Root 已不存在。"
    };
  }
  if (error.code === "PATH_NOT_FOUND") {
    return {
      kind: "path_missing",
      title: "Folder not found",
      message: "原本的資料夾路徑已失效，你可以回到 Root 或直接關閉視窗。"
    };
  }
  if (error.code === "FORBIDDEN") {
    return {
      kind: "forbidden",
      title: "Forbidden",
      message: "你目前沒有權限開啟這個位置，已隱藏舊的選取與快取內容。"
    };
  }
  return null;
}
