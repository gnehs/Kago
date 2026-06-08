import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AppWindow, Archive, Boxes, Check, ChevronDown, ChevronLeft, ChevronRight, Circle, CirclePlus, Columns3, Download, FileText, Folder, FolderOpen, Globe2, HardDrive, HelpCircle, Home, LayoutGrid, List, Loader2, LogOut, Maximize2, MessageCircle, Minimize2, MoreHorizontal, PanelRight, Pencil, Plus, Radio, RefreshCw, Search, Server, Settings2, Share2, SlidersHorizontal, Smartphone, Star, Tags, Trash2, Upload, UserRound, X } from "lucide-react";
import { api, downloadUrl, thumbnailUrl } from "./api/client";
import { useFileList, useMe, useRoots, useSaveWorkspace, useShelves, useTasks, useWorkspace } from "./api/hooks";
import { useWorkspaceStore } from "./stores/workspace";
import type { FileItem, FileWindow, Root } from "./types/kago";

export function App() {
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

function Workspace({ userEmail }: { userEmail: string }) {
  const workspaceQuery = useWorkspace();
  const roots = useRoots();
  const saveWorkspace = useSaveWorkspace();
  const store = useWorkspaceStore();
  const queryClient = useQueryClient();
  const saveTimer = useRef<number | null>(null);

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
      if (String(message.type).startsWith("task.")) void queryClient.invalidateQueries({ queryKey: ["tasks"] });
      if (message.type === "shelf.updated") void queryClient.invalidateQueries({ queryKey: ["shelves"] });
    };
    return () => ws.close();
  }, [queryClient]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const active = store.windows.find((window) => window.id === store.activeWindowId);
      if (!active) return;
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === "w") {
        event.preventDefault();
        store.closeWindow(active.id);
      }
      if (mod && event.key.toLowerCase() === "n") {
        event.preventDefault();
        store.openWindow({ rootSlug: active.rootSlug, logicalPath: active.logicalPath, title: active.title });
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
      if (event.key === "Escape") store.selectItems(active.id, []);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store]);

  if (workspaceQuery.isLoading || roots.isLoading) return <ShellLoading />;

  const rootList = roots.data ?? [];

  return (
    <main className="app-shell">
      <DesktopTopBar userEmail={userEmail} />
      <DesktopIcons roots={rootList} />
      <section className="desktop-window desktop-window-background">
        <Sidebar roots={rootList} userEmail={userEmail} />
        <section className="workspace-canvas">
          <TopStrip />
          {store.windows.length === 0 ? <RootPicker roots={rootList} /> : null}
          {store.windows.map((window) => (
            <FileWindowView key={window.id} window={window} />
          ))}
          <FloatingShelf />
          <TaskCenter />
        </section>
        <Inspector />
      </section>
    </main>
  );
}

function DesktopTopBar({ userEmail }: { userEmail: string }) {
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
        <button title="控制台"><SlidersHorizontal /></button>
        <button title="搜尋"><Search /></button>
      </div>
    </header>
  );
}

