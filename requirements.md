# Kago 產品需求與實作規格

## 1. 產品名稱

Kago

## 2. 產品定位

Kago 是一個以單一 Docker container 部署的多人 NAS 檔案管理器。

Kago 不是純前端工具。前端只負責顯示、互動、拖拉操作、建立任務與接收狀態更新。所有檔案操作都必須由後端 Node.js 服務與背景 worker 執行。

Kago 的使用體驗接近瀏覽器中的桌面檔案管理環境。使用者登入後會看到上次離開時的 Workspace，包括所有開啟中的檔案視窗、視窗位置、大小、路徑、中轉區與任務狀態。

核心目標：

* 單一 Docker container 部署。
* 不使用 Docker Compose。
* 不使用 Next.js。
* 前端使用 React + Vite。
* 後端使用 Node.js + Fastify。
* 資料庫使用 Node.js 內建 `node:sqlite`。
* 不使用 Redis、不使用 BullMQ、不使用外部資料庫。
* 使用者只需要掛載資料夾即可使用。
* 支援多人帳號、群組、以位置（root）為單位的權限與分享連結。
* 支援背景任務，前端關閉後任務仍繼續執行。
* 支援同一個網頁畫布中多開檔案視窗。
* 支援類似 Dropover 的中轉區。
* 支援高度客製化 UI，使用 shadcn/ui、Base UI、Tailwind CSS。
* 支援 DB tags，macOS Finder tags 作為 optional provider。

## 3. 非目標

第一版不做：

* Next.js
* Docker Compose
* Redis
* BullMQ
* PostgreSQL / MySQL
* 純前端長任務
* WebDAV
* Office 線上編輯
* 全文搜尋
* 影片轉檔
* 完整 macOS native helper
* 完整 Finder tag 雙向同步
* 拖移到桌面原生整合
* SSO / LDAP / SAML
* OPA / Casbin
* task resume
* 企業級 policy engine

## 4. 技術棧

### Frontend

* React
* Vite
* TypeScript
* React Router
* TanStack Query
* Zustand
* Tailwind CSS
* shadcn/ui
* Base UI

### Backend

* Node.js
* TypeScript
* Fastify
* WebSocket 或 SSE
* `node:sqlite`
* Node child process / worker process
* Zod

### Container

* Single Docker image
* Single `docker run`
* Mount `/data`
* Mount `/app-data`

## 5. 部署方式

目標部署方式：

```bash
docker run -d \
  --name kago \
  -p 8080:8080 \
  -v /volume1/files:/data \
  -v /volume1/docker/kago:/app-data \
  -e DATA_DIR=/data \
  -e APP_DATA_DIR=/app-data \
  -e PORT=8080 \
  --user 1000:1000 \
  --restart unless-stopped \
  ghcr.io/example/kago:latest
```

`/data` 是使用者要管理的 NAS 檔案資料夾。

`/app-data` 是 Kago 自己的資料目錄。

```txt
/app-data
  app.db
  thumbnails/
  temp/
  logs/
  trash/
```

## 6. 高階架構

```txt
Kago container
  ├─ React + Vite static frontend
  ├─ Node.js Fastify API server
  ├─ WebSocket / SSE event server
  ├─ Worker manager
  ├─ SQLite database via node:sqlite
  ├─ File task workers
  │   ├─ copy
  │   ├─ move
  │   ├─ delete-to-trash
  │   ├─ restore-trash
  │   ├─ compress
  │   ├─ extract
  │   ├─ rsync
  │   └─ thumbnail
  ├─ /data
  └─ /app-data
```

前端不是任務執行者。

前端建立任務後可以關閉。任務必須繼續在後端 worker 執行。

## 7. 專案目錄

```txt
kago/
  package.json
  tsconfig.json
  Dockerfile
  README.md

  apps/
    web/
      index.html
      vite.config.ts
      src/
        main.tsx
        App.tsx
        routes/
        components/
        layouts/
        stores/
        api/
        features/
          workspace/
          windows/
          files/
          tasks/
          shelves/
          shares/
          permissions/
          tags/
          auth/
          admin/

    server/
      src/
        main.ts
        app.ts

        config/
          env.ts

        db/
          db.ts
          schema.sql
          migrations/

        routes/
          auth.routes.ts
          fs.routes.ts
          task.routes.ts
          shelf.routes.ts
          tag.routes.ts
          share.routes.ts
          user.routes.ts
          group.routes.ts
          permission.routes.ts
          root.routes.ts
          workspace.routes.ts
          audit.routes.ts

        services/
          path.service.ts
          auth.service.ts
          session.service.ts
          permission.service.ts
          fs.service.ts
          task.service.ts
          shelf.service.ts
          tag.service.ts
          share.service.ts
          audit.service.ts
          root.service.ts
          workspace.service.ts

        workers/
          worker-manager.ts
          task-worker.ts
          jobs/
            copy.job.ts
            move.job.ts
            trash.job.ts
            restore-trash.job.ts
            compress.job.ts
            extract.job.ts
            rsync.job.ts
            thumbnail.job.ts

        ws/
          events.ts
          task-events.ts

        lib/
          logger.ts
          errors.ts
          crypto.ts
          mime.ts
```

