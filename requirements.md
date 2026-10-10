# Kago 產品需求與實作規格

## 1. 產品名稱

Kago

## 2. 產品定位

Kago 是一個以單一 Docker container 部署的多人 NAS 檔案管理器。

Kago 不是純前端工具。前端只負責顯示、互動、拖拉操作、建立任務與接收狀態更新。所有檔案操作都必須由後端 Node.js 服務與背景 worker 執行。

Kago 的使用體驗接近瀏覽器中的桌面檔案管理環境。使用者登入後會看到上次離開時的 Workspace，包括所有開啟中的檔案視窗、視窗位置、大小、分頁、路徑與中轉區；任務狀態則隨時從後端讀回來。

核心目標：

* 單一 Docker container 部署，一行 `docker run` 就能用。
* 不需要 Docker Compose 編排其他服務；想用 Compose 啟動這一個 container 也可以。
* 不使用 Next.js。
* 前端使用 React + Vite。
* 後端使用 Node.js + Fastify。
* 資料庫使用 Node.js 內建 `node:sqlite`。
* 不使用 Redis、不使用 BullMQ、不使用外部資料庫。
* 使用者只需要掛載資料夾即可使用：`/data` 底下的每個資料夾就是一個位置。
* 支援把 SMB、SFTP、WebDAV、FTP 上的資料夾加成遠端位置。
* 支援多人帳號、群組、以位置（root）為單位的權限與分享連結。
* 支援背景任務，前端關閉後任務仍繼續執行。
* 支援同一個網頁畫布中多開檔案視窗，每個視窗可以有多個分頁。
* 支援類似 Dropover 的中轉區。
* 支援在瀏覽器裡預覽與播放：圖片、影片（必要時即時轉檔）、音樂、文字、PDF、Office 文件。
* 支援高度客製化 UI，使用 Base UI、Tailwind CSS 與專案自己持有的元件。
* 支援 Kago 自己的標籤，也讀寫 macOS Finder 標籤。
* 介面有 English、繁體中文、简体中文、日本語。

## 3. 非目標

不做：

* Next.js
* 需要其他服務才能運作的部署：Redis、BullMQ、PostgreSQL / MySQL
* 純前端長任務
* 當 WebDAV / SMB server（Kago 只以 client 的身分連到遠端位置）
* Office 線上編輯（只有預覽）
* 全文搜尋
* 完整 macOS native helper
* 拖移到桌面原生整合
* LDAP / SAML（單一登入只有 OpenID Connect）
* OPA / Casbin
* 企業級 policy engine、路徑級 ACL（見 §33）
* 執行中任務的暫停與續傳（task resume）

最初列為非目標、後來做了的：

```txt
影片轉檔
單一登入（OIDC）
macOS Finder 標籤的讀寫
WebDAV（作為遠端位置的一種）
```

## 4. 技術棧

### Frontend

* React
* Vite
* TypeScript
* React Router
* TanStack Query
* Zustand
* Tailwind CSS
* Base UI
* lucide-react（圖示）
* 檢視器：hls.js、libass（WebAssembly）、PDF.js、CodeMirror、docx-preview、SheetJS、pptx-preview

### Backend

* Node.js 24
* TypeScript
* Fastify
* WebSocket（`@fastify/websocket`）
* `node:sqlite`
* `worker_threads`（任務與縮圖各自的 worker）
* Zod
* sharp、MuPDF、ExifTool（縮圖與影像資訊）
* rclone（遠端位置與同步）
* jellyfin-ffmpeg（影片轉檔、媒體資訊、縮圖）

### Container

* Single Docker image，`linux/amd64` 與 `linux/arm64`
* Single `docker run`
* Mount `/data`
* Mount `/app-data`
* 映像檔內建 rclone 與 jellyfin-ffmpeg，不需要另外安裝

## 5. 部署方式

目標部署方式：

```bash
docker run -d \
  --name kago \
  -p 8080:8080 \
  -v /volume1/files:/data \
  -v /volume1/docker/kago:/app-data \
  -e PUID=1000 \
  -e PGID=1000 \
  --restart unless-stopped \
  ghcr.io/gnehs/kago:latest
```

`/data` 是使用者要管理的 NAS 檔案資料夾。它底下的每個資料夾各自成為一個位置；直接放在 `/data` 根目錄的檔案不會顯示。

`/app-data` 是 Kago 自己的資料目錄，所有狀態都在這裡，重建 container 不會遺失資料。

```txt
/app-data
  app.db            SQLite 資料庫
  session.secret    簽署 session 的密鑰（未提供 SESSION_SECRET 時自動產生）
  storage.key       加密遠端位置連線設定、單一登入 secret 等的金鑰
  trash/            本機位置的垃圾桶
  thumbnails/
  previews/
  temp/             zip 下載、轉檔暫存
  logs/
  ssh/              Kago 自己的 SSH 金鑰，用來登入 SFTP 位置
  rclone/
  app-icons/        應用程式捷徑的圖示
  avatars/
  wallpapers/
```

container 以 root 啟動，調整好 `/app-data` 的擁有者後降權成 `PUID:PGID` 執行（沿用 linuxserver.io 的慣例）。`/data` 不會被 chown。

環境變數：

```txt
PUID / PGID                     執行 Kago 的 UID / GID，預設 1000
UMASK                           新檔案與資料夾的 umask，預設 022
PORT                            container 內監聽的 port，預設 8080
ADMIN_EMAIL / ADMIN_PASSWORD    第一次啟動時自動建立管理員，兩者必須一起提供
SESSION_SECRET                  未提供時自動產生並存進 /app-data/session.secret
TRUST_PROXY                     在反向代理後面時設定；沒有反向代理時不要設
TRANSCODE_HWACCEL               auto、nvenc、vaapi 或 none，預設 auto
TRANSCODE_VAAPI_DEVICE          VAAPI 使用的 render node
FFMPEG_PATH / FFPROBE_PATH      改用其他 ffmpeg 執行檔
TZ                              同步排程使用的時區
DATA_DIR / APP_DATA_DIR         映像檔內已設為 /data 與 /app-data
```

Kago 本身只提供 HTTP。從外網存取時放在反向代理後面並啟用 HTTPS，代理要開啟 WebSocket（`/ws`）並放寬上傳大小限制。

## 6. 高階架構

```txt
Kago container
  ├─ React + Vite static frontend
  ├─ Node.js Fastify API server
  ├─ WebSocket event server（/ws）
  ├─ Worker manager
  ├─ SQLite database via node:sqlite
  ├─ Task worker（worker thread）
  │   ├─ copy
  │   ├─ move
  │   ├─ delete-to-trash
  │   ├─ restore-trash
  │   ├─ compress
  │   ├─ download-zip
  │   ├─ extract
  │   ├─ sync
  │   └─ thumbnail
  ├─ Thumbnail worker（worker thread）
  ├─ Sync scheduler
  ├─ rclone daemon（遠端位置）
  ├─ ffmpeg / ffprobe（轉檔、媒體資訊）
  ├─ /data
  └─ /app-data
```

前端不是任務執行者。

前端建立任務後可以關閉。任務必須繼續在後端 worker 執行。

## 7. 專案目錄