function DesktopIcons({ roots }: { roots: Root[] }) {
  const store = useWorkspaceStore();
  const firstRoot = roots[0];
  const iconItems = [
    { label: "套件中心", icon: <Boxes />, action: undefined },
    { label: "控制台", icon: <SlidersHorizontal />, action: undefined },
    { label: "File Station", icon: <FolderOpen />, action: firstRoot ? () => store.openRoot(firstRoot) : undefined },
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

function Sidebar({ roots, userEmail }: { roots: Root[]; userEmail: string }) {
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
        <button className="side-item"><Radio /> AirDrop</button>
        <button className="side-item"><Globe2 /> 網路</button>
        <button className="side-item"><Trash2 /> 垃圾桶</button>
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
      <div className="view-segment" aria-label="View mode">
        <button className={active?.viewMode === "grid" ? "selected" : ""} onClick={() => active && store.updateWindow(active.id, { viewMode: "grid" })}><LayoutGrid /></button>
        <button className={active?.viewMode === "list" ? "selected" : ""} onClick={() => active && store.updateWindow(active.id, { viewMode: "list" })}><List /></button>
        <button className={active?.viewMode === "columns" ? "selected" : ""} onClick={() => active && store.updateWindow(active.id, { viewMode: "columns" })}><Columns3 /></button>
      </div>
      <div className="toolbar-cluster">
        <button className="chrome-button"><Boxes /><ChevronDown /></button>
        <button className="chrome-button"><Share2 /></button>
        <button className="chrome-button"><Tags /></button>
        <button className="chrome-button"><MoreHorizontal /></button>
      </div>
      <div className="top-actions">
        <label className="search-pill"><Search /><input placeholder="搜尋" /></label>
        <button className="chrome-button" title="New window" onClick={() => active && store.openWindow({ rootSlug: active.rootSlug, logicalPath: active.logicalPath, title: active.title })}><CirclePlus /></button>
      </div>
    </header>
  );
}

function RootPicker({ roots }: { roots: Root[] }) {
  const store = useWorkspaceStore();
  return (
    <section className="root-picker">
      <div className="root-picker-inner">
        <HardDrive />
        <h2>Open a root</h2>
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
  const [drag, setDrag] = useState<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const [resize, setResize] = useState<{ startX: number; startY: number; width: number; height: number } | null>(null);
  const [dropChoice, setDropChoice] = useState<{ items: Array<{ rootSlug: string; path: string }> } | null>(null);

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

  const sortedItems = useMemo(() => {
    const items = [...(fileList.data?.items ?? [])];
    const direction = window.sortDirection === "asc" ? 1 : -1;
    items.sort((a, b) => {
      const av = window.sortBy === "name" ? a.name : window.sortBy === "size" ? a.size : window.sortBy === "mtime" ? a.mtime : a.type;
      const bv = window.sortBy === "name" ? b.name : window.sortBy === "size" ? b.size : window.sortBy === "mtime" ? b.mtime : b.type;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * direction;
    });
    return items;
  }, [fileList.data, window.sortBy, window.sortDirection]);

  async function createTask(type: "copy" | "move") {
    if (!dropChoice) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({ type, sources: dropChoice.items, destination: { rootSlug: window.rootSlug, path: window.logicalPath } })
    });
    setDropChoice(null);
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  async function mkdir() {
    const name = prompt("Folder name");
    if (!name) return;
    await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: window.logicalPath, name }) });
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
  }

  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
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

  return (
    <section
      className={`file-window ${window.focused ? "focused" : ""} ${window.maximized ? "maximized" : ""}`}
      style={window.maximized ? { zIndex: window.zIndex } : { left: window.x, top: window.y, width: window.width, height: window.height, zIndex: window.zIndex }}
      onMouseDown={() => store.focusWindow(window.id)}
      data-window={window.id}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const raw = event.dataTransfer.getData("application/kago-file");
        if (raw) setDropChoice({ items: [JSON.parse(raw)] });
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
                  <div className="address-field">
                    <Breadcrumb window={window} />
                    <Star />
                  </div>
                  <label className="search-pill window-search"><Search /><input placeholder="搜尋" /></label>
                </div>
                <div className="action-row">
                  <button className="tool-button" onClick={mkdir}><Folder /> 建立 <ChevronDown /></button>
                  <label className="tool-button file-input"><Upload /> 上傳 <ChevronDown /><input type="file" multiple onChange={upload} /></label>
                  <button className="tool-button"><MoreHorizontal /> 操作 <ChevronDown /></button>
                  <button className="tool-button"><Settings2 /> 工具 <ChevronDown /></button>
                  <button className="tool-button"><SlidersHorizontal /> 設定</button>
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
                    <span>名稱</span>
                    <span>大小</span>
                    <span>種類</span>
                    <span>加入日期</span>
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                )}
                {fileList.isLoading && <div className="empty-state"><Loader2 className="spin" /> Loading</div>}
                {fileList.error && <div className="empty-state error">{fileList.error.message}</div>}
                {!fileList.isLoading && sortedItems.length === 0 && <div className="empty-state">Empty folder</div>}
                {sortedItems.map((item) => <FileRow key={item.path} item={item} window={window} />)}
              </div>
              <div className="statusbar">
                <span className="pathbar"><HardDrive /> {window.rootSlug} <ChevronRight /> {window.logicalPath === "/" ? window.title : window.logicalPath.split("/").filter(Boolean).join(" › ")}</span>
                <span>{sortedItems.length} 個項目</span>
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
          <button onClick={() => void createTask("copy")}>複製到這裡</button>
          <button onClick={() => void createTask("move")}>搬移到這裡</button>
          <button onClick={() => setDropChoice(null)}>取消</button>
        </div>
      )}
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

function FileRow({ item, window }: { item: FileItem; window: FileWindow }) {
  const store = useWorkspaceStore();
  const selected = window.selectedItems.includes(item.path);
  const queryClient = useQueryClient();

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
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData("application/kago-file", JSON.stringify({ rootSlug: window.rootSlug, path: item.path }));
      }}
      onClick={() => store.selectItems(window.id, selected ? [] : [item.path])}
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
      <button className="icon-button" onClick={(event) => { event.stopPropagation(); void renameItem(); }} title="重新命名"><Pencil /></button>
      <button className="icon-button" onClick={(event) => { event.stopPropagation(); void addToShelf(); }} title="加入中轉區"><Archive /></button>
      <button className="icon-button danger" onClick={(event) => { event.stopPropagation(); void trashItem(); }} title="移到垃圾桶"><Trash2 /></button>
    </div>
  );

  async function renameItem() {
    const nextName = prompt("新的名稱", item.name);
    if (!nextName || nextName === item.name) return;
    await api("/api/fs/rename", {
      method: "POST",
      body: JSON.stringify({ rootSlug: window.rootSlug, path: item.path, name: nextName })
    });
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
  }

  async function trashItem() {
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
  const queryClient = useQueryClient();
  const shelf = shelves.data?.[0];
  if (!shelf || shelf.items.length === 0) return null;

  async function copyToActive() {
    if (!shelf || !active || shelf.items.length === 0) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        type: "copy",
        sources: shelf.items.map((item) => ({ rootSlug: item.root_slug, path: item.path })),
        destination: { rootSlug: active.rootSlug, path: active.logicalPath }
      })
    });
    await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }

  return (
    <aside className="floating-shelf">
      <header><Archive /> 中轉區 <span>{shelf?.items.length ?? 0}</span></header>
      <div className="shelf-items">
        {shelf?.items.map((item) => <div key={item.id}><span>{item.name}</span><small>{item.path}</small></div>)}
      </div>
      <button className="tool-button" onClick={copyToActive}>複製到目前視窗</button>
    </aside>
  );
}

function TaskCenter() {
  const tasks = useTasks();
  if (!tasks.data?.length) return null;
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

function viewModeLabel(mode: FileWindow["viewMode"]) {
  if (mode === "grid") return "圖像";
  if (mode === "columns") return "直欄";
  return "列表";
}
