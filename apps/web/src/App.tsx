import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppWindow, Archive, Boxes, Check, ChevronDown, ChevronLeft, ChevronRight, Circle, CirclePlus, Columns3, Download, FileText, Folder, FolderOpen, Globe2, HardDrive, HelpCircle, Home, LayoutGrid, List, Loader2, LogOut, Maximize2, MessageCircle, Minimize2, MoreHorizontal, PanelRight, Pencil, Plus, Radio, RefreshCw, Search, Server, Settings2, Share2, SlidersHorizontal, Smartphone, Star, Tags, Trash2, Upload, UserRound, X } from "lucide-react";
import { api, downloadUrl, thumbnailUrl } from "./api/client";
import { useAudit, useFileList, useMe, useRoots, useSaveWorkspace, useShelves, useTasks, useTrash, useWorkspace } from "./api/hooks";
import { useWorkspaceStore } from "./stores/workspace";
import type { FileItem, FileWindow, Root } from "./types/kago";

export function App() {
  const shareToken = publicShareToken();
  if (shareToken) return <PublicSharePage token={shareToken} />;

  const me = useMe();

  if (me.isLoading) return <ShellLoading />;
  if (!me.data?.user) return <Login />;
  return <Workspace userEmail={me.data.user.email} />;
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
          <h1>{share ? share.path.split("/").filter(Boolean).at(-1) ?? share.rootSlug : "分享連結"}</h1>
          {share && <p>{share.rootSlug}:{share.path}</p>}
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
              {(share.mode === "download" || share.mode === "view_only") && (
                <a className="primary-button" href={`/s/${token}/download`}>
                  <Download />
                  下載
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

function Login() {
  const [email, setEmail] = useState("admin@kago.local");
  const [password, setPassword] = useState("admin123");
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
          <input value={email} onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} />
        </label>
        {error && <div className="inline-error">{error}</div>}
        <button className="primary-button" disabled={busy}>
          {busy ? <Loader2 className="spin" /> : <Check />}
          Sign in
        </button>
      </form>
    </main>
  );
}

function publicShareToken(): string | null {
  const match = globalThis.location?.pathname.match(/^\/s\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]!) : null;
}

type PublicShareInfo = {
  id: string;
  mode: "view_only" | "download" | "upload_only";
  path: string;
  rootSlug: string;
  requiresPassword: boolean;
  authenticated: boolean;
};

function Workspace({ userEmail }: { userEmail: string }) {
  const workspaceQuery = useWorkspace();
  const roots = useRoots();
  const saveWorkspace = useSaveWorkspace();
  const store = useWorkspaceStore();
  const queryClient = useQueryClient();
  const saveTimer = useRef<number | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [auditOpen, setAuditOpen] = useState(false);

  useEffect(() => {
    if (workspaceQuery.data && !store.hydrated) store.hydrate(workspaceQuery.data);
  }, [workspaceQuery.data, store]);

  useEffect(() => {
    if (!store.hydrated) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveWorkspace.mutate(store.snapshot());
    }, 700);
  }, [store.windows, store.activeWindowId, store.sidebar, store.inspector, store.shelf]);

  useEffect(() => {
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${protocol}://${location.host}/ws`);
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (String(message.type).startsWith("task.")) {
        void queryClient.invalidateQueries({ queryKey: ["tasks"] });
        if (message.type === "task.done") void queryClient.invalidateQueries({ queryKey: ["fs"] });
      }
      if (message.type === "shelf.updated") void queryClient.invalidateQueries({ queryKey: ["shelves"] });
    };
    return () => ws.close();
  }, [queryClient]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const active = store.windows.find((window) => window.id === store.activeWindowId);
      if (!active) return;
      if (isEditableTarget(event.target) && event.key !== "Escape") return;
      const mod = event.metaKey || event.ctrlKey;
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
        } else if (row.dataset.downloadUrl) {
          globalThis.open(row.dataset.downloadUrl, "_blank");
        }
      }
      if (event.key === "Escape") store.selectItems(active.id, []);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [queryClient, store]);

  if (workspaceQuery.isLoading || roots.isLoading) return <ShellLoading />;

  const rootList = roots.data ?? [];
  const activeWindow = store.windows.find((window) => window.id === store.activeWindowId);
  const showInspector = Boolean(activeWindow?.selectedItems.length);

  return (
    <main className="app-shell">
      <DesktopTopBar userEmail={userEmail} onOpenAudit={() => setAuditOpen(true)} />
      <DesktopIcons roots={rootList} onOpenTrash={() => setTrashOpen(true)} onOpenAudit={() => setAuditOpen(true)} />
      <section className={`desktop-window desktop-window-background ${showInspector ? "inspector-visible" : ""}`}>
        <Sidebar roots={rootList} userEmail={userEmail} onOpenTrash={() => setTrashOpen(true)} onOpenAudit={() => setAuditOpen(true)} />
        <section className="workspace-canvas">
          <TopStrip />
          {store.windows.length === 0 ? <RootPicker roots={rootList} /> : null}
          {store.windows.map((window) => (
            <FileWindowView key={window.id} window={window} />
          ))}
          <FloatingShelf />
          <TaskCenter />
          <TrashCenter open={trashOpen} onClose={() => setTrashOpen(false)} />
          <AuditCenter open={auditOpen} onClose={() => setAuditOpen(false)} />
        </section>
        {showInspector ? <Inspector /> : null}
      </section>
    </main>
  );
}

