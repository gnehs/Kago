import { constants as fsConstants, createReadStream, createWriteStream, type Dirent, type Stats } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { AppError, errnoIs } from "./errors.js";
import { readFileTags, writeFileTags, type FileTag } from "./file-tags.js";
import { nfc, sameName } from "./filename.js";
import { id } from "./ids.js";
import { logger } from "./logger.js";
import { REPLACE_PARTIAL } from "./system-files.js";
import { liesWithin, type SafePath } from "../services/path.service.js";
import type { RemoteEntry, RemoteStorage } from "../storage/remote-storage.js";

/** How many entries of a tree are read or copied at a time. More than this gains nothing on a disk, and less is slow where each one is a round trip. */
export const treeConcurrency = 8;
/** A file up to this size is copied in one piece; a larger one is streamed, so that it counts and can be stopped on the way. */
const wholeFileBytes = 1024 * 1024 * 4;

/** One entry of a folder, by its name as the location spells it. */
export type FolderEntry = { name: string; directory: boolean };

/** What becomes of one of two that cannot both have the name. */
export type Clash = "skip" | "replace" | "keep";

/** Called when a move could not rename something and is about to copy it instead, which is when there is something to add up. */
export type BeforeCopy = () => Promise<void>;

/**
 * What a walk tells of the files it carries: `started` as one is begun, with the path it is read from, and `done`
 * once it is carried. Both are called for every file, so neither may do more than note the fact.
 */
export type FileHooks = { started?: (from: string) => void; done?: () => void };
/** Hears of what a count comes upon as it goes: so many more files, and bytes. */
export type Found = (files: number, bytes: number) => void;

export type PathStats = {
  bytes: number;
  /** The files in it, folders not counted. */
  files: number;
};

/** Per-folder index of on-disk names by their NFC form, kept current while one task writes into those folders. */
export class StoredNames {
  private readonly folders = new Map<string, Map<string, string>>();

  constructor(private readonly loadedAt: number) {}

  async find(folder: string, name: string): Promise<string | undefined> {
    return (await this.load(folder)).get(nfc(name));
  }

  async add(folder: string, name: string): Promise<void> {
    (await this.load(folder)).set(nfc(name), name);
  }

  /** A name the folder does not have yet, as close to `name` as there is; see `freeName`. */
  async free(folder: string, name: string, directory: boolean): Promise<string> {
    const names = await this.load(folder);
    return freeName((candidate) => names.has(nfc(candidate)), name, directory);
  }

  private async load(folder: string): Promise<Map<string, string>> {
    let names = this.folders.get(folder);
    if (!names) {
      await recoverReplaced(folder, this.loadedAt);
      const entries = await fsp.readdir(folder).catch((error: unknown) => {
        if (errnoIs(error, "ENOENT")) return [] as string[];
        throw error;
      });
      names = new Map(entries.map((entry) => [nfc(entry), entry]));
      this.folders.set(folder, names);
    }
    return names;
  }
}

/** The name with a number after it, before the extension of a file: the first one nothing has yet. */
export function freeName(isTaken: (name: string) => boolean, name: string, directory: boolean): string {
  const { name: stem, ext } = directory ? { name, ext: "" } : path.parse(name);
  for (let copy = 2; ; copy += 1) {
    const candidate = `${stem} ${copy}${ext}`;
    if (!isTaken(candidate)) return candidate;
  }
}

