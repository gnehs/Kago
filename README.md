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

Docker image 內建 `jellyfin-ffmpeg`。預覽影片時，瀏覽器能直接解碼的檔案會原檔播放；不能直接播放的（例如 HEVC / AC3 的 mkv、avi、rmvb），或是在視窗標題列手動選了較低畫質時，伺服器會即時轉成 H.264 + AAC 的 HLS 串流。播放清單依片長預先算好，跳轉時 ffmpeg 直接從該時間點開始轉，不需要從頭處理。暫存檔放在 `/app-data/temp/transcode`，關閉視窗或閒置一段時間後自動清除。

啟動時會實際試編一小段來挑選編碼器，順序是 NVIDIA NVENC → Intel / AMD VAAPI → 軟體編碼（libx264），結果會寫在啟動 log（`video transcoding uses ...`），畫質選單底部也會顯示。GPU 無法處理某個檔案時，該次播放會自動改用軟體編碼。

要讓容器用到 GPU，需要把裝置交給它：

```bash
# NVIDIA：主機需先安裝 NVIDIA Container Toolkit
docker run --gpus all ... ghcr.io/gnehs/kago:latest

# Intel / AMD 內顯
docker run --device /dev/dri:/dev/dri ... ghcr.io/gnehs/kago:latest
```

兩者可以同時給，預設優先用 NVIDIA。內顯的 render node 屬於主機的 `render` / `video` 群組，entrypoint 會自動讓 `PUID` 加入這些群組；若是用 `docker run --user` 啟動，請自行加上 `--group-add`。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `TRANSCODE_HWACCEL` | `auto` | `auto`、`nvenc`、`vaapi` 或 `none`（只用軟體編碼）。指定的編碼器不可用時會退回軟體編碼 |
| `TRANSCODE_VAAPI_DEVICE` | 自動 | VAAPI 使用的 render node，例如 `/dev/dri/renderD129`；未設定時逐一嘗試 `/dev/dri/renderD*` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | image 內建 | 改用其他 ffmpeg 執行檔 |

本機開發使用 `PATH` 上的 `ffmpeg` / `ffprobe`（macOS 會用 VideoToolbox）；沒有安裝時影片仍以原檔播放，只是沒有轉檔與畫質選單。
