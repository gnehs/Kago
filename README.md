# Kago

Kago 是單一 Docker container 部署的多人 NAS 檔案管理器。這個 repo 目前使用 `pnpm` workspace，前端是 React + Vite，後端是 Node.js + Fastify，資料庫使用 Node 內建 `node:sqlite`。

## 開發

```bash
pnpm install
pnpm dev
```

後端預設在 `http://localhost:8080`，前端 Vite 在 `http://localhost:5173`，開發模式會把 API proxy 到後端。

預設 demo 管理員：

```txt
email: admin@kago.local
password: admin123
```

可用環境變數覆蓋：

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='change-me' pnpm dev
```

## 建置

```bash
pnpm build
pnpm start
```

## Docker

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
  --user 1000:1000 \
  --restart unless-stopped \
  kago:local
```

第一次啟動會初始化 SQLite、建立預設 admin，並在 `/app-data/app.db` 保存 workspace、權限、任務、tags、shares、audit logs 與 shelf references。