```txt
kago/
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  Dockerfile
  README.md / README.zh.md
  DESIGN.md
  requirements.md
  docker/
  docs/
  scripts/

  apps/
    web/
      index.html
      vite.config.ts
      src/
        main.tsx
        App.tsx
        styles.css
        api/
        components/
          ui/              基礎表單元件
          kago/            包裝 Base UI 的 Kago 元件
        features/
          workspace/
          windows/
          files/
          tasks/
          shelves/
          shares/
          permissions/
          tags/
          trash/
          sync/
          apps/
          auth/
          admin/
          about/
        stores/
        lib/
        locales/
        types/

    server/
      src/
        main.ts
        app.ts             所有 HTTP 路由都在這裡
        recover.ts         管理員進不來時在主機上執行的救援指令

        config/
          env.ts

        db/
          db.ts            開啟資料庫與升級舊資料
          schema.sql

        services/
          auth.service.ts
          oidc.service.ts
          path.service.ts
          permission.service.ts
          root.service.ts
          storage.service.ts
          fs.service.ts
          media.service.ts
          image.service.ts
          task.service.ts
          sync.service.ts
          shelf.service.ts
          tag.service.ts
          share.service.ts
          audit.service.ts
          workspace.service.ts
          preference.service.ts
          group.service.ts
          external-app.service.ts
          icon-library.service.ts
          archive-password.service.ts

        storage/           遠端位置：rclone daemon 與 client

        workers/
          worker-manager.ts
          task-worker.ts
          thumbnail-worker.ts

        ws/
          events.ts

        lib/

      test/
```

各種任務沒有各自的 job 檔案，都實作在 `task.service.ts`，由 task worker 執行。

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

檔案視窗的 root、path、位置、大小、分頁都由 Workspace state 決定，不由 URL 決定。

### 保留路由

```txt
/
/login
/_kago/tasks
/_kago/shares
/_kago/trash
/_kago/settings
/_kago/account
/_kago/apps
/_kago/sync
/_kago/about
/_kago/admin/locations
/_kago/admin/users
/_kago/admin/groups
/_kago/admin/sso
/_kago/admin/permissions
/_kago/audit
/_kago/play
/s/:token
/api/*
/ws
```

主 Workspace 使用：

```txt
/
```

登入後進入 `/`，Kago 會還原使用者上次的 Workspace。

沒有整頁切換。`/_kago/*` 不是頁面：造訪它會在桌面上開啟對應的應用程式視窗，然後回到 `/`，所以它們仍然可以當作深層連結。唯一的例外是 `/_kago/play`，它在新的瀏覽器分頁裡以整頁開啟影片播放器。

`/login?local=1` 永遠顯示密碼登入表單，即使單一登入設成自動導向。

`/s/:token` 是公開分享頁，不需要登入。

## 9. Workspace 核心概念

Kago 是 browser 裡的 NAS desktop workspace。

```txt
Kago Workspace
  ├─ TopBar
  ├─ Desktop icons
  ├─ Window Manager
  ├─ File Windows
  │    ├─ Tabs
  │    ├─ Sidebar（資料夾樹）
  │    └─ Inspector
  ├─ App Windows（設定、任務、分享、垃圾桶）
  ├─ Preview Windows（影片、音樂、圖片、文件）
  ├─ Floating Shelf
  ├─ Task popover
  └─ Context Menus
```

使用者登入 Kago 後，系統必須還原該使用者上次離開時的 Workspace。

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
每個視窗的分頁與目前的分頁
每個視窗的側邊欄與 Inspector 是否開著
active window
中轉區 UI 狀態
```

只有檔案視窗會存進 Workspace 並在下次登入還原；應用程式視窗與預覽視窗不會。

檢視方式與排序不屬於視窗，屬於資料夾（見 §11 的 `folder_views`）：同一個資料夾不論在哪個視窗開，都是同一個樣子。

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

  selectedItems: string[];
  scrollTop?: number;

  inspectorOpen?: boolean;
  sidebarOpen?: boolean;

  tabs?: FileTab[];
  activeTabId?: string;

  createdAt: number;
  updatedAt: number;
};

type FileTab = { id: string; rootSlug: string; logicalPath: string };
```

`tabs` 是這個視窗開著的所有資料夾；`activeTabId` 指的那一個，就是 `rootSlug` 與 `logicalPath` 描述的那一個。

資料夾的樣子另外存：

```ts
type FolderView = {
  viewMode: "list" | "grid" | "columns";
  iconSize: "large" | "medium" | "small";
  sortBy: "name" | "size" | "mtime" | "type";
  sortDirection: "asc" | "desc";
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
  "selectedItems": [],
  "inspectorOpen": false,
  "sidebarOpen": true,
  "tabs": [
    { "id": "tab_1", "rootSlug": "photos", "logicalPath": "/2026/japan" },
    { "id": "tab_2", "rootSlug": "videos", "logicalPath": "/" }
  ],
  "activeTabId": "tab_1"
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

`windows_json` 存所有開啟中的 FileWindow，包含各自的分頁、側邊欄與 Inspector 是否開著。

`active_window_id` 存目前聚焦視窗。

`sidebar_json`、`inspector_json`、`shelf_json` 是工作區層級的 UI 狀態，後端不規定內容，只要求是物件：

```txt
inspector：寬度
shelf：是否收合、浮動位置
```

不屬於 Workspace、但同樣跟著帳號走的狀態另外存：

```txt
folder_views    每個資料夾的檢視方式、圖示大小、排序，可套用到子資料夾
user_settings   語言、主題等個人設定
```

所以換一個瀏覽器登入，看到的還是同一個樣子。

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
      "focused": true,
      "selectedItems": [],
      "sidebarOpen": true
    }
  ],
  "sidebar": {
    "collapsed": false
  },
  "inspector": {
    "open": false,
    "width": 320
  },
  "shelf": {
    "collapsed": false
  }
}
```

還沒有存過 workspace 的使用者得到空的 `windows` 與上面這組預設值。

### PUT /api/workspace

儲存目前使用者的 workspace。

```http
PUT /api/workspace
```

後端必須驗證：

```txt
windows 必須是 array，最多 12 個
window id 不可重複
activeWindowId 必須是其中一個視窗
rootSlug 必須存在
logicalPath 必須是安全邏輯路徑
x：-200 到 10000，y：0 到 10000
width：360 到 4000，height：280 到 3000
zIndex：0 到 1000000
title 最長 160 字
每個視窗最多 12 個分頁
```

儲存時不檢查資料夾是否存在。

FileWindow render 時再處理 404 / 403。

### 資料夾的檢視方式

```txt
GET    /api/settings        個人設定，連同這個人設定過的所有資料夾檢視方式
PATCH  /api/settings
PUT    /api/folder-views
DELETE /api/folder-views
```

## 13. 啟動流程

使用者開啟 Kago：

```txt
GET /
  ↓
Fastify 回傳 React app
  ↓
GET /api/auth/setup
  ↓
還沒有任何帳號：顯示初始化頁面，建立第一位管理員
  ↓
GET /api/auth/me
  ↓
未登入：顯示登入頁（或依設定導向單一登入的提供者）
  ↓
GET /api/workspace
  ↓
還原所有 FileWindow
  ↓
每個 FileWindow 各自呼叫 /api/fs/list
```

提供了 `ADMIN_EMAIL` 與 `ADMIN_PASSWORD` 時，第一次啟動會自動建立管理員，略過初始化頁面。

