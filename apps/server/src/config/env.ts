import fs from "node:fs";
import path from "node:path";

export type Env = {
  port: number;
  dataDir: string;
  appDataDir: string;
  sessionSecret: string;
  adminEmail: string;
  adminPassword: string;
  nodeEnv: string;
};

export function loadEnv(): Env {
  const cwd = process.cwd();
  const appDataDir = process.env.APP_DATA_DIR ?? path.join(cwd, "app-data");
  const dataDir = process.env.DATA_DIR ?? path.join(cwd, "data");

  fs.mkdirSync(appDataDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.join(appDataDir, "trash"), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, "temp"), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, "thumbnails"), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, "logs"), { recursive: true });

  return {
    port: Number(process.env.PORT ?? 8080),
    dataDir,
    appDataDir,
    sessionSecret: process.env.SESSION_SECRET ?? "kago-local-development-secret",
    adminEmail: process.env.ADMIN_EMAIL ?? "admin@kago.local",
    adminPassword: process.env.ADMIN_PASSWORD ?? "admin123",
    nodeEnv: process.env.NODE_ENV ?? "development"
  };
}