## 8. URL 路由規則

Kago 不使用 URL 表示檔案路徑。

以下 URL 不代表資料夾：

```txt
/photos
/photos/2026
/downloads
/home/documents
```

也就是說，Kago 不支援：

```txt
/:rootSlug
/:rootSlug/*
```

檔案視窗的 root、path、位置、大小、排序、檢視模式都由 Workspace state 決定，不由 URL 決定。

### 保留路由

```txt
/
 /login
 /_kago
 /_kago/tasks
 /_kago/settings
 /_kago/shares
 /_kago/admin/users
 /_kago/admin/groups
 /_kago/admin/permissions
 /_kago/trash
 /_kago/audit
 /s/:token
 /api/*
 /ws
```

主 Workspace 使用：

```txt
/
```

登入後進入 `/`，Kago 會還原使用者上次的 Workspace。

## 9. Workspace 核心概念

Kago 是 browser 裡的 NAS desktop workspace。

```txt
Kago Workspace
  ├─ Window Manager
  ├─ File Windows
  ├─ Floating Shelf
  ├─ Task Center
  ├─ Sidebar
  ├─ Inspector
  └─ Context Menus
```

使用者登入 Kago 後，系統必須還原該使用者上次離開時的完整 Workspace。

Workspace 包含：

```txt
已開啟的所有檔案視窗
每個視窗的 rootSlug
每個視窗的 logicalPath
每個視窗的位置 x/y
每個視窗的大小 width/height
每個視窗的 zIndex
每個視窗是否最大化
每個視窗是否最小化
每個視窗的 viewMode
每個視窗的排序方式
active window
中轉區 UI 狀態
Task Center UI 狀態
Sidebar 狀態
Inspector 狀態
```

## 10. FileWindow model

```ts
type FileWindow = {
  id: string;

  rootSlug: string;
  logicalPath: string;

  title: string;

  x: number;
  y: number;
  width: number;
  height: number;
  zIndex: number;

  minimized: boolean;
  maximized: boolean;
  focused: boolean;

  viewMode: "list" | "grid" | "columns";
  sortBy: "name" | "size" | "mtime" | "type";
  sortDirection: "asc" | "desc";

  selectedItems: string[];
  scrollTop?: number;

  createdAt: number;
  updatedAt: number;
};
```

範例：

```json
{
  "id": "win_1",
  "rootSlug": "photos",
  "logicalPath": "/2026/japan",
  "title": "japan",
  "x": 80,
  "y": 64,
  "width": 960,
  "height": 640,
  "zIndex": 12,
  "minimized": false,
  "maximized": false,
  "focused": true,
  "viewMode": "list",
  "sortBy": "name",
  "sortDirection": "asc",
  "selectedItems": []
}
```

## 11. Workspace state 持久化

Workspace state 必須以使用者為單位持久化。

資料表：

```sql
CREATE TABLE user_workspaces (
  user_id TEXT PRIMARY KEY,
  windows_json TEXT NOT NULL,
  active_window_id TEXT,
  sidebar_json TEXT,
  inspector_json TEXT,
  shelf_json TEXT,
  updated_at INTEGER NOT NULL
);
```

`windows_json` 存所有開啟中的 FileWindow。

`active_window_id` 存目前聚焦視窗。

`sidebar_json` 可存：

```txt
sidebar 是否收合
選中的 sidebar section
root 展開狀態
```

`inspector_json` 可存：

```txt
inspector 是否開啟
inspector width
```

`shelf_json` 可存：

```txt
中轉區浮動位置
是否收合
目前 active shelf
```

## 12. Workspace API

### GET /api/workspace

取得目前使用者的 workspace。

```http
GET /api/workspace
```

回傳：

```json
{
  "activeWindowId": "win_1",
  "windows": [
    {
      "id": "win_1",
      "rootSlug": "photos",
      "logicalPath": "/2026/japan",
      "title": "japan",
      "x": 80,
      "y": 64,
      "width": 960,
      "height": 640,
      "zIndex": 12,
      "minimized": false,
      "maximized": false,
      "viewMode": "list",
      "sortBy": "name",
      "sortDirection": "asc"
    }
  ],
  "sidebar": {
    "collapsed": false
  },
  "inspector": {
    "open": true,
    "width": 320
  },
  "shelf": {
    "collapsed": false,
    "x": 120,
    "y": 720
  }
}
```

### PUT /api/workspace

儲存目前使用者的 workspace。

```http
PUT /api/workspace
```

後端必須驗證：

```txt
windows 必須是 array
window 數量不可超過上限
rootSlug 必須存在
logicalPath 必須是安全邏輯路徑
x/y/width/height 必須在合理範圍
zIndex 必須在合理範圍
viewMode 必須是允許值
sortBy 必須是允許值
sortDirection 必須是 asc 或 desc
```

第一版可以不在儲存時檢查資料夾是否存在。

FileWindow render 時再處理 404 / 403。

## 13. 啟動流程

使用者開啟 Kago：

