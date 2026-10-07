import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/**
 * Seals what must not sit in the database as it was typed: the passwords and keys of remote locations.
 * The key lives in its own file beside the database, so a copy of `app.db` alone gives none of them away.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(appDataDir: string) {
    this.key = loadKey(path.join(appDataDir, "storage.key"));
  }

  seal(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `v1:${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
  }

  open(sealed: string): string {
    const [version, payload] = sealed.split(":");
    if (version !== "v1" || !payload) throw new Error("Unknown sealed value");
    const bytes = Buffer.from(payload, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8");
  }
}

function loadKey(file: string): Buffer {
  try {
    const existing = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64url");
    if (existing.length === 32) return existing;
    throw new Error("Existing storage.key is not a 256-bit key");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const key = crypto.randomBytes(32);
  try {
    fs.writeFileSync(file, `${key.toString("base64url")}\n`, { mode: 0o600, flag: "wx" });
    return key;
  } catch (error) {
    // The task worker opens the same file; whichever thread wrote it first decides the key.
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    return Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64url");
  }
}