function DesktopTopBar({ userEmail, onOpenAudit }: { userEmail: string; onOpenAudit: () => void }) {
  return (
    <header className="desktop-topbar">
      <div className="desktop-launcher">
        <button title="主選單"><LayoutGrid /></button>
        <button title="File Station"><FolderOpen /></button>
        <button title="套件中心"><Boxes /></button>
      </div>
      <div className="desktop-status">
        <button title="通知"><MessageCircle /></button>
        <button title={userEmail}><UserRound /></button>
        <button title="稽核紀錄" onClick={onOpenAudit}><SlidersHorizontal /></button>
        <button title="搜尋"><Search /></button>
      </div>
    </header>
  );
}

function DesktopIcons({ roots, onOpenTrash, onOpenAudit }: { roots: Root[]; onOpenTrash: () => void; onOpenAudit: () => void }) {
  const store = useWorkspaceStore();
  const firstRoot = roots[0];
  const iconItems = [
    { label: "套件中心", icon: <Boxes />, action: undefined },
    { label: "稽核紀錄", icon: <SlidersHorizontal />, action: onOpenAudit },
    { label: "File Station", icon: <FolderOpen />, action: firstRoot ? () => store.openRoot(firstRoot) : undefined },
    { label: "垃圾桶", icon: <Trash2 />, action: onOpenTrash },
    { label: "DSM 說明", icon: <HelpCircle />, action: undefined }
  ];

  return (
    <nav className="desktop-icons" aria-label="NAS desktop apps">
      {iconItems.map((item) => (
        <button key={item.label} onClick={item.action}>
          <span className="desktop-icon-tile">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </nav>
  );
}

function Sidebar({ roots, userEmail, onOpenTrash, onOpenAudit }: { roots: Root[]; userEmail: string; onOpenTrash: () => void; onOpenAudit: () => void }) {
  const store = useWorkspaceStore();
  const queryClient = useQueryClient();
  const [rootName, setRootName] = useState("");
  const [rootSlug, setRootSlug] = useState("");

  async function logout() {
    await api("/api/auth/logout", { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["auth", "me"] });
  }

  async function createRoot() {
    if (!rootSlug) return;
    await api("/api/roots", {
      method: "POST",
      body: JSON.stringify({ slug: rootSlug, name: rootName || rootSlug, basePath: `/data/${rootSlug}`, readonly: false })
    });
    setRootName("");
    setRootSlug("");
    await queryClient.invalidateQueries({ queryKey: ["roots"] });
  }

  return (
    <aside className="sidebar">
      <div className="brand-row compact">
        <div className="brand-mark">K</div>
        <strong>Kago</strong>
      </div>
      <nav className="side-nav">
        <button className="side-item active"><RefreshCw /> 最近項目</button>
        <button className="side-item"><Share2 /> 已共享</button>
        <span className="side-section">喜好項目</span>
        <button className="side-item"><LayoutGrid /> 應用程式</button>
        <button className="side-item"><PanelRight /> 桌面</button>
        <button className="side-item"><FileText /> 文件</button>
        <button className="side-item"><Download /> 下載項目</button>
        <button className="side-item"><Folder /> Repos</button>
        <span className="side-section">位置</span>
        <button className="side-item"><Home /> {userEmail.split("@")[0]}</button>
        <button className="side-item"><Smartphone /> NAS 掛載點</button>
        <button className="side-item"><Server /> Kago Roots</button>
        <button className="side-item" onClick={onOpenAudit}><SlidersHorizontal /> 稽核紀錄</button>
        <button className="side-item"><Radio /> AirDrop</button>
        <button className="side-item"><Globe2 /> 網路</button>
        <button className="side-item" onClick={onOpenTrash}><Trash2 /> 垃圾桶</button>
        <span className="side-section">標籤</span>
        <button className="side-item"><Circle className="tag-dot gray" /> 已觀看</button>
        <button className="side-item"><Circle className="tag-dot red" /> 可刪除</button>
        <button className="side-item"><Circle className="tag-dot blue" /> 好看</button>
      </nav>
      <div className="root-list">
        <span className="side-section">Kago</span>
        {roots.map((root) => (
          <button key={root.id} className="root-button" onClick={() => store.openRoot(root)}>
            <FolderOpen />
            <span>{root.name}</span>
            {root.readonly ? <span className="badge">RO</span> : null}
          </button>
        ))}
      </div>
      <div className="mini-form">
        <input placeholder="root slug" value={rootSlug} onChange={(event) => setRootSlug(event.target.value)} />
        <input placeholder="name" value={rootName} onChange={(event) => setRootName(event.target.value)} />
        <button onClick={createRoot}><Plus /> Root</button>
      </div>
      <div className="sidebar-footer">
        <span>{userEmail}</span>
        <button className="icon-button" onClick={logout} title="Logout"><LogOut /></button>
      </div>
    </aside>
  );
}

function TopStrip() {
  const store = useWorkspaceStore();
  const active = store.windows.find((window) => window.id === store.activeWindowId);
  return (
    <header className="top-strip">
      <div className="finder-nav">
        <button className="chrome-button"><ChevronLeft /></button>
        <button className="chrome-button" disabled><ChevronRight /></button>
        <strong>{active ? active.title : "Kago"}</strong>
      </div>
      {active ? (
        <>
          <div className="view-segment" aria-label="View mode">
            <button className={active.viewMode === "grid" ? "selected" : ""} onClick={() => store.updateWindow(active.id, { viewMode: "grid" })}><LayoutGrid /></button>
            <button className={active.viewMode === "list" ? "selected" : ""} onClick={() => store.updateWindow(active.id, { viewMode: "list" })}><List /></button>
            <button className={active.viewMode === "columns" ? "selected" : ""} onClick={() => store.updateWindow(active.id, { viewMode: "columns" })}><Columns3 /></button>
          </div>
          <div className="toolbar-cluster">
            <button className="chrome-button"><Boxes /><ChevronDown /></button>
            <button className="chrome-button"><Share2 /></button>
            <button className="chrome-button"><Tags /></button>
            <button className="chrome-button"><MoreHorizontal /></button>
          </div>
          <div className="top-actions">
            <label className="search-pill"><Search /><input placeholder="搜尋" /></label>
            <button className="chrome-button" title="New window" onClick={() => store.openWindow({ rootSlug: active.rootSlug, logicalPath: active.logicalPath, title: active.title })}><CirclePlus /></button>
          </div>
        </>
      ) : null}
    </header>
  );
}

function RootPicker({ roots }: { roots: Root[] }) {
  const store = useWorkspaceStore();
  return (
    <section className="root-picker">
      <div className="root-picker-inner">
        <div className="root-picker-mark"><HardDrive /></div>
        <h2>選擇一個 Root</h2>
        <p>從左側建立或開啟 NAS 掛載點，檔案視窗會以 Finder 風格浮在桌面上。</p>
        <div className="picker-grid">
          {roots.map((root) => (
            <button key={root.id} onClick={() => store.openRoot(root)}>
              <FolderOpen />
              <span>{root.name}</span>
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function FileWindowView({ window }: { window: FileWindow }) {
  const store = useWorkspaceStore();
  const queryClient = useQueryClient();
  const fileList = useFileList(window.rootSlug, window.logicalPath);
  const readonly = Boolean(fileList.data?.readonly);
  const [drag, setDrag] = useState<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const [resize, setResize] = useState<{ startX: number; startY: number; width: number; height: number } | null>(null);
  const [dropChoice, setDropChoice] = useState<{ items: Array<{ rootSlug: string; path: string }> } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ item: FileItem; x: number; y: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [lastSelectedPath, setLastSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    function move(event: MouseEvent) {
      if (drag) {
        store.updateWindow(window.id, {
          x: Math.max(-window.width + 120, drag.x + event.clientX - drag.startX),
          y: Math.max(0, drag.y + event.clientY - drag.startY)
        });
      }
      if (resize) {
        store.updateWindow(window.id, {
          width: Math.max(360, resize.width + event.clientX - resize.startX),
          height: Math.max(280, resize.height + event.clientY - resize.startY)
        });
      }
    }
    function up() {
      setDrag(null);
      setResize(null);
    }
    globalThis.addEventListener("mousemove", move);
    globalThis.addEventListener("mouseup", up);
    return () => {
      globalThis.removeEventListener("mousemove", move);
      globalThis.removeEventListener("mouseup", up);
    };
  }, [drag, resize, store, window.id, window.width]);

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
    await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: window.logicalPath, name }) });
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
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
    await api("/api/fs/upload", { method: "POST", body: form });
    event.target.value = "";
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
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
    globalThis.open(downloadUrl(window.rootSlug, item.path), "_blank");
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
        onMouseDown={(event) => setDrag({ startX: event.clientX, startY: event.clientY, x: window.x, y: window.y })}
        onDoubleClick={() => store.updateWindow(window.id, { maximized: !window.maximized })}
      >
        <div className="traffic-lights"><span /><span /><span /></div>
        <Folder className="title-folder" />
        <strong>File Station</strong>
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
              <MiniFinderSidebar activeLabel={window.title} rootSlug={window.rootSlug} />
            </aside>
            <div className="window-content">
              <div className="file-station-toolbar">
                <div className="address-row">
                  <div className="nav-cluster">
                    <button className="icon-button" disabled={window.logicalPath === "/"} onClick={() => store.updateWindow(window.id, { logicalPath: parentPath(window.logicalPath), selectedItems: [] })}><ChevronLeft /></button>
                    <button className="icon-button" disabled><ChevronRight /></button>
                    <button className="icon-button" onClick={() => void queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] })}><RefreshCw /></button>
                  </div>
                  <div className="address-field" tabIndex={0} data-address-target>
                    <Breadcrumb window={window} />
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
                  <button className="tool-button" onClick={mkdir} disabled={readonly}><Folder /> 建立 <ChevronDown /></button>
                  <label className={`tool-button file-input ${readonly ? "disabled" : ""}`} aria-disabled={readonly}>
                    <Upload /> 上傳 <ChevronDown /><input type="file" multiple onChange={upload} disabled={readonly} />
                  </label>
                  <button className="tool-button"><MoreHorizontal /> 操作 <ChevronDown /></button>
                  {window.selectedItems.length > 0 ? (
                    <>
                      <button className="tool-button" onClick={() => void compressSelection()} disabled={readonly}><Archive /> 壓縮</button>
                      <button className="tool-button" onClick={() => void extractSelection()} disabled={readonly}><FolderOpen /> 解壓縮</button>
                    </>
                  ) : null}
                  <button className="tool-button"><Settings2 /> 工具 <ChevronDown /></button>
                  <div className="window-view-tools">
                    <button className={window.viewMode === "list" ? "selected" : ""} onClick={() => store.updateWindow(window.id, { viewMode: "list" })}><List /></button>
                    <button className={window.viewMode === "grid" ? "selected" : ""} onClick={() => store.updateWindow(window.id, { viewMode: "grid" })}><LayoutGrid /></button>
                    <button className={window.viewMode === "columns" ? "selected" : ""} onClick={() => store.updateWindow(window.id, { viewMode: "columns" })}><Columns3 /></button>
                  </div>
                </div>
              </div>
              <div className={`file-list ${window.viewMode}`}>
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
                {fileList.error && <div className="empty-state error">{fileList.error.message}</div>}
                {!fileList.isLoading && fileList.data && visibleItems.length === 0 && (
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
                {visibleItems.map((item) => (
                  <FileRow
                    key={item.path}
                    item={item}
                    window={window}
                    readonly={readonly}
                    onOpenContext={openContextMenu}
                    onSelect={selectItem}
                  />
                ))}
              </div>
              <div className="statusbar">
                <span className="pathbar"><HardDrive /> {window.rootSlug} <ChevronRight /> {window.logicalPath === "/" ? window.title : window.logicalPath.split("/").filter(Boolean).join(" › ")}</span>
                <span>{searchQuery ? `${visibleItems.length} / ${sortedItems.length} 個項目` : `${sortedItems.length} 個項目`}</span>
                <button onClick={() => store.updateWindow(window.id, { viewMode: window.viewMode === "list" ? "grid" : "list" })}><List /> {viewModeLabel(window.viewMode)}</button>
              </div>
            </div>
            <aside className="window-preview-pane">
              <div className="preview-empty">
                <AppWindow />
                <strong>預覽</strong>
                <span>選取檔案後顯示詳細資訊</span>
              </div>
            </aside>
          </div>
          <div className="resize-handle" onMouseDown={(event) => setResize({ startX: event.clientX, startY: event.clientY, width: window.width, height: window.height })} />
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
            {contextMenu.item.kind === "folder" ? <FolderOpen /> : <Download />} 開啟
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
    </section>
  );
}

function MiniFinderSidebar({ activeLabel, rootSlug }: { activeLabel: string; rootSlug: string }) {
  return (
    <nav className="window-side-nav">
      <button className="tree-root"><Server /> gnehsNAS</button>
      <button className="tree-child selected"><ChevronRight /> <Folder /> {rootSlug || activeLabel || "data"}</button>
      <button className="tree-child"><ChevronRight /> <Folder /> docker</button>
      <button className="tree-child"><ChevronRight /> <Folder /> download</button>
      <button className="tree-child"><ChevronRight /> <Folder /> home</button>
      <button className="tree-child"><ChevronRight /> <Folder /> photo</button>
      <button className="tree-child"><ChevronRight /> <Folder /> video</button>
      <span>遠端資料夾</span>
      <button className="tree-child muted"><ChevronRight /> <Folder /> media</button>
      <button className="tree-child muted"><ChevronRight /> <Folder /> photos</button>
      <span>系統</span>
      <button><Share2 /> 已共享</button>
      <button><Trash2 /> 垃圾桶</button>
    </nav>
  );
}

function Breadcrumb({ window }: { window: FileWindow }) {
  const store = useWorkspaceStore();
  const parts = window.logicalPath.split("/").filter(Boolean);
  return (
    <div className="breadcrumb">
      <button onClick={() => store.updateWindow(window.id, { logicalPath: "/" })}>{window.rootSlug}</button>
      {parts.map((part, index) => {
        const nextPath = `/${parts.slice(0, index + 1).join("/")}`;
        return <button key={nextPath} onClick={() => store.updateWindow(window.id, { logicalPath: nextPath })}>{part}</button>;
      })}
    </div>
  );
}

function FileRow({
  item,
  window,
  readonly,
  onOpenContext,
  onSelect
}: {
  item: FileItem;
  window: FileWindow;
  readonly: boolean;
  onOpenContext: (event: React.MouseEvent<HTMLElement>, item: FileItem) => void;
  onSelect: (event: React.MouseEvent<HTMLElement>, item: FileItem) => void;
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
      draggable
      onDragStart={(event) => {
        const paths = selected && window.selectedItems.length > 0 ? window.selectedItems : [item.path];
        const items = paths.map((path) => ({ rootSlug: window.rootSlug, path }));
        event.dataTransfer.setData("application/kago-files", JSON.stringify(items));
        event.dataTransfer.setData("application/kago-file", JSON.stringify(items[0]));
      }}
      onClick={(event) => onSelect(event, item)}
      onContextMenu={(event) => onOpenContext(event, item)}
      onDoubleClick={() => {
        if (item.kind === "folder") store.updateWindow(window.id, { logicalPath: item.path, selectedItems: [] });
        else globalThis.open(downloadUrl(window.rootSlug, item.path), "_blank");
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
  const [dropActive, setDropActive] = useState(false);
  const [dropError, setDropError] = useState("");
  const shelf = shelves.data?.[0];
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

  async function copyToActive() {
    if (!active || activeReadonly || shelfItems.length === 0) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "copy",
        sources: shelfItems.map((item) => ({ rootSlug: item.root_slug, path: item.path })),
        destination: { rootSlug: active.rootSlug, path: active.logicalPath }
      })
    });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function compressToActive() {
    if (!active || activeReadonly || shelfItems.length === 0) return;
    const name = prompt("壓縮檔名稱", "shelf.zip");
    if (!name) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "compress",
        sources: shelfItems.map((item) => ({ rootSlug: item.root_slug, path: item.path })),
        destination: { rootSlug: active.rootSlug, path: joinLogicalPath(active.logicalPath, ensureZipName(name)) }
      })
    });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  return (
    <aside
      className={`floating-shelf ${dropActive ? "drop-active" : ""}`}
      onDragOver={(event) => {
        event.preventDefault();
        setDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }}
      onDrop={(event) => void addDroppedItems(event)}
    >
      <header><Archive /> 中轉區 <span>{shelfItems.length}</span></header>
      <div className="shelf-items">
        {shelfItems.length === 0 ? (
          <div className="shelf-empty"><span>拖放檔案到這裡</span><small>中轉區只保存 reference，不會立即複製。</small></div>
        ) : null}
        {shelfItems.map((item) => <div key={item.id}><span>{item.name}</span><small>{item.path}</small></div>)}
      </div>
      {dropError ? <small className="readonly-note">{dropError}</small> : null}
      {activeReadonly ? <small className="readonly-note">目前視窗是唯讀目的地</small> : null}
      <button className="tool-button" onClick={copyToActive} disabled={!active || activeReadonly}>複製到目前視窗</button>
      <button className="tool-button" onClick={compressToActive} disabled={!active || activeReadonly}>壓縮到目前視窗</button>
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

  async function retryTask(taskId: string) {
    await api(`/api/tasks/${taskId}/retry`, { method: "POST" });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
    await queryClient.invalidateQueries({ queryKey: ["fs"] });
  }

  return (
    <aside className="task-center">
      <header><Boxes /> 任務</header>
      <div className="task-list">
        {tasks.data?.slice(0, 6).map((task) => (
          <div className="task-item" key={task.id}>
            <strong>{task.type}</strong>
            <span className={`status ${task.status}`}>{task.status}</span>
            <progress value={task.processed_files} max={Math.max(task.total_files, 1)} />
            {task.error_message && <small>{task.error_message}</small>}
            <div className="task-actions">
              {task.status === "queued" ? (
                <button className="task-action" onClick={() => void cancelTask(task.id)}><X /> 取消</button>
              ) : null}
              {["failed", "cancelled", "interrupted"].includes(task.status) ? (
                <button className="task-action" onClick={() => void retryTask(task.id)}><RefreshCw /> 重試</button>
              ) : null}
            </div>
          </div>
        ))}
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
  const queryClient = useQueryClient();
  const activeWindow = store.windows.find((window) => window.id === store.activeWindowId);
  const selectedPath = activeWindow?.selectedItems[0] ?? null;
  const [tagName, setTagName] = useState("");
  const [shareMode, setShareMode] = useState<"download" | "view_only" | "upload_only">("download");
  const [shareUrl, setShareUrl] = useState("");
  const [userEmail, setUserEmail] = useState("");
  const [groupName, setGroupName] = useState("");
  const [permissionUserId, setPermissionUserId] = useState("");
  const [permissionRootId, setPermissionRootId] = useState("");

  async function addTag() {
    if (!activeWindow || !selectedPath || !tagName) return;
    const tag = await api<{ id: string }>("/api/tags", { method: "POST", body: JSON.stringify({ name: tagName, color: "#007aff" }) });
    await api("/api/tags/file", {
      method: "PUT",
      body: JSON.stringify({ rootSlug: activeWindow.rootSlug, path: selectedPath, tagIds: [tag.id] })
    });
    setTagName("");
  }

  async function createShare() {
    if (!activeWindow || !selectedPath) return;
    const share = await api<{ token: string }>("/api/shares", {
      method: "POST",
      body: JSON.stringify({ rootSlug: activeWindow.rootSlug, path: selectedPath, mode: shareMode })
    });
    setShareUrl(`${location.origin}/s/${share.token}`);
  }

  async function createUser() {
    if (!userEmail) return;
    await api("/api/users", {
      method: "POST",
      body: JSON.stringify({ email: userEmail, password: "change-me-123", displayName: userEmail.split("@")[0], role: "USER" })
    });
    setUserEmail("");
  }

  async function createGroup() {
    if (!groupName) return;
    await api("/api/groups", { method: "POST", body: JSON.stringify({ name: groupName }) });
    setGroupName("");
  }

  async function grantReadPermission() {
    if (!permissionUserId || !permissionRootId) return;
    await api("/api/permissions", {
      method: "POST",
      body: JSON.stringify({
        principalType: "user",
        principalId: permissionUserId,
        rootId: permissionRootId,
        pathPrefix: "/",
        allow: ["list", "read", "download"],
        deny: [],
        recursive: true
      })
    });
    setPermissionUserId("");
    setPermissionRootId("");
    await queryClient.invalidateQueries({ queryKey: ["roots"] });
  }

  return (
    <aside className="inspector">
      <header><Search /> 檢閱器</header>
      <section>
        <h3>Metadata</h3>
        <p>{selectedPath ? `${activeWindow?.rootSlug}:${selectedPath}` : "選取檔案後可檢視標籤、權限、分享狀態與預覽資訊。"}</p>
      </section>
      <section className="inspector-card">
        <h3>標籤</h3>
        <div className="inline-form">
          <input placeholder="標籤名稱" value={tagName} onChange={(event) => setTagName(event.target.value)} />
          <button className="tool-button" onClick={addTag}><Tags /> 套用</button>
        </div>
      </section>
      <section className="inspector-card">
        <h3>分享</h3>
        <div className="inline-form">
          <select value={shareMode} onChange={(event) => setShareMode(event.target.value as "download" | "view_only" | "upload_only")}>
            <option value="download">下載</option>
            <option value="view_only">檢視</option>
            <option value="upload_only">只允許上傳</option>
          </select>
          <button className="tool-button" onClick={createShare}><Share2 /> 建立</button>
        </div>
        {shareUrl && <input readOnly value={shareUrl} />}
      </section>
      <section className="inspector-card">
        <h3>管理</h3>
        <div className="inline-form">
          <input placeholder="user@example.com" value={userEmail} onChange={(event) => setUserEmail(event.target.value)} />
          <button className="tool-button" onClick={createUser}>新增使用者</button>
        </div>
        <div className="inline-form">
          <input placeholder="群組名稱" value={groupName} onChange={(event) => setGroupName(event.target.value)} />
          <button className="tool-button" onClick={createGroup}>新增群組</button>
        </div>
      </section>
      <section className="inspector-card">
        <h3>權限</h3>
        <div className="inline-form">
          <input placeholder="使用者 ID" value={permissionUserId} onChange={(event) => setPermissionUserId(event.target.value)} />
          <select value={permissionRootId} onChange={(event) => setPermissionRootId(event.target.value)}>
            <option value="">Root</option>
            {roots.data?.map((root) => <option key={root.id} value={root.id}>{root.name}</option>)}
          </select>
          <button className="tool-button" onClick={grantReadPermission}>讀取</button>
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

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

function joinLogicalPath(parent: string, name: string) {
  const cleanName = name.replaceAll("\\", "-").replaceAll("/", "-").replaceAll("\0", "");
  const base = parent === "/" ? "" : parent;
  return `${base}/${cleanName}`;
}

function ensureZipName(value: string) {
  const trimmed = value.trim() || "archive";
  return trimmed.toLowerCase().endsWith(".zip") ? trimmed : `${trimmed}.zip`;
}

function defaultSortDirection(sortBy: FileWindow["sortBy"]): FileWindow["sortDirection"] {
  return sortBy === "size" || sortBy === "mtime" ? "desc" : "asc";
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