/** Lets through at most `max` pieces of work at a time; the rest wait their turn. */
export function limiter(max: number): <T>(work: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (work) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await work();
    } finally {
      // A waiting piece takes the place over as it is, so nothing that arrives meanwhile can slip in before it.
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

function assertFileOrFolder(entry: { isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }): void {
  if (entry.isSymbolicLink()) {
    throw new AppError(403, "Symlink paths are not allowed", "SYMLINK_FORBIDDEN");
  }
  if (!entry.isFile() && !entry.isDirectory()) {
    throw new AppError(403, "Only files and folders are supported", "UNSUPPORTED_FILE_TYPE");
  }
}

/** Adds up a file or a whole folder, several entries at a time, and refuses one that holds a symlink or anything else that is neither. */
export async function collectPathStats(targetPath: string, found?: Found): Promise<PathStats> {
  const limit = limiter(treeConcurrency);
  const visit = async (current: string, known?: Dirent): Promise<PathStats> => {
    if (known) assertFileOrFolder(known);
    // A folder's listing has already said what each entry is; only a file is asked again, for its size.
    if (!known?.isDirectory()) {
      const stat = await limit(() => fsp.lstat(current));
      assertFileOrFolder(stat);
      if (stat.isFile()) {
        found?.(1, stat.size);
        return { bytes: stat.size, files: 1 };
      }
    }
    const entries = await limit(() => fsp.readdir(current, { withFileTypes: true }));
    const children = await Promise.all(entries.map((entry) => visit(path.join(current, entry.name), entry)));
    return children.reduce((sum, child) => ({ bytes: sum.bytes + child.bytes, files: sum.files + child.files }), { bytes: 0, files: 0 });
  };
  return visit(targetPath);
}

/**
 * How much has to be copied to get a file or folder into `folder`: all of it when that is on another disk, and
 * nothing on its own, where it is renamed however much it holds. Only what is copied is added up, as reading a
 * whole folder through takes minutes on a hard disk.
 */
export async function bytesToCarry(sourcePath: string, folder: string, found?: Found): Promise<number> {
  return (await onAnotherDisk(sourcePath, folder)) ? (await collectPathStats(sourcePath, found)).bytes : 0;
}

/** Whether moving `sourcePath` into `folder` has to copy it, rather than rename it. */
export async function onAnotherDisk(sourcePath: string, folder: string): Promise<boolean> {
  const [item, there] = await Promise.all([fsp.lstat(sourcePath), fsp.stat(folder)]);
  return item.dev !== there.dev;
}

export type TreeSize = {
  directory: boolean;
  /** What its files hold in all. */
  bytes: number;
  /** The files, folders and anything else inside it, itself not counted. */
  entries: number;
};

/**
 * Adds up a file or a whole folder for a record of it, several entries at a time. Unlike `collectPathStats` it takes
 * what it finds as it is: a symlink is one entry of no size, and what cannot be read counts for nothing, as the
 * thing is being thrown away and not read. Null when the top has gone.
 *
 * With `moving`, for a folder that others may restore or remove while it is added up, something that vanishes
 * part way means the sum is short, so the walk stops and gives null as well.
 */
export async function measureTree(targetPath: string, found?: Found, options: { moving?: boolean } = {}): Promise<TreeSize | null> {
  const limit = limiter(treeConcurrency);
  let vanished = false;
  const unseen = <T>(fallback: T) => (error: unknown): T => {
    if (options.moving && (errnoIs(error, "ENOENT") || errnoIs(error, "ENOTDIR"))) vanished = true;
    return fallback;
  };
  const sizeOf = async (file: string) => (await limit(() => fsp.lstat(file).catch(unseen<Stats | null>(null))))?.size ?? 0;
  const visit = async (folder: string): Promise<{ bytes: number; entries: number }> => {
    if (vanished) return { bytes: 0, entries: 0 };
    const names = await limit(() => fsp.readdir(folder, { withFileTypes: true }).catch(unseen([] as Dirent[])));
    const inside = await Promise.all(
      names.map(async (entry) => {
        const child = path.join(folder, entry.name);
        if (entry.isDirectory()) {
          const sub = await visit(child);
          return { bytes: sub.bytes, entries: sub.entries + 1 };
        }
        const size = entry.isFile() ? await sizeOf(child) : 0;
        found?.(1, size);
        return { bytes: size, entries: 1 };
      })
    );
    return inside.reduce((sum, child) => ({ bytes: sum.bytes + child.bytes, entries: sum.entries + child.entries }), { bytes: 0, entries: 0 });
  };
  const top = await fsp.lstat(targetPath).catch((error: unknown) => {
    if (!errnoIs(error, "ENOENT")) throw error;
    return null;
  });
  if (!top) return null;
  if (!top.isDirectory()) {
    found?.(1, top.size);
    return { directory: false, bytes: top.size, entries: 0 };
  }
  const total = await visit(targetPath);
  return vanished ? null : { directory: true, ...total };
}

/** How many files and folders there are to remove, the one given among them, or none if it has gone. Only names are read, not what each one holds. */
export async function countEntries(targetPath: string, found?: Found): Promise<number> {
  const limit = limiter(treeConcurrency);
  const visit = async (current: string, directory: boolean): Promise<number> => {
    found?.(1, 0);
    if (!directory) return 1;
    const entries = await limit(() => fsp.readdir(current, { withFileTypes: true }));
    const counts = await Promise.all(entries.map((entry) => visit(path.join(current, entry.name), entry.isDirectory())));
    return counts.reduce((sum, count) => sum + count, 1);
  };
  const stat = await fsp.lstat(targetPath).catch((error: unknown) => {
    if (!errnoIs(error, "ENOENT")) throw error;
    return null;
  });
  return stat ? visit(targetPath, stat.isDirectory()) : 0;
}

/**
 * Removes a file or a whole folder, several entries at a time, saying so of each one as it goes: `removed` may
 * throw to stop it. A symlink is removed, never followed. What has gone meanwhile is not missed.
 */
export async function removeTree(targetPath: string, removed: (gone: string) => void): Promise<void> {
  const limit = limiter(treeConcurrency);
  const gone = (error: unknown) => {
    if (!errnoIs(error, "ENOENT")) throw error;
  };
  const visit = async (current: string, directory: boolean): Promise<void> => {
    if (directory) {
      const entries = await limit(() => fsp.readdir(current, { withFileTypes: true }).catch((error: unknown) => (gone(error), [])));
      await Promise.all(entries.map((entry) => visit(path.join(current, entry.name), entry.isDirectory())));
      await limit(() => fsp.rmdir(current).catch(gone));
    } else await limit(() => fsp.unlink(current).catch(gone));
    removed(current);
  };
  const stat = await fsp.lstat(targetPath).catch((error: unknown) => (gone(error), null));
  if (stat) await visit(targetPath, stat.isDirectory());
}

/** The folder, or the nearest one above it that is still there. */
export async function nearestFolder(folder: string): Promise<string> {
  const parent = path.dirname(folder);
  return parent === folder || (await fsp.stat(folder).catch(() => null))?.isDirectory() ? folder : nearestFolder(parent);
}

/**
 * Refuses to put a folder into itself, which a copy would fill with copies of itself until the disk is full. The
 * folder it would land in is compared with the source by what it is, as one location may be another's folder
 * mounted a second time.
 */
export async function assertTargetOutsideSource(sourcePath: string, targetPath: string): Promise<void> {
  const stat = await fsp.lstat(sourcePath);
  if (!stat.isDirectory()) return;
  // Landing where it already is, a folder is not inside itself: it has its own name against it, and that is asked about.
  if (await liesWithin(path.dirname(targetPath), sourcePath)) {
    throw new AppError(409, "Cannot copy or move a folder into itself", "TARGET_INSIDE_SOURCE");
  }
}

/**
 * Copies one file to a name that is not taken. A small one goes in one piece; a large one is streamed, counted and
 * stoppable on the way. A copy that does not get to the end is removed again, unless the name was taken after all.
 */
async function copyFile(sourcePath: string, targetPath: string, stat: Stats, tags: FileTag[], onBytes: (bytes: number) => void, signal: AbortSignal): Promise<void> {
  try {
    await copyFileContent(sourcePath, targetPath, stat, onBytes, signal);
  } catch (error) {
    if (!errnoIs(error, "EEXIST")) await fsp.rm(targetPath, { force: true }).catch(() => undefined);
    throw error;
  }
  await giveTags(targetPath, tags);
  await preservePathMetadata(targetPath, stat);
}

/** Puts a source's tags on its copy, before a mode that may not be written to is. A volume that keeps none leaves the copy without. */
async function giveTags(targetPath: string, tags: FileTag[]): Promise<void> {
  if (tags.length > 0) await writeFileTags(path.dirname(targetPath), path.basename(targetPath), tags).catch(() => undefined);
}

async function copyFileContent(sourcePath: string, targetPath: string, stat: Stats, onBytes: (bytes: number) => void, signal: AbortSignal): Promise<void> {
  if (stat.size <= wholeFileBytes) {
    await fsp.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE);
    onBytes(stat.size);
  } else {
    const byteCounter = new Transform({
      transform(chunk, _encoding, callback) {
        // onBytes is also the cancellation checkpoint; route its throw through the pipeline.
        try {
          onBytes(Buffer.byteLength(chunk));
          callback(null, chunk);
        } catch (error) {
          callback(error as Error);
        }
      }
    });
    await pipeline(createReadStream(sourcePath), byteCounter, createWriteStream(targetPath, { flags: "wx", mode: Number(stat.mode) }), { signal });
  }
}

