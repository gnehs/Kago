import fs from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

export type Env = {
  port: number;
  dataDir: string;
  appDataDir: string;
  sessionSecret: string;
  webDistDir?: string;
  initialAdminEmail?: string;
  initialAdminPassword?: string;
  nodeEnv: string;
  /**
   * Whether, and how far, the `X-Forwarded-*` headers of a reverse proxy are believed: how many proxies stand in
   * front, or the addresses they connect from. Without it everyone appears to come from the proxy itself.
   */
  trustProxy?: boolean | number | string;
};

export function loadEnv(): Env {
  const cwd = process.cwd();
  const appDataDir = process.env.APP_DATA_DIR ?? path.join(cwd, "app-data");
  const dataDir = process.env.DATA_DIR ?? path.join(cwd, "data");
  const nodeEnv = process.env.NODE_ENV ?? "development";
  fs.mkdirSync(appDataDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  const sessionSecret = resolveSessionSecret(appDataDir, nodeEnv);

  if (Boolean(process.env.ADMIN_EMAIL) !== Boolean(process.env.ADMIN_PASSWORD)) {
    throw new Error("ADMIN_EMAIL and ADMIN_PASSWORD must be provided together");
  }

  fs.mkdirSync(path.join(appDataDir, "trash"), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, "temp"), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, "thumbnails"), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, "previews"), { recursive: true });
  fs.mkdirSync(path.join(appDataDir, "logs"), { recursive: true });

  return {
    port: Number(process.env.PORT ?? 8080),
    dataDir,
    appDataDir,
    sessionSecret,
    webDistDir: process.env.WEB_DIST_DIR,
    initialAdminEmail: process.env.ADMIN_EMAIL,
    initialAdminPassword: process.env.ADMIN_PASSWORD,
    nodeEnv,
    trustProxy: resolveTrustProxy(process.env.TRUST_PROXY)
  };
}

function resolveTrustProxy(value = ""): boolean | number | string {
  const setting = value.trim();
  if (!setting || /^(false|0|no|off)$/i.test(setting)) return false;
  if (/^(true|yes|on)$/i.test(setting)) return true;
  // A count of proxies, or the addresses and ranges they connect from.
  return /^\d+$/.test(setting) ? Number(setting) : setting;
}

function resolveSessionSecret(appDataDir: string, nodeEnv: string): string {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (nodeEnv !== "production") return "kago-local-development-secret";

  const secretPath = path.join(appDataDir, "session.secret");
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) return existing;
    throw new Error("Existing session.secret is too short");
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }

  const secret = randomBytes(48).toString("base64url");
  try {
    fs.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600, flag: "wx" });
    return secret;
  } catch (error) {
    if (!isNodeError(error, "EEXIST")) throw error;
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) return existing;
    throw new Error("Existing session.secret is too short");
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