```txt
GET /
  ↓
Fastify 回傳 React app
  ↓
React app 檢查登入狀態
  ↓
GET /api/auth/me
  ↓
GET /api/workspace
  ↓
還原所有 FileWindow
  ↓
每個 FileWindow 各自呼叫 /api/fs/list
```

如果使用者沒有 workspace：

```txt
顯示空白 workspace
顯示 root picker
讓使用者選擇要開啟的 root
建立第一個 FileWindow
```

不要自動假設 `/photos` 或第一個 root 一定要打開。

## 14. Workspace 自動儲存

前端必須 debounce 儲存 workspace。

建議：

```txt
視窗移動：debounce 1000ms
視窗縮放：debounce 1000ms
視窗開關：立即儲存
active window 改變：debounce 300ms
資料夾路徑改變：立即儲存
viewMode / sort 改變：立即儲存
```

避免每次 mousemove 都打 API。

## 15. 視窗還原錯誤處理

如果 workspace 中某個 FileWindow 的 root 不存在：

```txt
該視窗顯示 Root not found
不要自動刪除視窗
提供 Close window
```

如果 path 不存在：

```txt
該視窗顯示 Folder not found
提供 Go to root
提供 Close window
```

如果沒有權限：

```txt
該視窗顯示 Forbidden
清除 selectedItems
不要顯示舊快取資料
提供 Request access 或 Close window
```

如果 root readonly：

```txt
視窗仍可顯示
所有寫入操作 disabled
```

## 16. Window Manager

第一版 Window Manager 必須支援：

```txt
建立新視窗
關閉視窗
聚焦視窗
拖曳移動視窗
調整視窗大小
視窗 z-index 管理
最小化
最大化
還原
雙擊標題列最大化 / 還原
限制視窗不能完全拖出畫布
視窗標題顯示目前資料夾名稱
```

第二版可支援：

```txt
視窗吸附邊緣
左右分割
四角吸附
多視窗排列
記住每個 root 的預設視窗大小
```

視窗數量限制：

```txt
單一使用者最多 12 個開啟視窗
單一視窗最小寬度 360px
單一視窗最小高度 280px
```

超過限制時，UI 顯示：

```txt
已達視窗數量上限
```

## 17. 開新視窗行為

以下操作可以建立 FileWindow：

```txt
Sidebar 點 root
Root picker 選 root
資料夾右鍵 Open in New Window
Breadcrumb 選單 Open in New Window
中鍵點擊資料夾
Cmd/Ctrl + Enter
Command palette 開啟資料夾
```

預設行為：

```txt
雙擊資料夾
  => 在目前 active window 內進入資料夾

右鍵 Open in New Window
  => 建立新的 FileWindow

Sidebar 點 root
  => 如果 root 已有開啟視窗，聚焦該視窗
  => 如果沒有，建立新視窗
```

## 18. FileWindow 載入資料夾

每個視窗各自呼叫：

```http
GET /api/fs/list?rootSlug=photos&path=/2026/japan
```

API 使用 `rootSlug + logicalPath`，但這些值來自 workspace state，不來自 URL。

後端仍必須檢查：

```txt
auth
permission
root 是否存在
path sandbox
symlink
realpath 是否在 root 內
```

## 19. Frontend 狀態規則

錯誤做法：

```txt
使用 URL 當 currentPath
使用單一 global currentPath
使用單一 global selectedFiles
```

正確做法：

```txt
workspace.windows[windowId].rootSlug
workspace.windows[windowId].logicalPath
workspace.windows[windowId].selectedItems
workspace.activeWindowId
```

Zustand 負責：

```txt
workspace state
window positions
window size
active window
selected items per window
drag state
sidebar UI
inspector UI
shelf UI
```

TanStack Query 負責：

```txt
file list cache
tasks
roots
tags
shares
permissions
```

File list query key 必須包含視窗的 root 與 path：

```ts
["fs", "list", rootSlug, logicalPath]
```

## 20. 多視窗拖移

同一 workspace 內的 FileWindow 之間必須可以拖移檔案。

行為：

```txt
從 Window A 拖到 Window B
  => 建立 copy 或 move task
  => task 由後端 worker 執行
```

第一版建議 drop 後顯示 popover：

```txt
Copy here
Move here
Cancel
```

不要自動猜使用者是要 copy 還是 move。

## 21. 中轉區

中轉區類似 Dropover，是 Workspace 級別元件，不屬於單一視窗。

功能：

```txt
使用者可以把檔案拖到中轉區
中轉區只存檔案 reference
不要在加入中轉區時複製檔案
中轉區內容存 SQLite
中轉區 UI 狀態存在 workspace
中轉區支援跨視窗同步
使用者可以從中轉區建立 copy / move / compress task
中轉區 item 顯示名稱、類型、大小、來源路徑
```

行為：

```txt
從任一 FileWindow 拖到 Shelf
  => shelf 新增 reference

從 Shelf 拖到任一 FileWindow
  => 使用該 FileWindow 的 rootSlug + logicalPath 建立 task
```

權限：