如果使用者沒有 workspace：

```txt
顯示沒有視窗的桌面
桌面上有「檔案」「分享」「垃圾桶」圖示與應用程式捷徑
點「檔案」開啟第一個本機位置的 FileWindow
```

沒有 root picker。要去哪個位置，在視窗左側的資料夾樹裡選，或用快速開啟（⌘K）。

不要自動假設某個位置一定要打開。

使用者一個位置都看不到時（`/data` 底下沒有資料夾，或沒有任何權限規則），桌面上沒有「檔案」圖示，並說明原因。

## 14. Workspace 自動儲存

前端必須 debounce 儲存 workspace。

```txt
視窗開關：立即儲存
資料夾路徑改變：立即儲存
視窗移動、縮放：debounce 1000ms
active window 改變：debounce 300ms
其他改變（分頁、側邊欄、Inspector、中轉區）：debounce 700ms
```

避免每次 mousemove 都打 API。

儲存後後端會送出 `workspace.updated`，同一個帳號開著的其他分頁收到後重新讀取。

## 15. 視窗還原錯誤處理

如果 workspace 中某個 FileWindow 的 root 不存在：

```txt
該視窗顯示「找不到位置」
不要自動刪除視窗
提供 Close window
```

如果 path 不存在：

```txt
該視窗顯示「找不到資料夾」
提供「回到最上層」
提供 Close window
```

如果沒有權限：

```txt
該視窗顯示「沒有存取權」
清除 selectedItems
不要顯示舊快取資料
列出管理員的名字與 Email
提供「用 Email 請求存取」（開啟 mailto:）與 Close window
```

其他錯誤：

```txt
顯示錯誤訊息
提供 Retry 與 Close window
```

如果 root readonly：

```txt
視窗仍可顯示
所有寫入操作 disabled
```

## 16. Window Manager

Window Manager 支援：

```txt
建立新視窗
關閉視窗
聚焦視窗
拖曳移動視窗
調整視窗大小
視窗 z-index 管理
最小化（縮進頂部列上自己的那顆按鈕）
最大化
還原
雙擊標題列最大化 / 還原
限制視窗不能完全拖出畫布
視窗標題顯示目前資料夾名稱
一個視窗多個分頁
點頂部列的 Kago 顯示桌面，再點一下還原所有視窗
```

同一套 Window Manager 也管理應用程式視窗（設定、任務、分享、垃圾桶，每種只會開一個）與預覽視窗。

沒有做：

```txt
視窗吸附邊緣
左右分割
四角吸附
多視窗排列
記住每個 root 的預設視窗大小
```

視窗數量限制：

```txt
單一使用者最多 12 個開啟的檔案視窗
單一視窗最多 12 個分頁
單一視窗最小寬度 360px
單一視窗最小高度 280px
```

超過限制時，UI 顯示：

```txt
已達視窗數量上限
```

窄螢幕（寬度不到 640px）放不下並排的視窗：每個視窗都填滿桌面，不能拖動也不能縮放。這不記成最大化，同一個 workspace 回到寬螢幕還是原來的位置與大小。

## 17. 開新視窗行為

以下操作可以建立 FileWindow：

```txt
桌面的「檔案」圖示（一個檔案視窗都沒開時）
⌘ 點擊、中鍵點擊「檔案」圖示，或它右鍵選單的「在新視窗開啟」
「檔案」圖示右鍵選單裡列出的每個位置
資料夾或側邊欄項目右鍵 Open in New Window
Cmd/Ctrl + N、Alt + N
Cmd/Ctrl + Enter（選取的是資料夾時）
快速開啟（⌘K）選擇位置或最近去過的資料夾
```

以下操作在同一個視窗裡開新分頁：

```txt
標題列尾端的「＋」
Alt + T
資料夾右鍵 Open in New Tab
中鍵點擊資料夾
⌘ 點擊或中鍵點擊側邊欄的資料夾
```

預設行為：

```txt
雙擊資料夾
  => 在目前 active window 內進入資料夾

點側邊欄資料夾樹裡的資料夾
  => 把這個視窗帶到那個資料夾，可以跨位置

點桌面的「檔案」圖示
  => 如果已有檔案視窗，聚焦最前面的那一個
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

拖放的目的地可以是：

```txt
另一個視窗目前的資料夾
清單裡的某個資料夾
側邊欄資料夾樹裡的資料夾（可以跨位置，停留一下會自動展開）
```

放開後在放開處顯示一份選單：

```txt
複製到這裡
搬移到這裡
取消
```

預設選在複製上（不會弄丟東西的那一個）。不要自動猜使用者是要 copy 還是 move。

唯讀的位置不接受拖放。把項目拖到它原本所在的資料夾、或把資料夾拖到自己身上，不做任何事。

同樣的事也可以用剪貼簿完成：Cmd/Ctrl + C 或 X 記下選取的項目，到目的地按 Cmd/Ctrl + V 建立 copy 或 move task。

從瀏覽器外面拖進來的檔案或資料夾是上傳，不是 task。

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
WebSocket 是唯一的同步來源
一個分頁改了 workspace、設定、中轉區，其他分頁收到事件後重新向 API 讀取
```

不使用 BroadcastChannel。

Workspace state 的真實來源仍是後端 SQLite。

## 23. 拖移到桌面

拖移到桌面不是核心功能，沒有做。

下載：

```txt
單一檔案：GET /api/fs/download
資料夾或多個項目：打包成一個 zip
  即時串流：GET /api/fs/download-zip
  或建立 download_zip task，完成後從 GET /api/tasks/:id/download 取回
```

zip 成品放在 `/app-data/temp/downloads`，不寫進使用者的資料夾，一天內沒有人取走就刪除。

後續可做：

```txt
Chrome-only DownloadURL experimental support
File System Access API 寫入使用者授權資料夾
macOS helper 提供真正 Finder-like 行為
```

## 24. Root model

位置（root）有兩種：

```txt
本機位置   /data 底下的第一層資料夾。Kago 自己發現它們，管理員不需要建立
遠端位置   SMB、SFTP、WebDAV、FTP 上的資料夾，由管理員在「設定 → 位置」新增
```

`roots` 必須有 `slug` 欄位。

