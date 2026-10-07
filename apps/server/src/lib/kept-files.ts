import fsp from "node:fs/promises";
import path from "node:path";

/** Files made from other files and kept so they are made once; one nobody asked for in this long is deleted. */
export const KEPT_FILE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** A file in use is marked as such at most this often, so looking through a folder does not write to every thumbnail. */
const MARK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a kept file is there to be used, marking it as used when it is. The mark is its modification time:
 * access times are not kept on volumes mounted with `noatime`.
 */
export async function useKeptFile(file: string): Promise<boolean> {
  const stat = await fsp.stat(file).catch(() => null);
  if (!stat || stat.size === 0) return false;
  if (Date.now() - stat.mtimeMs > MARK_INTERVAL_MS) await fsp.utimes(file, new Date(), new Date()).catch(() => undefined);
  return true;
}

/** Deletes the files of a folder that were not used for `maxAgeMs`, unfinished ones left by a crash among them. */
export async function pruneKeptFiles(dir: string, maxAgeMs = KEPT_FILE_MAX_AGE_MS): Promise<number> {
  let removed = 0;
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    const file = path.join(dir, name);
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat?.isFile() || Date.now() - stat.mtimeMs <= maxAgeMs) continue;
    await fsp.rm(file, { force: true });
    removed += 1;
  }
  return removed;
}