```txt
加入中轉區時，至少需要 view
從中轉區建立 copy task 時，重新檢查 source view 和 destination edit
從中轉區建立 move task 時，重新檢查 source edit 和 destination edit
```

## 22. 跨瀏覽器視窗同步

如果使用者同時開了多個瀏覽器分頁或視窗：

```txt
WebSocket / SSE 是主要同步來源
BroadcastChannel 可用於同瀏覽器內的 UI 輔助同步
```

但 Workspace state 的真實來源仍是後端 SQLite。

## 23. 拖移到桌面

拖移到桌面不是第一版核心功能。

第一版：

```txt
提供下載按鈕
多檔下載先建立 zip task，再下載
```

後續可做：

```txt
Chrome-only DownloadURL experimental support
File System Access API 寫入使用者授權資料夾
macOS helper 提供真正 Finder-like 行為
```

不得把拖到桌面列為 MVP 必做。

## 24. Root model

`roots` 必須有 `slug` 欄位。

```sql
CREATE TABLE roots (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL,
  readonly INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

slug 規則：

```txt
只能使用 a-z、0-9、-、_
不可為空
不可包含 /
不可使用保留字
建立後不建議自動修改
```

範例：

```txt
photos
downloads
home
movies
backup
```

## 25. 保留 slug

以下 slug 不可作為 root slug：

```txt
api
assets
auth
login
logout
admin
settings
tasks
shares
shelves
tags
trash
users
groups
permissions
audit
s
_kago
static
favicon.ico
robots.txt
```

## 26. UI 技術與設計系統

Kago UI 使用：

```txt
React
Vite
Tailwind CSS
shadcn/ui
Base UI
TanStack Query
Zustand
```

UI 方針：

```txt
shadcn/ui 作為可修改的元件起點
Base UI 作為低階 accessible primitives
Tailwind 作為 styling layer
不要做成一般後台模板
不要直接依賴大型預設主題
```

### shadcn/ui 用於

```txt
Button
Input
Dialog
Sheet
DropdownMenu
Popover
Command
Tabs
Tooltip
Badge
Separator
ScrollArea
Resizable panels
Form layout
Toast / Sonner
```

### Base UI 用於

```txt
高度客製化互動元件
複雜 menu
context menu
drag/drop 相關浮層
combobox
select
tooltip / popover primitive
accessibility-sensitive components
```

Base UI primitive 不應到處直接散落在 feature code 中，應包成 Kago 自己的 design system component。

例如：

```txt
KagoContextMenu
KagoFileRow
KagoFileGridItem
KagoInspectorPanel
KagoShelf
KagoTaskToast
KagoPermissionEditor
KagoShareDialog
KagoTagPicker
KagoWindow
KagoWindowTitleBar
```

## 27. Tailwind 設計規則

使用 Tailwind CSS 與 CSS variables 建立 design tokens。

必要 tokens：

```css
:root {
  --kago-bg: ;
  --kago-surface: ;
  --kago-surface-elevated: ;
  --kago-border: ;
  --kago-text: ;
  --kago-text-muted: ;
  --kago-accent: ;
  --kago-danger: ;
  --kago-warning: ;
  --kago-success: ;
  --kago-radius-sm: ;
  --kago-radius-md: ;
  --kago-radius-lg: ;
}
```

需求：

```txt
支援 dark mode
支援 sidebar collapse
支援 resizable panels
支援高度客製化 icon / color / spacing
```

不要把顏色寫死在大量 component 裡。

顏色要集中在 CSS variables 與 Tailwind theme。

## 28. UI 主要區塊

```txt
Sidebar
  - Roots
  - Recent
  - Tasks
  - Shares
  - Tags
  - Trash
  - Admin

Workspace Canvas
  - FileWindow
  - FileWindow
  - FileWindow
  - Floating Shelf
  - Task Center
  - Context Menus

FileWindow
  - Title bar
  - Toolbar
  - Breadcrumb
  - File list
  - File grid
  - Context menu
  - Multi-select
  - Drag selection
  - Status bar

Right inspector
  - Preview
  - Metadata
  - Tags
  - Permissions
  - Share status

Task Center
  - queued / running / failed / done
  - progress
  - cancel
  - retry
```

視覺方向：

```txt
像 Finder 一樣直覺
像 NAS File Station 一樣完整
像 Dropover 一樣有中轉區
像現代設計工具一樣細緻
```

## 29. Keyboard shortcuts

第一版支援：

```txt
Cmd/Ctrl + N:
  開新檔案視窗，預設開啟目前 active window 的 root/path

Cmd/Ctrl + W:
  關閉 active window

Alt + N / Alt + W:
  同 Cmd/Ctrl + N、Cmd/Ctrl + W。一般瀏覽器分頁會攔走 Cmd/Ctrl + N 與 Cmd/Ctrl + W，
  所以這兩組才是分頁內實際可用的快捷鍵

Cmd/Ctrl + L:
  聚焦 active window 的 breadcrumb / address bar

Cmd/Ctrl + R:
  refresh active window file list

Arrow keys:
  在 active window 中移動選取

Enter:
  開啟資料夾或預覽檔案

