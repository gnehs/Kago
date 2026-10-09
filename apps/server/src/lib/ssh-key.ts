import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const sshKeyPath = (appDataDir: string) => path.join(appDataDir, "ssh", "id_ed25519");

/**
 * The key Kago signs in to SFTP locations with. It is made the first time it is asked for;
 * only its public half ever leaves the server, to be added to the other machine's `authorized_keys`.
 */
export async function ensureSshKey(appDataDir: string): Promise<{ keyPath: string; publicKey: string }> {
  const keyPath = sshKeyPath(appDataDir);
  if (!fs.existsSync(keyPath)) {
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    // Nothing is awaited between looking and writing, so two requests at once still end up with the one key.
    fs.writeFileSync(keyPath, generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  }
  return { keyPath, publicKey: publicKeyOf(keyPath) };
}

/** The line that goes into `authorized_keys`: the kind of key, then that and the key itself as SSH writes them down. */
function publicKeyOf(keyPath: string): string {
  let point: Buffer;
  try {
    point = Buffer.from(createPublicKey(createPrivateKey(fs.readFileSync(keyPath))).export({ format: "jwk" }).x!, "base64url");
  } catch {
    // A key from when Kago had ssh-keygen make it is in OpenSSH's own format, which Node does not read; its public half lies beside it.
    return fs.readFileSync(`${keyPath}.pub`, "utf8").trim();
  }
  const field = (value: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(value.length);
    return Buffer.concat([length, value]);
  };
  return `ssh-ed25519 ${Buffer.concat([field(Buffer.from("ssh-ed25519")), field(point)]).toString("base64")} kago`;
}
