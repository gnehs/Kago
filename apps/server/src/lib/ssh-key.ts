import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { AppError } from "./errors.js";

const execFileAsync = promisify(execFile);

export const sshKeyPath = (appDataDir: string) => path.join(appDataDir, "ssh", "id_ed25519");

/**
 * The key Kago signs in to other machines with, for rsync and SFTP. It is made the first time it is asked for;
 * only its public half ever leaves the server, to be added to the other machine's `authorized_keys`.
 */
export async function ensureSshKey(appDataDir: string): Promise<{ keyPath: string; publicKey: string }> {
  const keyPath = sshKeyPath(appDataDir);
  if (!fs.existsSync(keyPath)) {
    await fsp.mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    try {
      await execFileAsync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "kago", "-f", keyPath]);
    } catch {
      // Lost a race with another request, or there is no ssh-keygen to make one with.
      if (!fs.existsSync(keyPath)) throw new AppError(500, "An SSH key could not be created", "SSH_KEY_UNAVAILABLE");
    }
  }
  return { keyPath, publicKey: (await fsp.readFile(`${keyPath}.pub`, "utf8")).trim() };
}

/** How rsync is told to reach the other machine: Kago's key only, never a prompt, and hosts remembered once seen. */
export function sshCommand(appDataDir: string, port?: number): string {
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  return [
    "ssh",
    "-i", quote(sshKeyPath(appDataDir)),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", quote(`UserKnownHostsFile=${path.join(appDataDir, "ssh", "known_hosts")}`),
    ...(port ? ["-p", String(port)] : [])
  ].join(" ");
}