Backspace:
  回上一層

Cmd/Ctrl + A:
  active window 全選

Esc:
  清除 active window 選取或關閉 context menu
```

快捷鍵只作用於 active window。

## 30. 視窗層級

Window Manager 必須統一管理 z-index。

層級建議：

```txt
File windows: 100-499
Shelf: 600
Task center: 700
Context menu: 800
Dialog: 900
Toast: 1000
```

Context menu、Dialog、Popover 不應被 FileWindow 擋住。

## 31. 資料庫初始化

使用 Node.js 內建 `node:sqlite`。

啟動時：

```txt
確認 /data 存在
確認 /app-data 可寫
初始化 SQLite
啟用 WAL
啟用 foreign_keys
設定 busy_timeout
執行 migration
將上次 running task 標成 interrupted
啟動 worker pool
啟動 HTTP / WebSocket server
```

初始化範例：

```ts
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const appDataDir = process.env.APP_DATA_DIR ?? "/app-data";
const dbPath = path.join(appDataDir, "app.db");

export const db = new DatabaseSync(dbPath);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
`);
```

## 32. 核心資料表

### users

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER',
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`role`：

```txt
ADMIN
USER
GUEST
```

### sessions

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
```

### groups

```sql
CREATE TABLE groups (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE group_members (
  group_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  PRIMARY KEY (group_id, user_id)
);
```

### roots

```sql
CREATE TABLE roots (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL,
  readonly INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### permission_rules

```sql
CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY,
  principal_type TEXT NOT NULL,
  principal_id TEXT NOT NULL,

  root_id TEXT NOT NULL,
  level TEXT NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE (principal_type, principal_id, root_id),
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
);
```

一個 principal 在一個 root 最多一條規則。規則沒有路徑：它涵蓋整個 root。

`principal_type`：

```txt
user
group
```

`level`：

```txt
view   列出、預覽、下載、分享
edit   view 的全部，加上上傳、建立資料夾、改名、搬移、刪除、標籤
```

### user_workspaces

```sql
CREATE TABLE user_workspaces (
  user_id TEXT PRIMARY KEY,
  windows_json TEXT NOT NULL,
  active_window_id TEXT,
  sidebar_json TEXT,
  inspector_json TEXT,
  shelf_json TEXT,
  updated_at INTEGER NOT NULL
);
```

### tasks

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,

  type TEXT NOT NULL,
  status TEXT NOT NULL,

  created_by TEXT NOT NULL,

  sources_json TEXT NOT NULL,
  destination TEXT,

  total_files INTEGER DEFAULT 0,
  processed_files INTEGER DEFAULT 0,

  total_bytes INTEGER DEFAULT 0,
  processed_bytes INTEGER DEFAULT 0,

  current_path TEXT,
  error_message TEXT,

  auth_snapshot_json TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);

CREATE INDEX idx_tasks_status_created
ON tasks(status, created_at);
```

Task types：

```txt
copy
move
compress
download_zip
extract
rsync_pull
rsync_push
delete_to_trash
restore_trash
thumbnail
```

Task statuses：

```txt
queued
running
pausing
paused
done
failed
cancelled
interrupted
```

### shelves

```sql
CREATE TABLE shelves (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE shelf_items (
  id TEXT PRIMARY KEY,
  shelf_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER,
  added_at INTEGER NOT NULL
);
```

### tags

```sql
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT,
  owner_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE file_tags (
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (root_id, path, tag_id)
);
```

### share_links

```sql
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,

  root_id TEXT NOT NULL,
  path TEXT NOT NULL,

  permission_json TEXT NOT NULL,

  expires_at INTEGER,
  max_downloads INTEGER,
  download_count INTEGER NOT NULL DEFAULT 0,

  password_hash TEXT,
  created_by TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

### trash_items

```sql
CREATE TABLE trash_items (
  id TEXT PRIMARY KEY,
  original_root_id TEXT NOT NULL,
  original_path TEXT NOT NULL,
  trash_path TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  restored_at INTEGER
);
```

### audit_logs

```sql
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY,

  actor_type TEXT NOT NULL,
  actor_id TEXT,

  action TEXT NOT NULL,
  root_id TEXT,
  path TEXT,

  target_json TEXT,
  result TEXT NOT NULL,

  ip TEXT,
  user_agent TEXT,

  created_at INTEGER NOT NULL
);
```

## 33. 權限模型

Kago 使用 app-level 權限，不依賴 Linux user 權限作為產品權限系統。

底層 Docker user 只是最後防線。實際產品權限由 Kago 的 users、groups、roots、permission_rules 決定。

### 權限以位置為單位

一條規則給一個 user 或 group 在一個 root 的 `view` 或 `edit`，root 裡的所有東西一體適用。

```txt
沒有只給某個子資料夾的規則
沒有把某個子資料夾排除在外的規則
沒有 deny
```

Kago 是家庭與小型辦公室的檔案管理器，不是企業級 ACL。規則不跟著路徑，搬移、改名、複製、壓縮就不必推算誰在半路上看得到什麼，管理員也一眼看得出誰能進哪裡。

代價：

```txt
不想讓同一批人看到的東西，必須放在另一個 root
同一批檔案不能同時從另一個已授權的 root 進得去
只想給外人一個檔案時，使用公開分享連結
```

### 權限判斷函式

必須實作：

```ts
can(actor, level, root): {
  allowed: boolean;
  reason?: string;
}
```

規則：

```txt
1. disabled user 永遠拒絕
2. root readonly 時，edit 永遠拒絕，ADMIN 也一樣
3. ADMIN 其餘一律允許
4. user 自己的規則與所屬 group 的規則相加，取最高的 level
5. edit 包含 view
6. 沒有規則就拒絕，連這個 root 都看不到
```

`require(actor, level, root, path)` 是會丟出 403 的版本。`path` 只用來寫進 audit log，不影響判斷結果。

所有 API 必須呼叫 `can()` 或 `require()`。

所有 worker 在真正執行 task 前，也必須重新檢查。

不能只在建立 task 時檢查一次，因為 task 排隊期間權限可能被移除。

### 從路徑級規則升級

舊版的規則帶有 `path_prefix` 與 `recursive`。升級時：

```txt
path_prefix 不是 / 的規則：移除
recursive = 0 的規則：移除
每移除一條，寫一筆 actor 為 system 的 permission_change audit log
同一個 principal 在同一個 root 剩下多條時，留下 level 最高的那條
```

被移除的規則不得放大成整個 root 的權限。

## 34. 檔案操作權限對照

```txt
list folder:
  view

preview file:
  view

download file / download zip:
  view

upload file:
  edit

create folder:
  edit

rename:
  edit

copy:
  source: view
  destination: edit

move:
  source: edit
  destination: edit

delete to trash / restore:
  edit

create share:
  view_only / download: view
  upload_only: edit

read tags:
  view

edit tags:
  edit

edit permissions:
  ADMIN only

compress:
  source: view
  destination: edit

extract:
  archive: view
  destination: edit

sync:
  source: view
  destination: edit
```

## 35. 路徑安全

所有前端傳來的 path 都只能是邏輯路徑，不可以直接傳實體路徑。

前端傳：

```txt
rootSlug: photos
path: /Japan/2026/a.jpg
```

後端轉換成：

```txt
/data/photos/Japan/2026/a.jpg
```

必須實作：

```ts
resolveSafePath(rootIdOrSlug, userPath)
```

需求：

```txt
normalize path
禁止 ..
禁止 null byte
禁止直接傳 /data/...
使用 realpath
確認 real path 仍在 root base path 裡
symlink 預設不允許
如果未來允許 symlink，realpath 後仍必須在 root 裡
錯誤訊息不可暴露 host 實體路徑
```

## 36. 背景任務

所有長時間任務都必須背景執行。

包含：

```txt
copy
move
delete to trash
restore trash
compress
extract
rsync pull
rsync push
thumbnail generation
```

前端送出：

```http
POST /api/tasks
```

後端只建立任務，不等待任務完成。

task 建立後立即寫入 SQLite。

worker loop 從 SQLite queue claim task。

claim task 必須使用 transaction，避免多個 worker 拿到同一個任務。

概念 SQL：

```sql
BEGIN IMMEDIATE;

SELECT id
FROM tasks
WHERE status = 'queued'
ORDER BY created_at ASC
LIMIT 1;

UPDATE tasks
SET status = 'running',
    started_at = unixepoch(),
    updated_at = unixepoch()
WHERE id = ?
  AND status = 'queued';

COMMIT;
```

進度欄位：

```txt
total_files
processed_files
total_bytes
processed_bytes
current_path
```

不要只存 percentage。

進度更新必須節流，例如每 500ms 或每 16MB 更新一次，避免 SQLite 寫入過度頻繁。

container 啟動時，所有 `running` task 必須標成 `interrupted` 或 `failed`。

第一版可以不支援 task resume。

## 37. Worker 行為

worker 執行前必須：

```txt
讀取 task
重新 resolve safe path
重新檢查權限
檢查 root readonly
寫 audit log
開始執行
定期更新進度
送出 WebSocket / SSE event
```

worker crash 時：

```txt
不可讓整個 server crash
task 標成 failed 或 interrupted
寫 audit log
worker manager 可重啟 worker，但要有 backoff，避免無限重啟
```

## 38. WebSocket / SSE

前端開啟時：

```txt
1. GET /api/auth/me
2. GET /api/workspace
3. GET /api/tasks
4. GET /api/shelves
5. connect WebSocket
6. 還原 Workspace
7. 每個 FileWindow 自己 fetch file list
```

事件格式：

```ts
type ServerEvent =
  | { type: "task.created"; task: FileTask }
  | { type: "task.progress"; taskId: string; patch: Partial<FileTask> }
  | { type: "task.done"; taskId: string }
  | { type: "task.failed"; taskId: string; error: string }
  | { type: "shelf.updated"; shelfId: string }
  | { type: "permission.updated" }
  | { type: "share.updated" };
```

WebSocket 只是通知，不是狀態來源。

狀態來源永遠是 SQLite / API。

前端重連後必須重新 fetch tasks，避免漏事件。

## 39. 分享功能

### 內部分享

沒有針對單一檔案或資料夾的內部分享。

要讓 user 或 group 看到東西，就給他們那個 root 的 permission rule；只想給出一個檔案時，使用公開分享連結。

### 公開分享連結

公開分享連結使用高熵 token。

DB 只存 token hash，不存明文 token。

可設定：

```txt
到期時間
密碼
最大下載次數
是否停用
權限類型
```

第一版支援三種分享模式：

```txt
view_only
download
upload_only
```

`upload_only` 適合做收件箱：

```txt
外部使用者只能上傳
不能列資料夾
不能下載既有檔案
不能刪除
不能重新命名
```

公開分享連結第一版不得支援：

```txt
delete
rename
move
extract
rsync
edit permissions
```

## 40. Trash

刪除預設必須進垃圾桶，不直接永久刪除。

Trash mode 支援：

```txt
app_data
same_volume
```

`app_data`：

```txt
/app-data/trash/
```

`same_volume`：

```txt
/data/.trash/
```

第一版預設使用 `app_data`。

刪除時要記錄 trash_items。

必須支援 restore。

第一版可以不支援永久刪除，或只允許 ADMIN 永久刪除。

## 41. Tags

第一版先做 Kago DB tags。

macOS Finder tags 作為 optional provider。

Provider interface：

```ts
interface TagProvider {
  getTags(rootId: string, path: string): Promise<Tag[]>;
  setTags(rootId: string, path: string, tags: Tag[]): Promise<void>;
}
```

Provider：

```txt
DbTagProvider
XattrTagProvider
```

第一版：

```txt
DbTagProvider 必做
XattrTagProvider 可先留 interface
如果 xattr 讀寫失敗，不可以讓檔案管理功能失效
UI 可顯示 Finder tag sync error
```

## 42. rsync

rsync 不當成掛載功能。

Kago 只提供 rsync task：

```txt
rsync_pull
rsync_push
```

範例：

```json
{
  "type": "rsync_pull",
  "remote": "user@example.com:/home/user/photos/",
  "destination": {
    "rootSlug": "photos",
    "path": "/incoming"
  },
  "options": {
    "archive": true,
    "delete": false,
    "dryRun": false
  }
}
```

第一版可以先不做 credential vault。

如果需要密碼或 SSH key，先設計資料表與 UI，但不要硬塞明文密碼。

## 43. API 初版規格

### Auth

```txt
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/me
```

### Workspace

```txt
GET /api/workspace
PUT /api/workspace
```

### Files

```txt
GET    /api/fs/list?rootSlug=photos&path=/Japan
GET    /api/fs/meta?rootSlug=photos&path=/Japan/a.jpg
GET    /api/fs/download?rootSlug=photos&path=/Japan/a.jpg
GET    /api/fs/preview?rootSlug=photos&path=/Japan/a.jpg
GET    /api/fs/thumbnail?rootSlug=photos&path=/Japan/a.jpg
POST   /api/fs/upload
POST   /api/fs/mkdir
```

### Tasks

```txt
POST   /api/tasks
GET    /api/tasks
GET    /api/tasks/:id
POST   /api/tasks/:id/cancel
POST   /api/tasks/:id/pause
POST   /api/tasks/:id/resume
```

### Shelves

```txt
GET    /api/shelves
POST   /api/shelves
POST   /api/shelves/:id/items
DELETE /api/shelves/:id/items/:itemId
POST   /api/shelves/:id/tasks
```

### Tags

```txt
GET  /api/tags/file?rootSlug=photos&path=/Japan/a.jpg
PUT  /api/tags/file
GET  /api/tags
POST /api/tags
```

### Users

```txt
GET    /api/users
POST   /api/users
PATCH  /api/users/:id
```

### Groups

```txt
GET    /api/groups
POST   /api/groups
POST   /api/groups/:id/members
DELETE /api/groups/:id/members/:userId
```

### Permissions

```txt
GET    /api/permissions?rootId=...
PUT    /api/permissions
```

`PUT` 設定一個 principal 在一個 root 的 level：

```json
{ "principalType": "group", "principalId": "...", "rootId": "...", "level": "view" }
```

`level` 為 `null` 時移除規則。

```txt
只有 ADMIN 可以呼叫
```

### Roots

```txt
GET    /api/roots
PATCH  /api/roots/:id
```

### Shares

```txt
GET    /api/shares
POST   /api/shares
PATCH  /api/shares/:id
DELETE /api/shares/:id

GET    /s/:token
POST   /s/:token/auth
GET    /s/:token/download
POST   /s/:token/upload
```

### Audit

```txt
GET /api/audit
```

## 44. 安全需求

必須實作：

```txt
session cookie
HttpOnly
Secure when HTTPS
SameSite=Lax 或 Strict
password hash
CSRF 防護
path traversal 防護
upload filename validation
share token hash storage
audit log
deny-by-default authorization
server-side permission check
worker-side permission revalidation
```

檔案上傳限制：

```txt
禁止 null byte
禁止 /
禁止 ..
限制檔名長度
限制單檔大小
限制同時上傳數
不要把上傳檔案當 server executable
不要讓 upload path 逃出 root
```

解壓縮限制：

```txt
防止 zip slip
禁止壓縮檔 entry 使用絕對路徑
禁止壓縮檔 entry 使用 ../
解壓每個 entry 前都要 resolve safe destination
設定最大解壓檔案數與最大總大小
symlink entry 預設拒絕
```

## 45. Audit log

必須記錄：

```txt
login_success
login_failed
logout
create_share
disable_share
download_via_share
create_task
task_failed
delete_to_trash
restore_trash
rename
move
permission_change
user_create
user_disable
root_create
root_update
root_delete
workspace_update
```

不要只記成功，也要記失敗與拒絕。

## 46. MVP 範圍

第一階段必做：

```txt
Single Docker container
React + Vite frontend
Node.js Fastify backend
node:sqlite database
Fastify serve Vite static build
SPA fallback
admin 初始化
login / logout
users
groups
roots
root slug
workspace restore
window manager
multi FileWindow canvas
location permissions
file list
upload
download
mkdir
copy task
move task
delete-to-trash task
restore trash
zip compress task
unzip extract task
task progress
WebSocket / SSE task sync
shelf / 中轉區
DB tags
share links
audit logs
shadcn + Base UI + Tailwind 基礎 UI
```

第一階段先不做：

```txt
完整 macOS Finder tag sync
macOS native helper
拖移到桌面原生整合
Office 線上編輯
WebDAV
全文搜尋
影片轉檔
task resume
企業 SSO
OPA / Casbin
```

## 47. Codex 實作順序

請依照以下順序實作：

```txt
1. 建立 monorepo 結構
2. 建立 Vite + React app
3. 建立 Fastify server
4. Fastify serve Vite production build
5. 建立 SPA fallback
6. 加入 node:sqlite DB 初始化
7. 建立 schema 與 migration
8. 建立 admin 初始化流程
9. 建立 auth / user / session 基礎
10. 建立 root service
11. 建立 path sandbox service
12. 建立 permission service 與 can()
13. 建立 workspace table 與 workspace API
14. 建立前端 WorkspaceCanvas
15. 建立 Window Manager
16. 建立 FileWindow
17. 建立 file list API
18. FileWindow 串接 file list API
19. 建立 task table 與 SQLite task queue
20. 建立 worker manager
21. 實作 copy / move / trash task
22. 實作 WebSocket / SSE task event
23. 實作 React task center
24. 實作 shelf / 中轉區
25. 實作 share links
26. 實作 DB tags
27. 實作 audit log
28. 補 Dockerfile
29. 補 README 的 docker run 範例
```

## 48. 開發注意事項

```txt
所有 API route 都要使用 Zod 驗證 input
不要讓 API 接受實體路徑
不要把 /data path 回傳給前端
前端只看 rootSlug + logical path
Worker 不可以信任 task 裡的 path
Worker 執行前仍要 resolve safe path
Worker 不可以信任 task 建立時的權限
Worker 執行前仍要重新檢查目前權限
所有檔案修改動作都要寫 audit log
錯誤訊息不要暴露 host 實體路徑
預設不跟隨 symlink
前端權限控制只作為 UI 顯示，不能作為安全邊界
Workspace state 是檔案視窗狀態的 source of truth
URL 不存檔案路徑
TanStack Query 是資料快取
Zustand 只存 UI state
中轉區只存 reference，不複製檔案
WebSocket 只是通知，不是狀態來源
狀態來源永遠是 SQLite / API
```

## 49. 最小可用 Demo 定義

一個最小可用版本必須能做到：

```txt
docker run 啟動 Kago
第一次進入建立 admin
admin 建立 root，slug = photos，base_path = /data/photos
登入後進入 /
如果沒有 workspace，顯示 root picker
選 photos 後建立第一個 FileWindow
FileWindow 顯示 /data/photos 的內容
進入 photos 裡的 2026 資料夾
關掉瀏覽器
重新開啟 Kago
自動還原 FileWindow，仍停留在 photos:/2026
可以開第二個 FileWindow
可以在兩個 FileWindow 間拖移檔案
drop 後顯示 Copy here / Move here / Cancel
建立 copy task 後，前端關閉仍繼續執行
重新開啟前端可以看到 task 狀態
可以把檔案加入 shelf
可以從 shelf 複製到任一 FileWindow 目前資料夾
可以上傳檔案
可以下載檔案
可以建立資料夾
可以建立使用者與群組
可以設定某群組只能檢視 photos 這個位置
沒有規則的使用者看不到也無法列出 private 這個位置
可以建立公開下載分享連結
audit log 能看到登入、下載、建立 task、權限拒絕紀錄
```

## 50. 一句話總結

Kago 是一個單 container、多人、多視窗、具備背景任務與權限管理的 NAS desktop workspace。

檔案路徑存在於：

```txt
FileWindow state
SQLite user_workspaces
API request rootSlug + logicalPath
```

檔案路徑不應存在於 browser URL。