/** A file or folder of a source that a copy carried, as it was when it was read. */
type Copied = { path: string; stat: Stats };

/**
 * Copies a file or folder to a target that did not exist before, several files at a time.
 * The first thing to go wrong stops the rest, and the copy fails once all of them have stopped. A failed copy
 * removes what it made of the target, and never a target that was there before it, as one merged into is.
 * Each file and folder carried is told to `copied`, for a move to take away only those.
 */
export async function copyTree(sourcePath: string, targetPath: string, onBytes: (bytes: number) => void, onFile?: FileHooks, copied?: Copied[]): Promise<void> {
  const limit = limiter(treeConcurrency);
  const stop = new AbortController();
  let failure: unknown;
  // A file copies itself or nothing; only a folder of the target can be left half made.
  let made = false;
  const turn = <T>(work: () => Promise<T>) =>
    limit(async () => {
      stop.signal.throwIfAborted();
      return work();
    });
  const visit = async (from: string, to: string, tags: FileTag[]): Promise<void> => {
    try {
      const stat = await turn(() => fsp.lstat(from));
      assertFileOrFolder(stat);
      if (stat.isFile()) {
        await turn(() => {
          onFile?.started?.(from);
          return copyFile(from, to, stat, tags, onBytes, stop.signal);
        });
        copied?.push({ path: from, stat });
        onFile?.done?.();
        return;
      }
      const entries = await turn(async () => {
        // Made writable, as it has yet to be filled: a folder that may not be written to gets its mode once it is.
        await fsp.mkdir(to);
        if (to === targetPath) made = true;
        const names = await fsp.readdir(from);
        return { names, tags: await readFileTags(from, names) };
      });
      copied?.push({ path: from, stat });
      await Promise.all(entries.names.map((entry) => visit(path.join(from, entry), path.join(to, entry), entries.tags.get(entry) ?? [])));
      if (stop.signal.aborted) return;
      await giveTags(to, tags);
      await preservePathMetadata(to, stat);
    } catch (error) {
      if (stop.signal.aborted) return;
      failure = error;
      stop.abort();
    }
  };
  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  const name = path.basename(sourcePath);
  await visit(sourcePath, targetPath, (await readFileTags(path.dirname(sourcePath), [name])).get(name) ?? []);
  if (!stop.signal.aborted) return;
  if (made) await fsp.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
  throw failure;
}

