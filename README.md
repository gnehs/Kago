<p align="center">
  <img src="apps/web/public/icon.svg" width="72" alt="Kago">
</p>

<h1 align="center">Kago</h1>

<p align="center">
  裝在 NAS 上的桌面式檔案管理器。<br>
  一個 Docker container、掛兩個資料夾，就能在瀏覽器裡像用 Finder 一樣管理檔案。
</p>

![Kago 桌面：多個檔案視窗、資訊面板與中轉區](docs/screenshots/hero.png)

## 功能

- **瀏覽器裡的桌面**：同時開多個檔案視窗，自由拖曳、縮放、最小化；列表、圖示、直欄三種檢視。下次登入時，視窗會回到你離開時的位置。
- **中轉區**：先把四散各處的檔案丟進中轉區，再一次複製、搬移或壓縮到目的地，不必來回切換資料夾。
- **影片即時轉檔**：瀏覽器不能直接播的 HEVC、AC3、mkv、rmvb 會自動轉成可播放的串流，也能手動降畫質省流量。HDR 影片會依螢幕自動以 HDR 輸出或轉成 SDR。支援 NVIDIA 與 Intel / AMD 內顯硬體加速。
- **字幕與音軌**：影片旁同名的 `.ass` / `.srt` / `.sup` / `.idx`，以及 mkv 內嵌的字幕（包含藍光與 DVD 的圖形字幕）與其他音軌都會自動列出，字幕依你的語言自動載入。ASS 的樣式與定位完整呈現。
- **影片播放器**：視窗跟著影片比例縮放，可以全螢幕、子母畫面，或在新分頁中播放；同一個資料夾有多部影片時，可以直接切到上一部、下一部。
- **分享連結**：可下載、僅檢視，或是讓別人上傳檔案給你的收件箱；每條連結都能設定到期日、密碼與下載次數上限。
- **多人與權限**：使用者、群組，加上精細到單一資料夾的允許 / 禁止規則。所有操作都留有稽核紀錄。
- **背景任務**：複製、搬移、壓縮、解壓縮都在伺服器上執行，關掉瀏覽器也會繼續跑。
- **不限大小的上傳**：拖放檔案或整個資料夾即可上傳，直接串流寫入磁碟，並顯示進度、速度與剩餘時間。
- **macOS Finder 標籤**：讀得到也改得了你在 Mac 上設定的彩色標籤。
- **垃圾桶**：刪除的檔案先進垃圾桶，可以還原。
- **多國語言**：介面有 English、繁體中文、简体中文、日本語，預設跟隨瀏覽器語言，也可以在「設定 → 一般」切換。
- **快速開啟**：按 <kbd>⌘K</kbd> / <kbd>Ctrl K</kbd> 跳到任何位置或功能。
- **深色模式**：跟隨系統，或自行切換。

| | |
| --- | --- |
| ![影片播放器與字幕選單](docs/screenshots/video.png) **影片即時轉檔**，自動載入字幕 | ![分享連結管理](docs/screenshots/shares.png) **分享連結**，可設到期日、密碼與次數 |
| ![權限規則設定](docs/screenshots/permissions.png) **資料夾層級的權限**，依使用者或群組設定 | ![深色模式與快速開啟](docs/screenshots/dark.png) **深色模式**與 <kbd>⌘K</kbd> 快速開啟 |

## 快速開始

需要一台裝有 Docker 的 NAS 或 Linux 主機（`amd64` 或 `arm64`）。

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

把 `/volume1/files` 換成你想管理的資料夾，`/volume1/docker/kago` 換成要存放 Kago 自身資料的位置，然後打開 `http://<NAS 的 IP>:8080`，在初始化頁面建立第一位管理員。

偏好 Docker Compose 的話：

```yaml
services:
  kago:
    image: ghcr.io/gnehs/kago:latest
    container_name: kago
    ports:
      - "8080:8080"
    volumes:
      - /volume1/files:/data
      - /volume1/docker/kago:/app-data
    environment:
      PUID: "1000"
      PGID: "1000"
    restart: unless-stopped
```

### 兩個掛載點

| 容器內路徑 | 用途 |
| --- | --- |
| `/data` | 你要管理的檔案。**底下的每個資料夾**會各自成為桌面上的一個「位置」，所以請掛載一個裝著多個資料夾的目錄，或是把多個資料夾分別掛到 `/data/照片`、`/data/影片` 這樣的子路徑。 |
| `/app-data` | Kago 自己的資料：SQLite 資料庫（帳號、權限、分享連結、稽核紀錄）、垃圾桶與轉檔暫存。**請備份這個資料夾。** |