```sql
CREATE TABLE roots (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'local',
  config TEXT,
  readonly INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`provider` 是 `local` 或遠端的種類。`config` 只有遠端位置有：整份連線設定以 `storage.key` 加密後存放，已存的密碼不會送回瀏覽器。遠端位置的 `base_path` 是空的。

slug 規則：

```txt
只能使用 a-z、0-9、-、_
不可為空
不可包含 /
不可使用保留字
由名稱自動產生；名稱裡沒有 ASCII 字母時（例如中文）改用穩定的雜湊（folder-48e9e532）
與既有的 slug 或保留字相同時，在後面加上 -2、-3…
建立後不會修改，改名不影響 slug、權限與分享連結
```

範例：

```txt
photos
downloads
home
movies
backup
```

管理員可以做的事：

```txt
改位置的顯示名稱
把位置設為唯讀
新增、修改、移除遠端位置（儲存前可以先測試連線）
```

移除遠端位置只移除 Kago 裡的紀錄，檔案留在原處；指向它的分享連結、權限規則與標籤會一併移除。

位置在介面上與在分享、權限裡不分本機與遠端，只有本機位置才有的東西（Finder 標籤）在遠端位置不出現。

「設定 → 位置」會標出最上層資料夾就讀不到或寫不進去的本機位置，並顯示 Kago 實際使用的 UID 與 GID。

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

設計上的決定記在 `DESIGN.md`；實際數值以 `apps/web/src/styles.css` 為唯一來源。這裡只列大原則。

Kago UI 使用：

```txt
React
Vite
Tailwind CSS
Base UI
TanStack Query
Zustand
```

UI 方針：

```txt
Base UI 作為低階 accessible primitives
Tailwind 作為 styling layer
基礎元件由專案自己持有與修改，不安裝現成的元件庫
不要做成一般後台模板
不要直接依賴大型預設主題
```

元件分三層：

```txt
components/ui/     Button、Input、Select、Field、Checkbox 等基礎表單元件
components/kago/   包裝 Base UI 的 Kago 元件，以及不只一個功能會用到的東西
features/          依功能分資料夾，每個畫面一個檔案
```

Base UI primitive 不應到處直接散落在 feature code 中，應包成 Kago 自己的 design system component。

例如：

```txt
KagoContextMenu
KagoDropdownMenu
KagoDialog
KagoPopover
KagoTooltip
KagoIconButton
KagoSegmented
KagoWindow
KagoStatusBar
KagoToaster
KagoEmptyState
```

規則：

```txt
只有圖示的按鈕一律用 KagoIconButton，它同時提供 tooltip 與無障礙名稱
需要使用者輸入或確認時用 Kago 自己的對話框，不用瀏覽器的 prompt() / confirm()
操作失敗一律用 toast 告知，不讓錯誤靜默消失
每個清單都要有載入中與空狀態
檔案操作只有一份選單，右鍵與工具列的「⋯」開的是同一份
```

## 27. Tailwind 設計規則

使用 Tailwind CSS 與 CSS variables 建立 design tokens。

所有顏色、圓角、密度都定義成 `--kago-*` CSS 變數，再透過 Tailwind `@theme` 對應成語意名稱：

```css
:root {
  --kago-bg: ;                 /* canvas */
  --kago-surface: ;            /* surface */
  --kago-surface-elevated: ;   /* elevated */
  --kago-border: ;             /* line */
  --kago-border-strong: ;      /* line-strong */
  --kago-text: ;               /* ink */
  --kago-text-muted: ;         /* muted */
  --kago-text-faint: ;         /* faint */
  --kago-accent: ;             /* accent */
  --kago-hover: ;              /* hover */
  --kago-danger: ;
  --kago-warning: ;
  --kago-success: ;
  --kago-folder: ;             /* 資料夾圖示、桌面上的位置 */
  --kago-kind-image: ;         /* 檔案圖示依種類上色：image、video、audio、archive、document、sheet、slides、code */
}
```

圓角：`sm` 5px、`md` 7px、`lg` 12px。列高 32px、控制項高度 30px、字級 13px，不提供密度切換。

介面由幾種「材質」做成（凸起、凹下、玻璃…），每種材質是一組背景與陰影的變數加上一個 class；元件挑一種來用，不自己寫漸層或陰影。

需求：

```txt
淺色為預設，深色跟隨系統或由使用者切換，兩種主題都必須可用
不載入網路字體，使用各平台的系統字體（libass 繪製字幕用的 Noto Sans 是唯一例外）
動畫都在 200ms 以內，尊重 prefers-reduced-motion，也可以在設定裡整個關掉
窄螢幕（寬度不到 640px）可用
```

不要把顏色寫死在大量 component 裡。

顏色要集中在 CSS variables 與 Tailwind theme。

## 28. UI 主要區塊

```txt
TopBar（唯一的常駐外框）
  - Kago（顯示桌面 / 還原所有視窗）
  - 開啟中的視窗
  - 快速開啟（⌘K）
  - 任務狀態與最近任務的面板
  - 帳號選單（帳號、設定、關於、登出）

Desktop
  - 桌面背景
  - 圖示：檔案、分享、垃圾桶
  - 應用程式捷徑（其他服務的網址）
  - FileWindow
  - App window
  - Preview window
  - Floating Shelf
  - Context Menus

FileWindow
  - Title bar（控制鈕、名稱或分頁、＋）
  - Toolbar（側邊欄開關、上一頁 / 下一頁、路徑列、篩選、檢視方式、⋯）
  - Sidebar（資料夾樹，最上層是所有位置）
  - File list / File grid / Columns
  - Context menu
  - Multi-select
  - Drag selection
  - Status bar

Inspector（每個檔案視窗各自開關）
  - 圖示、名稱、種類與大小
  - 一般
  - 拍攝資訊 / 影片資訊
  - 標籤（Finder 與 Kago）
  - 分享連結

App windows（每種只會開一個）
  - 任務：queued / running / paused / failed / done，進度、取消、重試、清除已完成
  - 分享：所有分享連結
  - 垃圾桶：還原、清空
  - 設定
      個人：一般、帳號、應用程式、同步
      管理：位置、使用者、群組、單一登入、權限、稽核紀錄
      Kago：關於

Preview windows
  - 影片、音樂、圖片、文字與程式碼、Markdown、PDF、Office、SQLite 資料庫
```

桌面本身沒有側欄。桌面圖示是「要去的地方」，頂部列是系統狀態。

視覺方向：

```txt
像 Finder 一樣直覺
像 NAS File Station 一樣完整
像 Dropover 一樣有中轉區
像現代設計工具一樣細緻
```

## 29. Keyboard shortcuts

```txt
Cmd/Ctrl + K、Cmd/Ctrl + P:
  快速開啟：位置、最近去過的資料夾、應用程式捷徑、Kago 的每個視窗與設定頁

Cmd/Ctrl + N:
  開新檔案視窗，預設開啟目前 active window 的 root/path

Cmd/Ctrl + W:
  關閉 active window；視窗有多個分頁時先關目前的分頁

Alt + N / Alt + W:
  同 Cmd/Ctrl + N、Cmd/Ctrl + W。一般瀏覽器分頁會攔走 Cmd/Ctrl + N 與 Cmd/Ctrl + W，
  所以這兩組才是分頁內實際可用的快捷鍵

Alt + T:
  在 active window 開新分頁

Cmd/Ctrl + L:
  聚焦 active window 的 breadcrumb / address bar

Cmd/Ctrl + R:
  refresh active window file list

Cmd/Ctrl + I:
  開關 active window 的 Inspector

Cmd/Ctrl + C / X / V:
  複製、剪下選取的項目，貼到目前的資料夾

Arrow keys:
  在 active window 中移動選取；直欄檢視與樹狀清單裡，左右是進出資料夾

Enter:
  開啟資料夾或預覽檔案

Cmd/Ctrl + Enter:
  在新視窗開啟選取的資料夾

Backspace:
  回上一層

Cmd/Ctrl + A:
  active window 全選

Esc:
  清除 active window 選取、關閉 context menu，或關閉作用中的預覽視窗