/**
 * Puts a file or folder in the place of what is at `occupant`. Nothing there is touched before what replaces it is
 * whole: a move within one disk is a rename, and anything else is first copied to a name of its own. What was there
 * is then set aside, the new one renamed into place, and the old one deleted last, which on a slow disk is what
 * takes long. A moved source that had to be copied goes after that.
 *
 * Both wait in a folder of their own beside the target, what was set aside under its own name, so that should the
 * server stop between the two renames, `recoverReplaced` can put it back.
 */
export async function replacePath(
  sourcePath: string,
  occupant: string,
  targetPath: string,
  move: boolean,
  onBytes: (bytes: number) => void,
  onFile?: FileHooks,
  beforeCopy?: BeforeCopy
): Promise<void> {
  const staging = path.join(path.dirname(targetPath), `${REPLACE_PARTIAL}${Date.now()}-${id("temp")}`);
  const aside = path.join(staging, "old", path.basename(occupant));
  const arriving = path.join(staging, "new");
  await fsp.mkdir(path.dirname(aside), { recursive: true });
  try {
    const renamed =
      move &&
      (await swapIn(sourcePath, occupant, aside, targetPath).then(
        () => true,
        (error: unknown) => {
          if (errnoIs(error, "EXDEV")) return false;
          throw error;
        }
      ));
    if (!renamed) {
      const copied: Copied[] = [];
      if (move) await beforeCopy?.();
      await copyTree(sourcePath, arriving, onBytes, onFile, copied);
      await swapIn(arriving, occupant, aside, targetPath);
      await fsp.rm(staging, { recursive: true, force: true });
      if (move) await removeCopied(copied);
      return;
    }
  } catch (error) {
    // What was there is back in its place unless that failed too, and then it stays where it can be found again.
    await fsp.rm(arriving, { recursive: true, force: true }).catch(() => undefined);
    await fsp
      .rmdir(path.dirname(aside))
      .then(() => fsp.rmdir(staging))
      .catch(() => undefined);
    throw error;
  }
  await fsp.rm(staging, { recursive: true, force: true });
}

