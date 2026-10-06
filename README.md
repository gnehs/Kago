# Kago

Kago 是單一 Docker container 部署的多人 NAS 檔案管理器。這個 repo 目前使用 `pnpm` workspace，前端是 React + Vite，後端是 Node.js + Fastify，資料庫使用 Node 內建 `node:sqlite`。

## 開發

```bash
pnpm install
pnpm dev
```

後端預設在 `http://localhost:8080`，前端 Vite 在 `http://localhost:5173`，開發模式會把 API proxy 到後端。

第一次開啟會顯示初始化頁面，請在瀏覽器中建立第一位管理員。若要在開發環境自動建立初始管理員，可以同時提供：

```bash
ADMIN_EMAIL=admin@example.test ADMIN_PASSWORD='replace-with-a-development-password' pnpm dev
```

## 建置

```bash
pnpm build
pnpm start
```

## 驗證

本機驗證先跑 TypeScript、production build 與後端 smoke flow：

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test:smoke
```

`package.json` 以 `packageManager` pin 住 pnpm 版本；若環境有 Corepack，建議先啟用 Corepack，讓本機與 Docker build 使用相同的 pnpm 版本：

```bash
corepack enable
pnpm --version
```

Docker 驗證需要 Docker CLI。build 完 image 後，確認 container 可以啟動、Fastify 有 serve API 與 SPA fallback：

```bash
docker build -t kago:local .
docker run --rm -d \
  --name kago-verify \
  -p 8080:8080 \
  -v "$PWD/.tmp/kago-data:/data" \
  -v "$PWD/.tmp/kago-app-data:/app-data" \
  -e DATA_DIR=/data \
  -e APP_DATA_DIR=/app-data \
  -e PORT=8080 \
  -e SESSION_SECRET='replace-with-a-long-random-value' \
  kago:local

curl -fsS http://localhost:8080/api/auth/setup
curl -fsSI http://localhost:8080/
docker stop kago-verify
```

## Docker

每次 push 到 `main` 或推送 `v*` tag 時，GitHub Actions 會自動 build `linux/amd64` 與 `linux/arm64` image 並推送到 `ghcr.io/gnehs/kago`（`latest`、`sha-<commit>`，以及 tag 對應的版本號）。可以直接 pull，把下方的 `kago:local` 換成 `ghcr.io/gnehs/kago:latest`：

```bash
docker pull ghcr.io/gnehs/kago:latest
```

或自行 build：

```bash
docker build -t kago:local .
docker run -d \
  --name kago \
  -p 8080:8080 \
  -v /volume1/files:/data \
  -v /volume1/docker/kago:/app-data \
  -e DATA_DIR=/data \
  -e APP_DATA_DIR=/app-data \
  -e PORT=8080 \
  -e SESSION_SECRET='replace-with-a-long-random-value' \
  -e PUID=1000 \
  -e PGID=1000 \
  --restart unless-stopped \
  kago:local
```

第一次啟動會初始化 SQLite，並在 `/app-data/app.db` 保存 workspace、權限、任務、tags、shares、audit logs 與 shelf references。建議在 production 提供 `SESSION_SECRET`；若未提供，Kago 會在 `/app-data/session.secret` 產生並重用一組隨機 secret。管理員可以透過初始化頁面建立，或用 `ADMIN_EMAIL` / `ADMIN_PASSWORD` 預先建立。

Docker image 內建 `rsync` 供 `rsync_pull` / `rsync_push` task 使用，並沿用 linuxserver.io 的慣例，用環境變數決定執行身分與新檔案的權限：

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PUID` | `1000` | 執行 Kago 的 UID，寫入 `/data` 的檔案會屬於這個使用者 |
| `PGID` | `1000` | 執行 Kago 的 GID |
| `UMASK` | `022` | 新檔案與資料夾的 umask；`022` 產生 `644` / `755`，`000` 產生 `666` / `777` |

容器以 root 啟動後會把 `/app-data` 的 owner 調整成 `PUID:PGID`，再降權執行；`/data` 不會被 chown，請確認該目錄本身可由 `PUID:PGID` 寫入。例如 Unraid 使用 `PUID=99`、`PGID=100`、`UMASK=000`。若改用 `docker run --user` 指定身分，`PUID` / `PGID` 會被忽略，只有 `UMASK` 生效。

### 影片轉檔

Docker image 內建 `ffmpeg`。預覽影片時，瀏覽器能直接解碼的檔案會原檔播放；不能直接播放的（例如 HEVC / AC3 的 mkv、avi、rmvb），或是在視窗標題列手動選了較低畫質時，伺服器會即時轉成 H.264 + AAC 的 HLS 串流，暫存檔放在 `/app-data/temp/transcode`，關閉視窗或閒置一段時間後自動清除。

轉檔使用軟體編碼（libx264），會吃 CPU。本機開發若沒有安裝 `ffmpeg` / `ffprobe`，影片仍會以原檔播放，只是沒有轉檔與畫質選單；執行檔不在 `PATH` 時可用 `FFMPEG_PATH`、`FFPROBE_PATH` 指定。