```

快捷鍵只作用於 active window。對話框與選單開著時，鍵盤屬於它們；游標在輸入框裡時，快捷鍵不作用。

## 30. 視窗層級

Window Manager 必須統一管理 z-index。

```txt
檔案視窗、應用程式視窗、預覽視窗: 100-499
Shelf: 600
任務彈出面板: 700
Context menu: 800
Dialog: 900
Toast、Tooltip: 1000
```

桌面圖示在所有視窗底下。

Context menu、Dialog、Popover 不應被 FileWindow 擋住。

## 31. 資料庫初始化

使用 Node.js 內建 `node:sqlite`。

啟動時：

```txt
確認 /data 與 /app-data 存在，建立 /app-data 底下的子目錄
初始化 SQLite
啟用 WAL
啟用 foreign_keys
設定 busy_timeout
執行 schema.sql（全部是 CREATE … IF NOT EXISTS）
升級舊資料庫：補上後來新增的欄位，轉換舊格式的資料
將上次 running task 標成 interrupted
把 /data 底下的資料夾對應成本機位置
啟動 task worker
啟動同步排程
啟動 HTTP / WebSocket server
```

沒有 migrations 目錄，也沒有版本號。升級寫在 `db/db.ts`：每一步先看資料庫現在的樣子（有沒有某個欄位）再決定要不要做，所以重複執行是安全的。task worker 會在同一時間開啟同一個資料庫，升級必須容許對方已經先做完。

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

以下與 `apps/server/src/db/schema.sql` 一致，那個檔案才是唯一來源。

### users

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'USER',
  disabled INTEGER NOT NULL DEFAULT 0,
  avatar_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

`role`：

```txt
ADMIN   可以存取所有位置，並管理位置、使用者、群組、單一登入、權限與稽核紀錄
USER    只能進入有權限規則的位置
```

曾經有過 `GUEST` 角色，但它能做的事與 `USER` 完全相同，已經移除；升級時既有的 `GUEST` 帳號會改成 `USER`。單一登入自動建立的帳號一律是 `USER`。

`avatar_at` 是頭貼上次設定的時間，沒有頭貼時是 NULL。

### sessions

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  identity_id TEXT,
  oidc_refresh TEXT,
  oidc_checked_at INTEGER,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

`identity_id`、`oidc_refresh`、`oidc_checked_at` 只有透過單一登入開始的 session 才有：是哪個身分、加密過的 refresh token、上次向提供者確認的時間。

### user_identities

單一登入綁定的身分。綁定之後認人只看 `issuer + subject`。

```sql
CREATE TABLE user_identities (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  display_name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER,
  UNIQUE (issuer, subject),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_identities_user
ON user_identities(user_id);
```

### app_settings

整個伺服器的設定（例如單一登入）。

```sql
CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
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
  source TEXT,
  PRIMARY KEY (group_id, user_id),
  FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

`group_members.source` 是 `oidc` 時，表示這個成員資格是提供者的群組帶來的，也可以被它收回；手動加入的是 NULL。

### roots

```sql
CREATE TABLE roots (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  base_path TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'local',
  config TEXT,
  readonly INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

見 §24。

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
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

### user_settings 與 folder_views

```sql
CREATE TABLE user_settings (
  user_id TEXT PRIMARY KEY,
  settings_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE folder_views (
  user_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  view_mode TEXT,
  auto_mode TEXT,
  icon_size TEXT,
  sort_by TEXT,
  sort_direction TEXT,
  recursive INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, root_id, path),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
);
```

`folder_views.recursive` 為 1 時，這個資料夾的檢視方式也套用到它底下還沒有自己設定的資料夾。

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
  finished_at INTEGER,
  cleared INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_tasks_status_created
ON tasks(status, created_at);

CREATE TABLE task_reports (
  task_id TEXT PRIMARY KEY,
  summary_json TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  changes_json TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
```

Task types：

```txt
copy
move
compress
download_zip
extract
sync
delete_to_trash
restore_trash
thumbnail
```

Task statuses：

```txt
queued
running
paused
done
failed
cancelled
interrupted
```

`cleared` 為 1 的任務已經從任務清單清掉，只因為某筆同步工作還要從它讀上次的結果才留著。

`task_reports` 是任務留下的報告：同步做了什麼，或試跑會做什麼。

### shelves

```sql
CREATE TABLE shelves (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE shelf_items (
  id TEXT PRIMARY KEY,
  shelf_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER,
  added_at INTEGER NOT NULL,
  FOREIGN KEY (shelf_id) REFERENCES shelves(id) ON DELETE CASCADE,
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
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
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE file_tags (
  root_id TEXT NOT NULL,
  path TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (root_id, path, tag_id),
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
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
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE share_visits (
  share_id TEXT NOT NULL,
  visitor TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (share_id, visitor),
  FOREIGN KEY (share_id) REFERENCES share_links(id) ON DELETE CASCADE
);
```

`permission_json` 存分享模式。`share_visits` 記錄哪些訪客已經算過一次（見 §39）。

### trash_items

```sql
CREATE TABLE trash_items (
  id TEXT PRIMARY KEY,
  original_root_id TEXT NOT NULL,
  original_path TEXT NOT NULL,
  trash_path TEXT NOT NULL,
  deleted_by TEXT NOT NULL,
  deleted_at INTEGER NOT NULL,
  restored_at INTEGER,
  FOREIGN KEY (original_root_id) REFERENCES roots(id) ON DELETE CASCADE
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

CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);
```

### sync_jobs

```sql
CREATE TABLE sync_jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  source_json TEXT NOT NULL,
  destination_json TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '{}',
  schedule_json TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_run_at INTEGER,
  last_run_at INTEGER,
  last_task_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE sync_runs (
  task_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  error_message TEXT,
  dry_run INTEGER NOT NULL DEFAULT 0,
  scheduled INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  FOREIGN KEY (job_id) REFERENCES sync_jobs(id) ON DELETE CASCADE
);

CREATE INDEX idx_sync_runs_job_started
ON sync_runs(job_id, started_at);
```

見 §42。`sync_runs` 是每筆同步工作較早的執行結果，在它們的 task 被清掉之後仍然留著。

### external_apps

桌面上的應用程式捷徑。`owner_id` 是 NULL 的捷徑由管理員放到所有人的桌面上。

```sql
CREATE TABLE external_apps (
  id TEXT PRIMARY KEY,
  owner_id TEXT,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  icon_type TEXT,
  icon_version INTEGER,
  embed INTEGER NOT NULL DEFAULT 0,
  auth_user TEXT,
  auth_secret TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_external_apps_owner
ON external_apps(owner_id, created_at);

CREATE TABLE external_app_positions (
  user_id TEXT NOT NULL,
  app_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (user_id, app_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (app_id) REFERENCES external_apps(id) ON DELETE CASCADE
);
```

### archive_passwords

每個人存起來、解壓縮時會先試的密碼，加密存放。

```sql
CREATE TABLE archive_passwords (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  sealed TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_archive_passwords_user
ON archive_passwords(user_id, created_at);
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
download zip
extract
sync
thumbnail generation
```

前端送出：

```http
POST /api/tasks
```

`sync` 不從這裡建立，由同步工作建立（見 §42）。

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

進度更新必須節流，避免 SQLite 寫入過度頻繁。

使用者可以對自己的任務做的事：

```txt
cancel    取消 queued、paused 或 running 的任務；取消中的複製會把沒寫完的目的地一起清掉
pause     只有 queued 的任務可以暫停
resume    把 paused 的任務放回佇列
retry     failed、cancelled、interrupted 的任務可以重試，重試是一個新的任務
clear     把已經結束的任務從清單清掉
```

執行中的任務不能暫停，也不支援續傳。

container 啟動時，所有 `running` task 必須標成 `interrupted`。

任務只屬於建立它的人；ADMIN 看得到所有人的。

壓縮可以選壓縮密度（store、fast、normal、best）與密碼（AES-256 或 ZipCrypto）。解壓縮加密的 zip 時，先試這個人在設定裡存的密碼（`archive_passwords`，加密存放），都打不開才問。

需要留下結果的任務（同步、試跑）把報告存進 `task_reports`。

## 37. Worker 行為

任務由一個 task worker（worker thread）執行，縮圖另外有自己的 worker，都不佔用處理 HTTP 的主執行緒。

worker 執行前必須：

```txt
讀取 task
重新 resolve safe path
重新檢查權限
檢查 root readonly
寫 audit log
開始執行
定期更新進度
送出 WebSocket event
```

worker crash 時：

```txt
不可讓整個 server crash
task 標成 failed 或 interrupted
寫 audit log
worker manager 可重啟 worker，但要有 backoff，避免無限重啟
```

碰到遠端位置的搬移、複製與同步交給 rclone 執行，worker 負責權限檢查、進度與取消。

磁碟拒絕存取時（`EACCES`、`EPERM`、`EROFS`），任務回報的是「執行 Kago 的系統帳號沒有這個權限」，而不是未預期的錯誤；被拒絕的路徑與 UID、GID 只寫進 log。

## 38. WebSocket

只使用 WebSocket（`/ws`），不使用 SSE。

前端開啟時要做的事：

```txt
GET /api/auth/setup
GET /api/auth/me
GET /api/workspace
GET /api/settings
GET /api/tasks
GET /api/shelves
connect WebSocket
還原 Workspace
每個 FileWindow 自己 fetch file list
```

事件格式：

```ts
type ServerEvent =
  | { type: "task.created"; userId: string; task: FileTask }
  | { type: "task.progress"; userId: string; taskId: string; patch: Partial<FileTask> }
  | { type: "task.done"; userId: string; taskId: string }
  | { type: "task.failed"; userId: string; taskId: string; error: string }
  | { type: "shelf.updated"; userId: string; shelfId: string }
  | { type: "workspace.updated"; userId: string }
  | { type: "settings.updated"; userId: string }
  | { type: "account.updated"; userId: string }
  | { type: "permission.updated"; userId?: string }
  | { type: "roots.updated" }
  | { type: "apps.updated"; userId?: string }
  | { type: "share.updated"; userId: string };
```

帶著 `userId` 的事件只送給那個人（以及 ADMIN，如果那是 ADMIN 看得到的東西）；別人的事件不會送到你的連線上。

連線必須：

```txt
檢查 Origin
帶著有效的 session
在 session 失效時中斷：登出、改密碼、帳號被停用
在角色改變時重新判斷能收到什麼
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

DB 只存 token hash，不存明文 token。token 只在建立時回傳一次。

可設定：

```txt
到期時間
密碼
最大下載次數
是否停用
分享模式
```

三種分享模式：

```txt
view_only     只能在瀏覽器裡看，不提供下載
download      可以下載
upload_only   讓別人上傳檔案
```

```txt
view_only 與 download 只能分享檔案
upload_only 只能分享資料夾
```

`upload_only` 適合做收件箱：

```txt
外部使用者只能上傳
不能列資料夾
不能下載既有檔案
不能刪除
不能重新命名
```

建立分享需要的權限：`view_only` 與 `download` 要位置的 `view`，`upload_only` 要 `edit`。

分享連結給出去的東西不會超過建立者現在能做的：

```txt
每次有人使用連結時，重新檢查建立者的權限
建立者失去那個位置的權限，連結就失效
建立者被停用，連結就失效
重新啟用一條停用的連結時也要重新檢查
```

最大下載次數算的是訪客而不是請求：同一個位址與瀏覽器在 12 小時內檢視與下載同一個檔案，只算一次（`share_visits`）。

連結的密碼猜錯太多次要等（見 §44）。

公開分享連結不得支援：

```txt
delete
rename
move
extract
sync
edit permissions
```

## 40. Trash

刪除預設必須進垃圾桶，不直接永久刪除。

垃圾桶的位置依位置的種類而定：

```txt
本機位置   /app-data/trash/
遠端位置   該位置裡的 .kago-trash 資料夾
```

遠端位置的 `.kago-trash` 不會被列出來，不能用路徑存取，也不參與同步。

沒有 `/data/.trash/` 這種放在同一個磁碟上的模式。

刪除時要記錄 trash_items。

必須支援 restore。還原與丟進垃圾桶一樣，需要那個位置的 `edit`。

清空垃圾桶是永久刪除：

```txt
一般使用者只清掉自己丟的
ADMIN 清掉所有人的
```

清空只刪除 Kago 自己的垃圾桶裡的東西，`trash_items` 記著的路徑不在那裡面就不碰。

## 41. Tags

有兩種標籤，在 Inspector 的同一區裡，以存放的地方區分：

```txt
Kago 標籤     只存在 Kago 的資料庫裡
Finder 標籤   存在檔案上，macOS Finder 也看得到
```

### Kago 標籤

```txt
標籤屬於建立它的人
別人看不到它，也不能把它貼到檔案上或撕下來，即使兩個人都能存取同一個檔案
讀取檔案的標籤需要 view，設定需要 edit
```

### Finder 標籤

```txt
只有本機位置有
以平台自己的工具讀寫檔案的 extended attribute（com.apple.metadata:_kMDItemUserTags）
隨檔案清單一起讀出來
寫入：PUT /api/fs/finder-tags，需要 edit
```

如果 xattr 讀寫失敗（磁碟不支援、工具不存在），不可以讓檔案管理功能失效：那只代表沒有標籤。

遠端位置不出現 Finder 標籤，而不是顯示成停用。

## 42. 同步

Kago 不提供 rsync。早期版本有 `rsync_pull` / `rsync_push` 兩種 task，同步也能以 rsync + SSH 連到另一台機器，這些都已經移除：SFTP 遠端位置透過 rclone 做得到同樣的事，而 rsync 是用伺服器唯一的那把 SSH 金鑰登入，等於讓能用它的人碰得到那把金鑰打得開的所有地方。映像檔不再安裝 rsync 與 openssh-client。升級時，有一端是 rsync 的同步工作、它們的執行紀錄與 task 會在伺服器啟動時刪除。

取而代之的是「同步」：把一個位置裡的資料夾帶到另一個位置裡的資料夾。

### 兩端都是位置

```txt
同步的兩端只能是 root 裡的資料夾，本機或遠端皆可
要與另一台機器同步，先把它加成遠端位置（SMB、SFTP、WebDAV、FTP）
同步本身不接受主機、帳號或密碼
```

```json
{ "kind": "location", "rootSlug": "photos", "path": "/2026" }
```

連線資訊屬於遠端位置，不屬於同步。整份連線設定加密後存進 `roots.config`，密碼不會送回瀏覽器。SFTP 也可以用 Kago 自己的 SSH 金鑰（`/app-data/ssh/id_ed25519`，第一次用到時產生），公鑰只有 ADMIN 讀得到。

### 同步工作

一筆同步工作是「從哪裡、到哪裡、做什麼、何時」：

```json
{
  "name": "照片備份",
  "source": { "kind": "location", "rootSlug": "photos", "path": "/" },
  "destination": { "kind": "location", "rootSlug": "backup", "path": "/photos" },
  "options": { "mode": "copy", "dryRun": false },
  "schedule": { "kind": "daily", "time": "03:00" },
  "enabled": true
}
```

`options.mode`：

```txt
copy     複製新增與變更過的檔案，不刪除目的地的任何東西
mirror   讓目的地與來源完全一致，會刪除來源已經沒有的項目
```

`options.dryRun` 為 true 時是試跑：不變更任何東西，只留下一份「會變更什麼」的報告。

`schedule`：

```txt
null                               只手動執行
{ kind: "interval", minutes }      每隔一段時間，5 分鐘到 30 天
{ kind: "daily", time }            每天，HH:MM
{ kind: "weekly", weekday, time }  每週，weekday 0–6
```

時間以伺服器的時區為準，由 `TZ` 環境變數決定。

### 執行

```txt
每一次執行都是一個 type 為 sync 的 task，進度、取消與結果都在任務清單裡
由映像檔內建的 rclone 執行，全程在使用者空間，不需要掛載
同一筆同步工作同時只會有一次執行
來源與目的地不能是同一個 root 裡互相包含的資料夾
遠端位置的垃圾桶資料夾不參與同步
每筆同步工作保留最近 20 次執行的結果
```

### 權限

```txt
來源所在的位置：view
目的地所在的位置：edit
儲存同步工作時就檢查，不等到執行時才失敗
每次執行前重新檢查
```

每個人管理自己的同步工作，ADMIN 看得到所有人的。

排程的執行以建立者的身分進行。建立者被停用或失去權限時，那一次執行會略過，並寫進 audit log。

### API

```txt
GET    /api/sync-jobs
POST   /api/sync-jobs
PUT    /api/sync-jobs/:id
DELETE /api/sync-jobs/:id
POST   /api/sync-jobs/:id/run
GET    /api/sync-jobs/:id/runs
GET    /api/sync-jobs/:id/trial
```

## 43. API 規格

所有路由都實作在 `apps/server/src/app.ts`，輸入一律以 Zod 驗證。除了登入、初始化與公開分享（`/s/*`）以外都需要登入；標示「ADMIN」的只有管理員能呼叫。

`/api` 與 `/s` 底下 GET 以外的請求必須帶 `x-kago-csrf: 1` 標頭。

### Auth

```txt
GET    /api/auth/setup              是否還需要建立第一位管理員，以及單一登入的公開資訊
POST   /api/auth/setup
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me
POST   /api/auth/password           改自己的密碼
GET    /api/admins                  管理員的名字與 Email，給「請求存取」用
```

### Single sign-on

```txt
GET    /api/auth/oidc/start
GET    /api/auth/oidc/callback
POST   /api/auth/oidc/link          把一個身分綁到目前登入的帳號
GET    /api/auth/identities
DELETE /api/auth/identities/:id
GET    /api/sso                     ADMIN
PUT    /api/sso                     ADMIN
POST   /api/sso/test                ADMIN
```

### Workspace 與個人設定

```txt
GET    /api/workspace
PUT    /api/workspace
GET    /api/settings
PATCH  /api/settings
PUT    /api/folder-views
DELETE /api/folder-views
GET    /api/wallpaper
POST   /api/wallpaper
DELETE /api/wallpaper
GET    /api/users/:id/avatar
POST   /api/avatar
DELETE /api/avatar
GET    /api/archive-passwords
POST   /api/archive-passwords
DELETE /api/archive-passwords/:id
```

### Files

```txt
GET    /api/fs/list?rootSlug=photos&path=/Japan
GET    /api/fs/meta?rootSlug=photos&path=/Japan/a.jpg
GET    /api/fs/download?rootSlug=photos&path=/Japan/a.jpg
GET    /api/fs/download-zip
GET    /api/fs/preview?rootSlug=photos&path=/Japan/a.jpg
GET    /api/fs/thumbnail?rootSlug=photos&path=/Japan/a.jpg
GET    /api/fs/image                 瀏覽器畫不出來的圖片（HEIF、相機 RAW…）轉出來的版本
GET    /api/fs/exif
GET    /api/fs/sqlite
GET    /api/fs/sqlite/rows
PUT    /api/fs/content               儲存文字檔
PUT    /api/fs/finder-tags
POST   /api/fs/upload
POST   /api/fs/mkdir
POST   /api/fs/rename
```

### Media

```txt
GET    /api/media/info
GET    /api/media/subtitles
GET    /api/media/subtitle
GET    /api/media/attachment         影片附帶的字型
GET    /api/media/cover
GET    /api/media/audio
POST   /api/media/sessions           開始一段轉檔
GET    /api/media/sessions/:id/:file HLS 的播放清單與片段
DELETE /api/media/sessions/:id
```

### Tasks

```txt
POST   /api/tasks
GET    /api/tasks
DELETE /api/tasks                    清除已經結束的任務
GET    /api/tasks/:id
GET    /api/tasks/:id/download       download_zip 任務的成品
POST   /api/tasks/:id/cancel
POST   /api/tasks/:id/retry
POST   /api/tasks/:id/pause
POST   /api/tasks/:id/resume
```

### Trash

```txt
GET    /api/trash
DELETE /api/trash                    清空
POST   /api/trash/:id/restore
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
GET    /api/tags/file?rootSlug=photos&path=/Japan/a.jpg
PUT    /api/tags/file
GET    /api/tags
POST   /api/tags
```

### Users

```txt
GET    /api/users                           ADMIN
POST   /api/users                           ADMIN
PATCH  /api/users/:id                       ADMIN
POST   /api/users/:id/password              ADMIN
DELETE /api/users/:id/identities/:identityId ADMIN
```

### Groups

```txt
GET    /api/groups                          ADMIN
POST   /api/groups                          ADMIN
POST   /api/groups/:id/members              ADMIN
DELETE /api/groups/:id/members/:userId      ADMIN
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

### Roots 與遠端位置

```txt
GET    /api/roots                   目前使用者看得到的位置
PATCH  /api/roots/:id               ADMIN：名稱、唯讀
GET    /api/storage                 ADMIN：各位置的種類、位址與磁碟狀態
POST   /api/storage/test            ADMIN：測試遠端連線
GET    /api/storage/ssh-key         ADMIN：Kago 的 SSH 公鑰
POST   /api/roots/remote            ADMIN
PUT    /api/roots/:id/remote        ADMIN
DELETE /api/roots/:id               ADMIN：只能移除遠端位置
```

### Sync

見 §42。

### 應用程式捷徑

```txt
GET    /api/external-apps
POST   /api/external-apps
PUT    /api/external-apps/order
PUT    /api/external-apps/:id
DELETE /api/external-apps/:id
GET    /api/external-apps/:id/icon
GET    /api/external-apps/:id/open
GET    /api/external-apps/:id/frame
POST   /api/external-apps/probe     這個網址允不允許被嵌入
GET    /api/app-icons               依名稱推薦圖示
GET    /api/app-icons/:source/:name
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
GET    /s/:token/preview
POST   /s/:token/upload
```

### Audit

```txt
GET /api/audit                      ADMIN
```

### Events

```txt
GET /ws
```

### 內部

```txt
GET /api/internal/blob/:root/:signature/*   ffmpeg 讀取遠端檔案用；只接受本機連線，網址為單一檔案簽章
```

## 44. 安全需求

必須實作：

```txt
session cookie
HttpOnly
Secure when HTTPS
SameSite=Lax
password hash
session token 與 share token 只存 hash
CSRF 防護：/api 與 /s 底下 GET 以外的請求必須帶自訂標頭
WebSocket 檢查 Origin
path traversal 防護
upload filename validation
audit log
deny-by-default authorization
server-side permission check
worker-side permission revalidation
存進資料庫的密鑰（遠端位置的連線設定、單一登入的 secret 與 refresh token、捷徑與壓縮檔的密碼）一律先以 storage.key 加密
```

檔案上傳限制：

```txt
禁止 null byte
禁止 /
禁止 ..
檔名最長 255
一次請求最多 20 個檔案
不限制單檔大小：直接串流寫入磁碟，不放進記憶體
不要把上傳檔案當 server executable
不要讓 upload path 逃出 root
檔名寫入時正規化成 NFC；比較名稱時也以 NFC 比較
```

解壓縮限制：

```txt
防止 zip slip
禁止壓縮檔 entry 使用絕對路徑
禁止壓縮檔 entry 使用 ../
解壓每個 entry 前都要 resolve safe destination
最多 10,000 個 entry
解開後最多 2 GiB，邊解邊算，不相信壓縮檔自己寫的大小
symlink entry 預設拒絕
```

猜密碼：

```txt
登入與分享連結的密碼，同一個位址對同一個帳號（或同一條連結）錯五次就得等
第一次等 30 秒，之後每次加倍，最多 15 分鐘
同一個位址不論對誰，15 分鐘內錯 50 次也一樣
限制照位址算，別人亂猜不會把帳號的主人鎖在外面
沒有帳號的 email 也照樣比對一組密碼，回應的快慢看不出哪些 email 有帳號
在反向代理後面要設 TRUST_PROXY，否則所有人都算成代理那一個位址
```

送出使用者的檔案：

```txt
使用者的檔案與由它做出來的東西（預覽、縮圖、轉出來的圖片、字幕、桌面背景），
回應一律帶 Content-Security-Policy: sandbox 與 nosniff
  => 直接開啟一個帶腳本的 SVG，也不會以 Kago 的身分執行
介面本身也帶 Content-Security-Policy：只執行自己的指令碼，不能被別的網站放進框架裡
```

交給 ffmpeg 的檔案：

```txt
限定每個使用者檔案能被當成什麼格式來讀（-format_whitelist）
限定只能從磁碟、或遠端位置在本機的那個位址讀（-protocol_whitelist）
  => 偽裝成媒體檔的播放清單不能讓伺服器替人讀出別的檔案
探測與取出字幕、封面有同時進行的上限，其餘排隊
```

單一登入：

```txt
Kago 只當 OpenID Connect 的 client：Authorization Code + PKCE
ID Token 驗簽，只接受非對稱演算法，並檢查 issuer、audience、期限與 nonce
綁定之後只認 issuer + subject
依 Email 併入既有帳號，只在提供者回報 email_verified: true 時
自動建立的帳號永遠不是管理員
密碼登入永遠保留在 /login?local=1
全部管理員都進不來時，在主機上執行 node dist/recover.js <email>
```

伺服器向外連線：

```txt
應用程式捷徑的圖示只來自兩個圖示庫或使用者上傳的檔案
Kago 不會從使用者填的網址抓東西，唯一的例外是確認它允不允許被嵌入，只讀回應的標頭
```

## 45. Audit log

記錄的動作：

```txt
帳號與登入
  setup_admin
  login_success
  login_failed
  logout
  session_revoked
  password_change
  password_reset
  user_create
  user_disable
  set_avatar
  sso_update
  sso_link
  sso_unlink

群組、位置、權限
  group_create
  group_member_add
  group_member_remove
  root_create
  root_update
  root_delete
  permission_change
  permission_denied

檔案
  upload
  mkdir
  rename
  edit
  copy
  move
  delete_to_trash
  restore_trash
  trash_empty
  compress
  extract
  download
  download_zip
  thumbnail
  tag_create
  tag_update
  finder_tag_update

任務與同步
  create_task
  task_start
  task_failed
  task_cancel
  task_pause
  task_resume
  task_retry
  tasks_clear
  sync
  sync_job_create
  sync_job_update
  sync_job_delete
  sync_job_skipped

分享
  create_share
  disable_share
  delete_share
  share_access
  share_auth_failed
  download_via_share
  upload_via_share

其他
  request_failed
  request_denied
  workspace_update
  set_wallpaper
  external_app_create
  external_app_update
  external_app_delete
```

每一筆記下是誰（`user`、`share_link` 或 `system`）、做了什麼、在哪個位置的哪個路徑、結果（`success`、`failure`、`denied`）、IP 與瀏覽器。

不要只記成功，也要記失敗與拒絕。

任何人都能讓請求失敗，而每次失敗是一列紀錄，所以：

```txt
呼叫端寫進來的東西（瀏覽器名稱、路徑、email）存之前先截短
沒登入的同一個位址十分鐘內最多記 120 筆失敗
整份紀錄只留最新的五十萬筆，每天修剪一次
伺服器自己做的事（同步、任務、升級時移除的權限規則）沒有位址，一律照記
```

## 46. 範圍

最初的 MVP，全部已經完成：

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
WebSocket task sync
shelf / 中轉區
DB tags
share links
audit logs
Base UI + Tailwind 基礎 UI
```

MVP 之後加入的：

```txt
視窗分頁、側邊欄資料夾樹、直欄檢視
資料夾各自記住的檢視方式
桌面圖示、桌面背景、頭貼
快速開啟（⌘K）
預覽視窗：圖片、影片、音樂、文字與程式碼、Markdown、PDF、Office、SQLite
影片即時轉檔、HDR、硬體加速、字幕與音軌
遠端位置（SMB、SFTP、WebDAV、FTP）
同步工作與排程
單一登入（OIDC）
應用程式捷徑
macOS Finder 標籤的讀寫
加密的 zip 與存起來的壓縮檔密碼
多國語言
窄螢幕
PUID / PGID / UMASK
```

仍然不做：

```txt
macOS native helper
拖移到桌面原生整合
Office 線上編輯
當 WebDAV / SMB server
全文搜尋
task resume
LDAP / SAML
OPA / Casbin
路徑級權限
```

## 47. 最初的實作順序

以下是專案開始時的實作順序，留作紀錄，全部已經完成。

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
22. 實作 WebSocket task event
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
docker run 啟動 Kago，/data 底下有 photos 與 private 兩個資料夾
第一次進入建立 admin
登入後進入 /
photos 與 private 自動成為兩個位置，不需要手動建立
沒有 workspace 時顯示沒有視窗的桌面
點「檔案」圖示建立第一個 FileWindow
在視窗左側的資料夾樹選 photos，FileWindow 顯示 /data/photos 的內容
進入 photos 裡的 2026 資料夾
關掉瀏覽器
重新開啟 Kago
自動還原 FileWindow，仍停留在 photos:/2026
可以開第二個 FileWindow
可以在兩個 FileWindow 間拖移檔案
drop 後顯示 複製到這裡 / 搬移到這裡 / 取消
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