/** Sets what is at `occupant` aside and renames `incoming` into `target`; should that fail, what was set aside goes back. */
export async function swapIn(incoming: string, occupant: string, aside: string, target: string): Promise<void> {
  // What has gone meanwhile leaves nothing to set aside.
  const setAside = await fsp.rename(occupant, aside).then(
    () => true,
    (error: unknown) => {
      if (errnoIs(error, "ENOENT")) return false;
      throw error;
    }
  );
  try {
    await renameFree(incoming, target);
  } catch (error) {
    if (setAside) await fsp.rename(aside, occupant);
    throw error;
  }
}

/**
 * Puts right what a replacement cut short left in a folder: its folder beside the target, with what had been set
 * aside in it. That goes back to its name unless something has taken it since, and the rest of it goes. Only what
 * an earlier run left is touched, as this one may be in the middle of a replacement of its own. What an older Kago
 * left under such a name, a half-made copy or the source it had already renamed there, is given a name that is seen.
 */
export async function recoverReplaced(folder: string, loadedAt: number): Promise<void> {
  const names = await fsp.readdir(folder).catch(() => [] as string[]);
  for (const name of names) {
    if (!name.startsWith(REPLACE_PARTIAL)) continue;
    const staging = path.join(folder, name);
    const started = /^(\d+)-/.exec(name.slice(REPLACE_PARTIAL.length));
    try {
      if (!started) {
        const directory = (await fsp.lstat(staging)).isDirectory();
        const taken = (candidate: string) => names.some((other) => sameName(other, candidate));
        const visible = taken("Recovered") ? freeName(taken, "Recovered", directory) : "Recovered";
        await renameFree(staging, path.join(folder, visible));
        names.push(visible);
        continue;
      }
      if (Number(started[1]) >= loadedAt) continue;
      const aside = path.join(staging, "old");
      for (const held of await fsp.readdir(aside).catch(() => [] as string[])) {
        const back = path.join(folder, held);
        if (!(await fsp.lstat(back).catch(() => null))) await fsp.rename(path.join(aside, held), back);
      }
      await fsp.rm(staging, { recursive: true, force: true });
    } catch (error) {
      logger.warn("could not recover an interrupted replacement", { path: staging, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * `swapIn` on a remote location, in the folder `staging` beside the target that the replacement was copied into as
 * `new`: what is in the way is set aside in it under `old`, the replacement moved into place, and the folder removed.
 */
export async function swapInRemote(remote: RemoteStorage, folder: SafePath, staging: string, occupant: FolderEntry, name: string, directory: boolean): Promise<void> {
  const at = (...names: string[]) => path.posix.join(folder.logicalPath, ...names);
  const aside = at(staging, "old", occupant.name);
  const setAside = await remote.move(folder.root, at(occupant.name), aside, occupant.directory).then(
    () => true,
    (error: unknown) => {
      if (error instanceof AppError && error.code === "PATH_NOT_FOUND") return false;
      throw error;
    }
  );
  try {
    await remote.move(folder.root, at(staging, "new"), at(name), directory);
  } catch (error) {
    if (setAside) await remote.move(folder.root, aside, at(occupant.name), occupant.directory);
    throw error;
  }
  await remote.remove(folder.root, at(staging), true);
}

/**
 * `recoverReplaced` on a remote location, by the same rules, given what the folder holds. An older Kago copied a
 * replacement to the staging name itself and removed what it replaced before moving it in, so whatever such a name
 * holds besides `old` and `new` is that copy, which may be all that is left of either, and is given a name that is
 * seen. Says whether anything was put right.
 */
export async function recoverRemoteReplaced(remote: RemoteStorage, folder: SafePath, found: RemoteEntry[], loadedAt: number): Promise<boolean> {
  const at = (...names: string[]) => path.posix.join(folder.logicalPath, ...names);
  const names = found.map((entry) => entry.name);
  let changed = false;
  for (const entry of found) {
    if (!entry.name.startsWith(REPLACE_PARTIAL)) continue;
    const started = /^(\d+)-/.exec(entry.name.slice(REPLACE_PARTIAL.length));
    try {
      if (started && Number(started[1]) >= loadedAt) continue;
      const held = started && entry.directory ? await remote.list(folder.root, at(entry.name)) : null;
      if (!held || held.some((item) => item.name !== "old" && item.name !== "new")) {
        const taken = (candidate: string) => names.some((other) => sameName(other, candidate));
        const visible = taken("Recovered") ? freeName(taken, "Recovered", entry.directory) : "Recovered";
        await remote.move(folder.root, at(entry.name), at(visible), entry.directory);
        names.push(visible);
        changed = true;
        continue;
      }
      if (held.some((item) => item.name === "old")) {
        for (const kept of await remote.list(folder.root, at(entry.name, "old"))) {
          if (!names.some((other) => sameName(other, kept.name))) {
            await remote.move(folder.root, at(entry.name, "old", kept.name), at(kept.name), kept.directory);
            names.push(kept.name);
          }
        }
      }
      await remote.remove(folder.root, at(entry.name), true);
      changed = true;
    } catch (error) {
      logger.warn("could not recover an interrupted replacement", { path: at(entry.name), error: error instanceof Error ? error.message : String(error) });
    }
  }
  return changed;
}

/**
 * Puts what a folder holds into one that is already there. What the target does not have is carried whole, a
 * folder it has is merged in turn, and `clash` says what becomes of anything else the two both have.
 * A moved folder goes once it is empty, which it is not when something of it was skipped.
 */
export async function mergeTree(
  sourcePath: string,
  targetPath: string,
  clash: Clash,
  move: boolean,
  names: StoredNames,
  onBytes: (bytes: number) => void,
  onFile?: FileHooks,
  beforeCopy?: BeforeCopy
): Promise<void> {
  for (const entry of await fsp.readdir(sourcePath, { withFileTypes: true })) {
    assertFileOrFolder(entry);
    const from = path.join(sourcePath, entry.name);
    const carry = (to: string) => (move ? movePath(from, to, onBytes, onFile, beforeCopy) : copyTree(from, to, onBytes, onFile));
    const existing = await names.find(targetPath, entry.name);
    if (existing === undefined) {
      await carry(path.join(targetPath, entry.name));
      await names.add(targetPath, entry.name);
      continue;
    }
    const occupant = path.join(targetPath, existing);
    // A link there is something in the way like any file, and never a folder to put things in.
    const folderThere = (await fsp.lstat(occupant)).isDirectory();
    if (entry.isDirectory() && folderThere) await mergeTree(from, occupant, clash, move, names, onBytes, onFile, beforeCopy);
    else if (clash === "replace" && entry.isDirectory() === folderThere) await replacePath(from, occupant, occupant, move, onBytes, onFile, beforeCopy);
    // Nobody was asked about a file and a folder that share a name deep inside a merge, so neither takes the other's place.
    else if (clash === "keep" || clash === "replace") {
      const kept = await names.free(targetPath, nfc(entry.name), entry.isDirectory());
      await carry(path.join(targetPath, kept));
      await names.add(targetPath, kept);
    }
  }
  if (move) {
    await fsp.rmdir(sourcePath).catch((error: unknown) => {
      if (!errnoIs(error, "ENOTEMPTY") && !errnoIs(error, "EEXIST")) throw error;
    });
  }
}

async function preservePathMetadata(targetPath: string, stat: Stats): Promise<void> {
  await fsp.chmod(targetPath, Number(stat.mode)).catch(() => undefined);
  await fsp.utimes(targetPath, stat.atime, stat.mtime).catch(() => undefined);
}

/**
 * Moves a file or folder to a name that is not taken. Within one disk it is renamed; to another it is copied, and
 * then only what was copied leaves the source. Whatever arrived in the source, or changed, while it was being
 * copied stays there, rather than going with the rest without ever having reached the target.
 */
export async function movePath(sourcePath: string, targetPath: string, onBytes: (bytes: number) => void, onFile?: FileHooks, beforeCopy?: BeforeCopy): Promise<boolean> {
  try {
    await renameFree(sourcePath, targetPath);
    return false;
  } catch (error) {
    if (!errnoIs(error, "EXDEV")) throw error;
  }
  const copied: Copied[] = [];
  await beforeCopy?.();
  await copyTree(sourcePath, targetPath, onBytes, onFile, copied);
  await removeCopied(copied);
  return true;
}

/**
 * Renames, but never over something else. A rename takes the place of a file that is in the way without a word, and
 * a volume that does not mind the case, or a name that was free when the task started, can put one there. Only the
 * entry itself may answer to the new name, as it does when no more than its spelling changes.
 */
async function renameFree(from: string, to: string): Promise<void> {
  const [moving, there] = await Promise.all([fsp.lstat(from), fsp.lstat(to).catch(() => null)]);
  if (there && (there.dev !== moving.dev || there.ino !== moving.ino)) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
  await fsp.rename(from, to);
}

/**
 * Takes away what a copy carried off: each file that is still the one that was read, then each folder that is
 * left empty. A file that is new, or was changed while it was being copied, stays where it is, and so does its folder.
 */
async function removeCopied(copied: Copied[]): Promise<void> {
  const limit = limiter(treeConcurrency);
  const kept: string[] = [];
  await Promise.all(
    copied
      .filter((item) => !item.stat.isDirectory())
      .map((item) =>
        limit(async () => {
          const now = await fsp.lstat(item.path).catch(() => null);
          if (!now) return;
          if (now.ino === item.stat.ino && now.size === item.stat.size && now.mtimeMs === item.stat.mtimeMs) await fsp.unlink(item.path);
          else kept.push(item.path);
        })
      )
  );
  // Deepest first: a folder is longer by name than the one it is in.
  const folders = copied.filter((item) => item.stat.isDirectory()).map((item) => item.path).sort((a, b) => b.length - a.length);
  for (const folder of folders) {
    await fsp.rmdir(folder).catch((error: unknown) => {
      if (errnoIs(error, "ENOTEMPTY") || errnoIs(error, "EEXIST")) kept.push(folder);
      else if (!errnoIs(error, "ENOENT")) throw error;
    });
  }
  if (kept.length > 0) logger.warn("a move left behind what changed in its source while it was copied", { paths: kept.slice(0, 20), count: kept.length });
}