想把分散在不同磁碟的資料夾放在一起，分別掛載即可：

```bash
-v /volume1/photo:/data/照片 \
-v /volume2/video:/data/影片 \
-v /volume1/homes/me/Documents:/data/文件
```

位置的名稱就是資料夾名稱；想讓某個位置只能讀取，可以在「設定 → 位置」設為唯讀。

### 檔案權限（PUID / PGID）

Kago 沿用 linuxserver.io 的慣例：容器以 root 啟動，調整好 `/app-data` 的擁有者後，降權成 `PUID:PGID` 執行。Kago 寫入的檔案會屬於這個使用者，所以請填入在 NAS 上擁有那些檔案的帳號。用 SSH 登入 NAS 後執行 `id <帳號>` 就能查到。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PUID` | `1000` | 執行 Kago 的 UID |
| `PGID` | `1000` | 執行 Kago 的 GID |
| `UMASK` | `022` | 新檔案與資料夾的 umask；`022` 產生 `644` / `755`，`000` 產生 `666` / `777` |

- `/data` 不會被 chown，請確認該目錄本身可由 `PUID:PGID` 讀寫。
- Unraid 通常使用 `PUID=99`、`PGID=100`、`UMASK=000`。
- 若改用 `docker run --user` 指定身分，`PUID` / `PGID` 會被忽略，只有 `UMASK` 生效。

### 其他環境變數

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `8080` | 容器內監聽的 port |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 無 | 第一次啟動時自動建立管理員，略過初始化頁面。兩者必須一起提供 |
| `SESSION_SECRET` | 自動產生 | 簽署登入 session 的密鑰。未提供時會產生一組並存放在 `/app-data/session.secret` 重複使用 |

## 影片轉檔與硬體加速

映像檔內建 `jellyfin-ffmpeg`，不需要另外安裝任何東西。瀏覽器能直接解碼的影片會以原檔播放；不能直接播放的，mkv 這類容器，或是你在播放器控制列選了較低畫質時，伺服器會即時轉成 H.264 + AAC 的 HLS 串流。跳轉時會直接從該時間點開始轉，不必從頭等。

**HDR 影片。** 播放 HDR10 與 HLG 的影片時，播放器會偵測目前的螢幕與瀏覽器：螢幕能顯示 HDR、瀏覽器也能解碼時，伺服器輸出 10-bit HEVC 的 HDR 串流；否則把畫面色調對應（tone mapping）成 SDR，顏色不會變得灰白。把視窗拖到另一個螢幕，或是切換螢幕的 HDR 模式，串流會跟著換。畫質選單最下面會寫明目前是哪一種。瀏覽器把 203 nits 當成網頁的白色，比 QuickTime 這類以 100 nits 為準的播放器暗一級，調色偏暗的片子看起來會像沒有 HDR；所以轉檔輸出 HDR10 時預設會把暗部與中間調提亮約兩倍（最亮處維持母帶的峰值），可在同一個選單取消「提亮 HDR」看原本的調色。以原始檔案播放的 HDR 不經伺服器，不會被提亮。也可以取消「HDR 輸出」，改看伺服器轉好的 SDR。瀏覽器能直接播放的 HDR 檔案，在 HDR 螢幕上照常以原始檔案播放；在不支援 HDR 的螢幕上則改由伺服器轉成 SDR，不依賴各家瀏覽器自己的轉換。這時仍可在畫質選單手動選「原始檔案」，交給瀏覽器處理。HDR 輸出需要編碼器支援 10-bit HEVC（多數近年的 GPU，或 CPU 的 libx265），啟動 log 的 `video transcoding uses ...` 那一行會寫出偵測結果。只有 Dolby Vision 而沒有 HDR10 相容層的影片（Profile 5）顏色無法正確還原。

沒有 GPU 也能用，只是會由 CPU 軟體編碼。要讓容器用到 GPU，把裝置交給它：

```bash
# Intel / AMD 內顯（Synology、QNAP、Unraid 上的 Quick Sync 等）
docker run --device /dev/dri:/dev/dri ... ghcr.io/gnehs/kago:latest
```

```bash
# NVIDIA：主機需先安裝 NVIDIA Container Toolkit
docker run --gpus all ... ghcr.io/gnehs/kago:latest
```

Compose 的寫法是在服務底下加上 `devices: ["/dev/dri:/dev/dri"]`。

啟動時 Kago 會實際試編一小段來挑選編碼器，順序是 NVIDIA NVENC → Intel / AMD VAAPI → 軟體編碼（libx264）。結果會寫在啟動 log（`video transcoding uses ...`），畫質選單底部也會顯示。GPU 處理不了某個檔案時，該次播放會自動改用軟體編碼。

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `TRANSCODE_HWACCEL` | `auto` | `auto`、`nvenc`、`vaapi` 或 `none`（只用軟體編碼）。指定的編碼器不可用時會退回軟體編碼 |
| `TRANSCODE_VAAPI_DEVICE` | 自動 | VAAPI 使用的 render node，例如 `/dev/dri/renderD129`；未設定時逐一嘗試 `/dev/dri/renderD*` |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 映像檔內建 | 改用其他 ffmpeg 執行檔 |

內顯的 render node 屬於主機的 `render` / `video` 群組，entrypoint 會自動讓 `PUID` 加入這些群組；若是用 `--user` 啟動，請自行加上 `--group-add`。轉檔暫存檔放在 `/app-data/temp/transcode`，關閉視窗或閒置一段時間後自動清除。

## 字幕與音軌

播放影片時，Kago 會自動找出它的字幕，列在播放器控制列的「字幕與音軌」選單裡，並挑一條直接顯示。不需要任何設定。

**放在影片旁邊的字幕檔。** 支援文字字幕 `.ass`、`.ssa`、`.srt`，以及圖形字幕 `.sup`（藍光 PGS）與 `.idx` + `.sub`（DVD VobSub，兩個檔案要同名放在一起；一個 `.idx` 裡有多種語言時會各列一條），檔名開頭要和影片相同，後面可以再加上語言與標記，用 `.` 隔開：

| 檔名 | 說明 |
| --- | --- |
| `電影.mkv` | 影片 |
| `電影.ass` | 沒有標示語言的字幕 |
| `電影.zh-TW.ass` | 繁體中文。也可以寫 `zh-Hant`、`cht`、`tc` |
| `電影.zh-CN.srt` | 簡體中文。也可以寫 `zh-Hans`、`chs`、`sc` |
| `電影.en.srt` | 英文。語言可以用 `en`、`eng` 這類 ISO 代碼 |
| `電影.en.sdh.srt` | 聽障字幕（`sdh` 或 `cc`） |
| `電影.ja.forced.ass` | 強制字幕，只翻譯外語對白與畫面文字（`forced`） |
| `電影.zh-TW.default.ass` | 預設字幕，會優先被選用（`default`） |
| `電影.導演講評.en.srt` | 其餘的文字會當成字幕的名稱 |

**影片內嵌的字幕。** mkv、mp4 等容器裡的文字字幕（ASS、SRT 等）會一併列出，並使用影片附帶的字型。藍光、DVD 與數位電視的圖形字幕（PGS、VobSub、DVB）也會列出；不論內嵌還是放在影片旁，瀏覽器都畫不出這類字幕，所以選用時會改用轉檔播放，由伺服器把字幕直接畫進畫面裡。大檔案第一次讀取內嵌字幕需要掃過整個檔案，可能要等上幾秒。

**預設顯示哪一條。** 依序是：你上次手動選的語言（或「關閉」）、標了 `default` 的字幕檔、符合瀏覽器語言的字幕、影片自己標為預設的內嵌字幕、清單上的第一條。

**字型與編碼。** 字幕由 libass 繪製，ASS 的樣式、定位與特效都會保留；SRT 則套用一致的預設樣式。字幕檔通常不會附帶字型，所以 Kago 會依字幕內容與你的語言，自動載入繁體中文、簡體中文、日文或韓文的 Noto Sans 補齊缺字。非 UTF-8 的舊字幕會依語言以 Big5、GBK、Shift_JIS 或 EUC-KR 解讀。

**音軌。** 影片有多條音軌時，同一個選單可以切換。瀏覽器只會播放檔案的第一條音軌，所以選擇其他音軌時會改用轉檔播放。

**子母畫面。** 按播放器控制列上的子母畫面按鈕，字幕會跟著一起浮出。透過 HTTPS（或 `localhost`）使用 Chrome 或 Edge 時，浮出的是整個播放器，連控制列都在；其他情況下字幕會直接畫進浮出的影像裡。從瀏覽器自己的選單或按鈕啟動的子母畫面只有影片本身，不會有字幕。

## 從外網存取

Kago 本身只提供 HTTP。要從外面連進來，請放在反向代理（Synology 內建的反向代理、Nginx Proxy Manager、Caddy、Traefik 等）後面並啟用 HTTPS。設定時留意兩件事：

- **開啟 WebSocket**：任務進度與即時更新走 `/ws`。
- **放寬上傳大小限制**：Kago 不限制上傳大小，但多數反向代理預設有上限（例如 Nginx 的 `client_max_body_size`）。

## 更新

```bash
docker pull ghcr.io/gnehs/kago:latest
docker stop kago && docker rm kago
# 再用同一組參數執行一次 docker run
```

Compose 則是 `docker compose pull && docker compose up -d`。所有狀態都在 `/app-data`，重建容器不會遺失資料。

每次 push 到 `main` 都會發布 `latest` 與 `sha-<commit>`；推送 `v*` tag 時另外發布對應的版本號，想固定版本可以改用這些 tag。

## 常見問題

**桌面上沒有任何位置。**
`/data` 底下要有資料夾才會出現位置；直接放在 `/data` 根目錄的檔案不會顯示。

**上傳或建立資料夾時出現權限錯誤。**
`PUID` / `PGID` 對應的帳號對掛進 `/data` 的資料夾沒有寫入權限。請調整變數，或在 NAS 上調整資料夾權限。

**Finder 標籤沒有顯示。**
標籤存在檔案的延伸屬性（xattr）裡，需要底層檔案系統支援，而且檔案是透過會保留 xattr 的方式（例如 SMB）從 Mac 存進去的。

**字幕沒有出現在選單裡。**
確認字幕檔和影片在同一個資料夾，檔名開頭和影片完全相同（副檔名之前的部分），而且你對該字幕檔有讀取權限。詳見[字幕與音軌](#字幕與音軌)。

**影片沒有畫質選單、不能播放。**
查看啟動 log 裡的 `video transcoding uses ...`，確認 ffmpeg 有正常啟用以及實際使用的編碼器。

## 開發

`pnpm` workspace：前端 React + Vite（`apps/web`），後端 Node.js + Fastify 與內建的 `node:sqlite`（`apps/server`）。

```bash
corepack enable
pnpm install
pnpm dev
```

後端在 `http://localhost:8080`，前端 Vite 在 `http://localhost:5173` 並把 API proxy 到後端。本機轉檔使用 `PATH` 上的 `ffmpeg` / `ffprobe`；沒有安裝時影片仍以原檔播放。HEIF 照片同樣由 ffmpeg 解碼；相機 RAW 的預覽與照片的拍攝資訊由隨套件安裝的 exiftool 讀取，它需要系統上有 `perl`（macOS 內建，映像檔已安裝）。

