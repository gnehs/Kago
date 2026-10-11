import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AFP_INFO_OFFSET, decodeFileTags, encodeFileTags, relabel, type FileTag } from "../lib/file-tags.js";
import { logger } from "../lib/logger.js";
import type { RemoteConfig } from "./providers.js";

// A Mac keeps a file's extended attributes on an SMB server as named streams of the file, and the server
// stores them however it likes. A colon ends a stream's name, so the one in the attribute's name travels as U+F022.
const TAGS_STREAM = "com.apple.metadata_kMDItemUserTags";
const INFO_STREAM = "AFP_AfpInfo";
const TIMEOUT_MS = 15_000;

// rclone cannot open a stream, so Samba's own client does. Set once it turns out to be missing.
let unavailable = false;

type Target = { args: string[]; env: NodeJS.ProcessEnv; folder: string[] };

/** rclone spells these another way on the server, and the client has no way to quote some of them. */
const plain = (name: string) => !/["*:<>?|\\\x00-\x1f\x7f]/.test(name) && !/[ .]$/.test(name);

/** How to reach the share a path of the location is in, and the folders from there to the path. Null where there is no share. */
function target(config: RemoteConfig, logicalPath: string): Target | null {
  const [share, ...folder] = [...config.base.split("/"), ...logicalPath.split("/")].filter(Boolean);
  const { host, port, user, pass, domain } = config.params;
  if (config.type !== "smb" || !host || !share || ![share, ...folder].every(plain) || user?.includes("%")) return null;
  const args = [`//${host}/${share}`, "-s", "/dev/null", "-U", user || "guest"];
  if (port) args.push("-p", port);
  if (domain) args.push("-W", domain);
  if (!pass) args.push("-N");
  // The password goes by the environment, which other accounts of the machine cannot read as they can arguments.
  return { args, env: { ...process.env, PASSWD: pass ?? "" }, folder };
}

const remotePath = (folder: string[], name: string, stream: string) => `"\\${[...folder, name].join("\\")}:${stream}"`;

/** Runs commands in one session and returns what the client said. Rejects only when it could not be started. */
function session(to: Target, commands: string[]): Promise<{ output: string; ok: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("smbclient", to.args, { env: to.env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => (output = (output + chunk.toString("utf8")).slice(-65536)));
    child.stderr.on("data", (chunk: Buffer) => (output = (output + chunk.toString("utf8")).slice(-65536)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ output, ok: code === 0 && !output.includes("NT_STATUS_") });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(`${commands.join("\n")}\n`);
  });
}

async function withScratch<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "kago-smb-"));
  try {
    return await work(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

function missing(error: unknown): boolean {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  if (!unavailable) logger.warn("File tags of SMB locations are unavailable: smbclient is not installed");
  unavailable = true;
  return true;
}

/**
 * Tags of the named entries of a folder in an SMB location. Entries without tags are left out.
 * Never throws: a server that is slow, or keeps no streams, only means no tags.
 */
export async function readSmbTags(config: RemoteConfig, logicalPath: string, names: string[]): Promise<Map<string, FileTag[]>> {
  const result = new Map<string, FileTag[]>();
  const to = target(config, logicalPath);
  const readable = names.filter(plain);
  if (unavailable || !to || readable.length === 0) return result;
  try {
    await withScratch(async (dir) => {
      // Each stream lands in a file named by its entry's place in the list; what a slow server did not get to stays out.
      await session(to, [`lcd "${dir}"`, ...readable.map((name, index) => `get ${remotePath(to.folder, name, TAGS_STREAM)} ${index}`)]);
      await Promise.all(
        readable.map(async (name, index) => {
          const value = await fsp.readFile(path.join(dir, String(index))).catch(() => null);
          const tags = value ? decodeFileTags(value) : [];
          if (tags.length > 0) result.set(name, tags);
        })
      );
    });
  } catch (error) {
    if (!missing(error)) logger.warn("File tags of an SMB folder could not be read", error instanceof Error ? error.message : error);
  }
  return result;
}

/**
 * Replaces the tags of one entry of an SMB location, the way a Mac connected to the server would.
 * Throws when the server refuses, or when there is no client to ask it.
 */
export async function writeSmbTags(config: RemoteConfig, logicalPath: string, tags: FileTag[]): Promise<void> {
  const to = target(config, path.posix.dirname(logicalPath));
  const name = path.posix.basename(logicalPath);
  if (!to || !plain(name)) throw new Error("Path cannot be tagged");
  await withScratch(async (dir) => {
    await session(to, [`lcd "${dir}"`, `get ${remotePath(to.folder, name, INFO_STREAM)} info`]);
    const info = await fsp.readFile(path.join(dir, "info")).catch(() => null);
    const relabelled = info && relabel(info, AFP_INFO_OFFSET, tags);
    // The client cannot remove a stream; an empty one reads as no attribute at all.
    await fsp.writeFile(path.join(dir, "tags"), tags.length > 0 ? encodeFileTags(tags) : Buffer.alloc(0));
    const commands = [`lcd "${dir}"`, `put tags ${remotePath(to.folder, name, TAGS_STREAM)}`];
    if (relabelled) {
      await fsp.writeFile(path.join(dir, "info"), relabelled);
      commands.push(`put info ${remotePath(to.folder, name, INFO_STREAM)}`);
    }
    const written = await session(to, commands);
    if (!written.ok) throw new Error(`smbclient: ${written.output.trim().split("\n").at(-1) ?? "failed"}`);
  });
}