送出變更前：

```bash
pnpm typecheck
pnpm lint
pnpm build
pnpm test:smoke
```

自行建置映像檔：

```bash
docker build -t kago:local .
```

### 翻譯

介面文字在程式碼裡一律以英文撰寫並包在 `t()` 裡（`apps/web/src/lib/i18n.ts`），各語言的字典放在 `apps/web/src/locales/`，以英文原文為鍵：

```tsx
t("Download")
t("{count} file | {count} files", { count })   // 單數 | 複數，由 count 決定
t("Location##GPS")                             // ## 後面是給譯者看的語境，不會顯示
```

- **新增文字**：直接用英文寫 `t("…")`，再到各字典補上翻譯；還沒翻的語言會先顯示英文。
- **伺服器的錯誤訊息**：後端一律回傳英文（`new AppError(404, "Path not found", …)`），前端收到後用同一份字典翻譯，所以新增錯誤訊息時也要在字典補上。
- **新增語言**：在 `locales/` 加一份字典，並在 `lib/prefs.ts` 的 `Locale` 與 `lib/i18n.ts` 的 `localeNames`、`dictionaries` 登記。
- `pnpm i18n` 會列出每個語言缺少、多餘，或 `{參數}` 對不上的翻譯。

## 授權

Copyright (C) 2026 gnehs

Kago 以 [GNU Affero General Public License v3.0](LICENSE)（`AGPL-3.0-only`）釋出。你可以自由使用、修改與散布；散布修改版，或把修改版當成網路服務提供給他人使用時，必須以相同授權提供對應的原始碼。

Docker 映像檔另外內含 [jellyfin-ffmpeg](https://github.com/jellyfin/jellyfin-ffmpeg)，它是獨立的程式，以 GPL-3.0 授權，原始碼請見該專案。

Kago 使用的第三方套件與它們的授權條款列在 [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES)，映像檔內也附有一份（`/app/THIRD-PARTY-NOTICES`）。相依套件有變動時，執行 `pnpm notices` 重新產生。
