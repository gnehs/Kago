import { createReadStream, createWriteStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { detectConvertAccel, type ConvertAccel } from "../lib/convert-accel.js";
import { usesHardware, convertArgs, convertSpecSchema, ConvertStopped, convertSupport, type ConvertSupport, jobConverts, probeMedia, remuxArgs, runFfmpeg, SUBTITLE_FORMATS, type ConvertSpec, type RemuxInput, type RemuxTrack } from "../lib/convert.js";
import { AppError } from "../lib/errors.js";
import { MEDIA_FORMATS } from "../lib/ffmpeg-input.js";
import { nfc } from "../lib/filename.js";
import { id, now } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import { CONVERT_PARTIAL, isSystemFile } from "../lib/system-files.js";
import { isRemote } from "../storage/remote-storage.js";
import type { AuditService } from "./audit.service.js";
import { sharesAreFixed, type PathService, type SafePath } from "./path.service.js";
import type { PermissionService } from "./permission.service.js";
import type { FileStat, StorageService } from "./storage.service.js";
import type { Actor, FileRef, FileTask } from "./types.js";

const fileRefSchema = z.object({ rootSlug: z.string().min(1), path: z.string().min(1) });

/** How many files one conversion may be asked for at a time; a whole folder is what a job is for. */
const MAX_SOURCES = 500;
/** A file changed more recently than this may still be on its way in, and is left for the next look. */
const SETTLE_MS = 20_000;
/** Conversions run one at a time, in the worker that loaded this. A half-written file from before then is one nothing will finish. */
const LOADED_AT = Date.now();
/** How many folders a folder's structure may have and still be copied. */
const MAX_STRUCTURE_FOLDERS = 20_000;

export const convertInputSchema = z.object({
  sources: z.array(fileRefSchema).min(1).max(MAX_SOURCES),
  /** The folder the new files go in. */
  destination: fileRefSchema,
  spec: convertSpecSchema
});

export const convertJobOptionsSchema = z.object({
  /** When the conversion comes out no smaller than the file was, the file itself is what goes to the destination. */
  keepSmaller: z.boolean().default(false),
  /** What becomes of a file in the input folder once it has reached the destination. */
  after: z.enum(["keep", "trash", "delete"]).default("keep"),
  /** Whether what is not media (subtitles, notes) is brought across beside what is. */
  copyOthers: z.boolean().default(false),
  /** The endings of the names of the files that are converted; any other file is one of the others. Null goes by what the format is made from. */
  extensions: z.array(z.string().transform((value) => value.trim().replace(/^\./, "").toLowerCase()).pipe(z.string().regex(/^[a-z0-9]{1,16}$/))).min(1).max(200).nullable().default(null)
});

export type ConvertJobOptions = z.infer<typeof convertJobOptionsSchema>;
/** One run of a saved job, as its task carries it. */
export type ConvertJobRun = { id: string; input: FileRef; options: ConvertJobOptions; retryFailed?: boolean };
export type ConvertInput = z.infer<typeof convertInputSchema>;

const trackFlags = {
  language: z.string().trim().max(35).regex(/^[A-Za-z0-9-]*$/).optional(),
  title: z.string().trim().max(200).optional(),
  default: z.boolean().optional(),
  forced: z.boolean().optional()
};

export const remuxInputSchema = z.object({
  source: fileRefSchema,
  /** What the new file is called; it goes beside the source. */
  name: z.string().trim().min(1).max(255).refine((name) => !/[\\/\0]/.test(name) && name !== "." && name !== "..", "Invalid name"),
  title: z.string().trim().max(500).optional(),
  /** The tracks of the new file in their order. One of the source's is named by its place among those of its kind. */
  tracks: z
    .array(
      z.discriminatedUnion("from", [
        z.object({ from: z.literal("source"), kind: z.enum(["video", "audio", "subtitle"]), index: z.number().int().min(0).max(999), ...trackFlags }),
        z.object({ from: z.literal("file"), kind: z.enum(["audio", "subtitle"]), file: fileRefSchema, ...trackFlags })
      ])
    )
    .min(1)
    .max(64),
  attachments: z.boolean().default(true),
  chapters: z.boolean().default(true)
});

export type RemuxInputSpec = z.infer<typeof remuxInputSchema>;

/** How a running task hears of what its work is doing, and says when to give up. */
export type TaskHandle = {
  show(currentPath: string): void;
  totals(files: number, bytes: number): Promise<void>;
  bytes(bytes: number): void;
  files(files: number): void;
  stopped(): boolean;
};

type Walked = { rel: string; size: number; mtimeMs: number; directory: boolean };

/** Names in a folder that are already spoken for, compared the way a disk that does not mind the case would. */
const nameKey = (name: string) => nfc(name).toLowerCase();
/** What a file is called once converted, before a number is put after it to keep it apart from another. */
const outputName = (name: string, format: string) => `${name.slice(0, name.length - path.extname(name).length) || name}.${format}`;

/** The tasks that bring files into a folder, and so may have one there that is not whole yet. */
const writerTypes = ["copy", "move", "extract", "compress", "sync"];
/** A place as the busy ones are told apart, standing also for all that lies under it. */
const placeKey = (rootSlug: string, logicalPath: string) => `${rootSlug}:${nameKey(path.posix.resolve("/", logicalPath))}`;
const sourceBusy = () => new AppError(409, "This file is still being copied or moved by another task", "CONVERT_SOURCE_BUSY");

/** Converting media with ffmpeg: files picked by hand, folders gone through by a saved job, and tracks packed into Matroska. */
export class ConvertService {
  private readonly ffmpeg = process.env.FFMPEG_PATH ?? "ffmpeg";
  private readonly ffprobe = process.env.FFPROBE_PATH ?? "ffprobe";

  constructor(
    private readonly db: Db,
    private readonly paths: PathService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly appDataDir: string,
    private readonly trash: (actor: Actor, safe: SafePath) => Promise<void>
  ) {}

  private supported: Promise<ConvertSupport> | null = null;

  /** What can be made here, found out once. */
  support(): Promise<ConvertSupport> {
    this.supported ??= Promise.all([convertSupport(this.ffmpeg), this.accel()]).then(([support, accel]) => {
      if (!support.available || !accel) return support;
      const onGpu = [...accel.codecs.map((codec) => `${codec}-hw`), ...accel.deep.map((codec) => `${codec}-hw-10`)];
      return { ...support, videoCodecs: [...support.videoCodecs, ...onGpu], hardware: { device: accel.device, codecs: accel.codecs } };
    });
    return this.supported;
  }

  private detected: Promise<ConvertAccel | null> | null = null;

  /** The GPU conversions are handed to, looked for once. */
  private accel(): Promise<ConvertAccel | null> {
    this.detected ??= detectConvertAccel(this.ffmpeg).catch(() => null);
    return this.detected;
  }

  private async folder(ref: FileRef): Promise<SafePath> {
    const safe = await this.paths.resolveExisting(ref.rootSlug, ref.path);
    if (!(await this.storage.stat(safe)).isDirectory()) throw new AppError(400, "Path is not a folder", "NOT_FOLDER");
    return safe;
  }

  /** A folder new files may be put in by the actor. */
  private async writableFolder(actor: Actor, ref: FileRef): Promise<SafePath> {
    const safe = await this.folder(ref);
    this.permissions.require(actor, "edit", safe.root, safe.logicalPath);
    if (isRemote(safe.root) && this.storage.remote.isFixed(safe.root, path.posix.join(safe.logicalPath, "new"))) throw sharesAreFixed();
    return safe;
  }

  private async file(actor: Actor, ref: FileRef): Promise<{ safe: SafePath; stat: FileStat }> {
    const safe = await this.paths.resolveExisting(ref.rootSlug, ref.path);
    this.permissions.require(actor, "view", safe.root, safe.logicalPath);
    const stat = await this.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(400, "Only files can be converted", "NOT_FILE");
    return { safe, stat };
  }

  async assertConvert(actor: Actor, input: ConvertInput): Promise<void> {
    await this.writableFolder(actor, input.destination);
    const busy = this.busyPlaces();
    for (const source of input.sources) {
      const { safe } = await this.file(actor, source);
      if (this.isBusy(safe.root.slug, safe.logicalPath, busy)) throw sourceBusy();
    }
  }

  /** Where Kago's own running tasks are still writing, or for a move still taking away. */
  private busyPlaces(): string[] {
    const tasks = this.db.prepare(`SELECT type, sources_json, destination FROM tasks WHERE status = 'running' AND type IN (${writerTypes.map(() => "?").join(", ")})`).all(...writerTypes) as Array<Pick<FileTask, "type" | "sources_json" | "destination">>;
    const places: string[] = [];
    for (const task of tasks) {
      const destination = JSON.parse(task.destination ?? "{}") as Partial<FileRef> & { sync?: { destination?: Partial<FileRef> } };
      const into = task.type === "sync" ? destination.sync?.destination : destination;
      if (into?.rootSlug && into.path) places.push(placeKey(into.rootSlug, into.path));
      // A move between disks takes its sources away only once they have arrived.
      if (task.type === "move") for (const source of JSON.parse(task.sources_json) as FileRef[]) places.push(placeKey(source.rootSlug, source.path));
    }
    return places;
  }

  private isBusy(rootSlug: string, logicalPath: string, places: string[]): boolean {
    const key = placeKey(rootSlug, logicalPath);
    return places.some((place) => key === place || key.startsWith(place.endsWith("/") ? place : `${place}/`));
  }

  /** Checks both ends of a job and returns the folders they are. */
  async assertJob(actor: Actor, job: { input: FileRef; destination: FileRef; options: ConvertJobOptions }): Promise<{ input: SafePath; destination: SafePath }> {
    const input = await this.folder(job.input);
    this.permissions.require(actor, job.options.after === "keep" ? "view" : "edit", input.root, input.logicalPath);
    const destination = await this.writableFolder(actor, job.destination);
    if (input.root.id === destination.root.id) {
      const inside = (outer: string, inner: string) => outer === "/" || inner === outer || inner.startsWith(`${outer}/`);
      // What comes out would be taken for something that came in.
      if (inside(input.logicalPath, destination.logicalPath) || inside(destination.logicalPath, input.logicalPath)) {
        throw new AppError(400, "The input folder and the destination overlap", "CONVERT_OVERLAP");
      }
    }
    return { input, destination };
  }

  async assertRemux(actor: Actor, input: RemuxInputSpec): Promise<void> {
    const { safe } = await this.file(actor, input.source);
    await this.writableFolder(actor, { rootSlug: safe.root.slug, path: path.posix.dirname(safe.logicalPath) });
    for (const track of input.tracks) if (track.from === "file") await this.file(actor, track.file);
  }

  async run(task: FileTask, actor: Actor, handle: TaskHandle): Promise<void> {
    const { convert: spec, job, ...destination } = JSON.parse(task.destination ?? "{}") as FileRef & { convert?: unknown; job?: ConvertJobRun };
    const parsed = convertSpecSchema.parse(spec);
    if (job) return this.runJob(task.id, actor, { ...job, options: convertJobOptionsSchema.parse(job.options) }, destination, parsed, handle);

    const input = convertInputSchema.parse({ sources: JSON.parse(task.sources_json), destination, spec: parsed });
    const folder = await this.writableFolder(actor, input.destination);
    const sources = [];
    for (const source of input.sources) sources.push(await this.file(actor, source));
    await handle.totals(sources.length, sources.reduce((sum, source) => sum + source.stat.size, 0));
    const taken = await this.taken(folder);
    // What the folder held before this run: a source whose conversion is already among it was done by an earlier one.
    const present = new Set(taken);
    let failed = 0;
    for (const { safe, stat } of sources) {
      const output = nameKey(outputName(this.storage.name(safe), parsed.format));
      const itself = folder.root.id === safe.root.id && nameKey(path.posix.join(folder.logicalPath, output)) === nameKey(safe.logicalPath);
      if (present.has(output) && !itself) {
        handle.bytes(stat.size);
        handle.files(1);
        continue;
      }
      handle.show(safe.logicalPath);
      try {
        if (this.isBusy(safe.root.slug, safe.logicalPath, this.busyPlaces())) throw sourceBusy();
        const made = await this.convertOne(safe, stat, folder, taken, parsed, false, handle);
        this.audit.write({ actorType: "user", actorId: actor.id, action: "convert", rootId: safe.root.id, path: safe.logicalPath, target: { rootSlug: folder.root.slug, path: path.posix.join(folder.logicalPath, made.name), format: parsed.format }, result: "success" });
      } catch (error) {
        if (error instanceof ConvertStopped || sources.length === 1) throw error;
        failed += 1;
      }
      handle.files(1);
    }
    if (failed > 0) throw new AppError(422, "Some files couldn’t be converted", "CONVERT_PARTLY_FAILED");
  }

  /** Goes through a job's input folder and brings what is new in it to the destination, keeping the folders it lies in. */
  private async runJob(taskId: string, actor: Actor, job: ConvertJobRun, destinationRef: FileRef, spec: ConvertSpec, handle: TaskHandle): Promise<void> {
    const counts = { converted: 0, copied: 0, failed: 0 };
    try {
      await this.runJobFiles(taskId, actor, job, destinationRef, spec, handle, counts);
    } finally {
      // What the run got done is said in its record however it ended.
      this.db.prepare("UPDATE convert_runs SET converted = ?, copied = ?, failed = ? WHERE task_id = ?").run(counts.converted, counts.copied, counts.failed, taskId);
    }
    if (counts.failed > 0) throw new AppError(422, "Some files couldn’t be converted", "CONVERT_PARTLY_FAILED");
  }

  private async runJobFiles(taskId: string, actor: Actor, job: ConvertJobRun, destinationRef: FileRef, spec: ConvertSpec, handle: TaskHandle, counts: { converted: number; copied: number; failed: number }): Promise<void> {
    const { input, destination } = await this.assertJob(actor, { input: job.input, destination: destinationRef, options: job.options });
    const busy = this.busyPlaces();
    const work = (await this.pendingFiles(job.id, input, destination, spec, job.options, job.retryFailed ?? false)).filter((file) => Date.now() - file.mtimeMs > SETTLE_MS && !this.isBusy(input.root.slug, path.posix.join(input.logicalPath, file.rel), busy));
    await handle.totals(work.length, work.reduce((sum, file) => sum + file.size, 0));
    const folders = new Map<string, { folder: SafePath; taken: Set<string> }>();
    // The run's own record of the file, with what it measured before and after.
    const record = this.db.prepare("INSERT INTO convert_run_files (task_id, path, status, size_in, size_out) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM convert_runs WHERE task_id = ?)");
    for (const file of work) {
      const logical = path.posix.join(input.logicalPath, file.rel);
      // Something began writing here since the run started; the next look brings it across once that is done.
      if (this.isBusy(input.root.slug, logical, this.busyPlaces())) {
        handle.files(1);
        continue;
      }
      handle.show(logical);
      try {
        const safe = await this.paths.resolveExisting(input.root.slug, logical);
        const stat = await this.storage.stat(safe);
        const dir = path.posix.dirname(file.rel) === "." ? "" : path.posix.dirname(file.rel);
        let target = folders.get(dir);
        if (!target) {
          const folder = await this.ensureFolder(destination, dir);
          target = { folder, taken: await this.taken(folder) };
          folders.set(dir, target);
        }
        const name = this.storage.name(safe);
        const made = jobConverts(name, spec.format, job.options.extensions)
          ? await this.convertOne(safe, stat, target.folder, target.taken, spec, job.options.keepSmaller, handle)
          : { name: await this.copyOriginal(safe, stat, target.folder, target.taken, handle), copied: true, size: stat.size };
        this.audit.write({ actorType: "user", actorId: actor.id, action: "convert", rootId: safe.root.id, path: safe.logicalPath, target: { jobId: job.id, rootSlug: destination.root.slug, path: path.posix.join(target.folder.logicalPath, made.name), copied: made.copied }, result: "success" });
        if (job.options.after === "trash") await this.trash(actor, safe);
        else if (job.options.after === "delete") {
          if (isRemote(safe.root)) await this.storage.remote.remove(safe.root, safe.logicalPath, false);
          else await fsp.rm(safe.absolutePath);
        }
        if (made.copied) counts.copied += 1;
        else counts.converted += 1;
        record.run(taskId, file.rel, made.copied ? "copied" : "converted", stat.size, made.size, taskId);
      } catch (error) {
        if (error instanceof ConvertStopped) throw error;
        counts.failed += 1;
        // The run's record is also what keeps a watched folder from trying it again at every look; see `failedFiles`.
        record.run(taskId, file.rel, "failed", file.size, null, taskId);
        logger.warn("auto-convert could not bring a file across", { jobId: job.id, path: logical, error: error instanceof Error ? error.message : String(error) });
      }
      handle.files(1);
    }
  }

  /** How many files of a job's input folder are waiting, have stopped changing and are no task's to write. `seen` is what each measured at the last look. */
  async ready(job: { id: string; input: FileRef; destination: FileRef; spec: ConvertSpec; options: ConvertJobOptions }, seen: Map<string, number>): Promise<number> {
    const input = await this.folder(job.input);
    const pending = await this.pendingFiles(job.id, input, await this.folder(job.destination), job.spec, job.options, false);
    const busy = this.busyPlaces();
    const ready = pending.filter((file) => Date.now() - file.mtimeMs > SETTLE_MS && seen.get(file.rel) === file.size && !this.isBusy(input.root.slug, path.posix.join(input.logicalPath, file.rel), busy)).length;
    seen.clear();
    for (const file of pending) seen.set(file.rel, file.size);
    return ready;
  }

  /**
   * The files of a job's input folder it has still to bring across. What is done is told by the destination alone:
   * a file is, once the folder it mirrors into holds its conversion, or the file itself where that was kept or copied.
   */
  private async pendingFiles(jobId: string, input: SafePath, destination: SafePath, spec: ConvertSpec, options: ConvertJobOptions, retryFailed: boolean): Promise<Walked[]> {
    const there = new Map<string, Promise<Set<string>>>();
    const namesThere = (dir: string) => {
      let names = there.get(dir);
      if (!names) {
        names = this.paths.resolveExisting(destination.root.slug, path.posix.join(destination.logicalPath, dir)).then(
          async (folder) => new Set((await this.storage.names(folder)).map(nameKey)),
          () => new Set<string>()
        );
        there.set(dir, names);
      }
      return names;
    };
    const failed = retryFailed ? new Map<string, number>() : this.failedFiles(jobId);
    const pending: Walked[] = [];
    for (const file of await this.walk(input)) {
      const name = path.posix.basename(file.rel);
      if (file.directory || !(options.copyOthers || jobConverts(name, spec.format, options.extensions))) continue;
      if (failed.get(file.rel) === file.size) continue;
      const names = await namesThere(path.posix.dirname(file.rel) === "." ? "" : path.posix.dirname(file.rel));
      if (names.has(nameKey(name)) || names.has(nameKey(outputName(name, spec.format)))) continue;
      pending.push(file);
    }
    return pending;
  }

  /**
   * The files of a job its runs could not bring across since this was loaded, with the size each had then. Left alone
   * until they change or the job is run by hand, as a watched folder would otherwise try them at every look; Kago's next start tries them again.
   */
  failedFiles(jobId: string): Map<string, number> {
    const records = this.db
      .prepare("SELECT f.path, f.status, f.size_in FROM convert_run_files f JOIN convert_runs r ON r.task_id = f.task_id WHERE r.job_id = ? AND r.started_at >= ? ORDER BY r.started_at, r.rowid, f.rowid")
      .all(jobId, Math.floor(LOADED_AT / 1000)) as Array<{ path: string; status: string; size_in: number }>;
    const failed = new Map<string, number>();
    for (const record of records) {
      if (record.status === "failed") failed.set(record.path, record.size_in);
      else failed.delete(record.path);
    }
    return failed;
  }

  /** Makes in `to` every folder `from` has under it, and nothing else. */
  async copyStructure(actor: Actor, fromRef: FileRef, toRef: FileRef): Promise<{ created: number }> {
    const from = await this.folder(fromRef);
    this.permissions.require(actor, "view", from.root, from.logicalPath);
    const to = await this.writableFolder(actor, toRef);
    const folders = (await this.walk(from)).filter((entry) => entry.directory);
    if (folders.length > MAX_STRUCTURE_FOLDERS) throw new AppError(413, "This folder has too many folders in it to copy its structure", "CONVERT_STRUCTURE_TOO_LARGE");
    const before = new Set((await this.walk(to)).filter((entry) => entry.directory).map((entry) => nameKey(entry.rel)));
    let created = 0;
    // Parents come before what they hold, so each is there by the time its children are made.
    for (const entry of folders) {
      if (before.has(nameKey(entry.rel))) continue;
      await this.ensureFolder(to, entry.rel);
      created += 1;
    }
    this.audit.write({ actorType: "user", actorId: actor.id, action: "convert_structure", rootId: to.root.id, path: to.logicalPath, target: { from: { rootSlug: from.root.slug, path: from.logicalPath }, created }, result: "success" });
    return { created };
  }

  /** Everything under a folder, parents first, by its path from there. Hidden and system entries are passed over, with all they hold. */
  private async walk(folder: SafePath): Promise<Walked[]> {
    const hidden = (rel: string) => rel.split("/").some((segment) => segment.startsWith(".") || isSystemFile(segment));
    if (isRemote(folder.root)) {
      return (await this.storage.remote.walk(folder.root, folder.logicalPath)).filter((entry) => !hidden(entry.path)).map((entry) => ({ rel: entry.path, size: entry.size, mtimeMs: entry.mtimeMs, directory: entry.directory }));
    }
    const found: Walked[] = [];
    const visit = async (absolute: string, rel: string): Promise<void> => {
      const entries = (await fsp.readdir(absolute, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1));
      for (const entry of entries) {
        const child = rel ? `${rel}/${entry.name}` : entry.name;
        if (hidden(entry.name) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          found.push({ rel: child, size: 0, mtimeMs: 0, directory: true });
          await visit(path.join(absolute, entry.name), child);
        } else if (entry.isFile()) {
          const stat = await fsp.stat(path.join(absolute, entry.name)).catch(() => null);
          if (stat) found.push({ rel: child, size: stat.size, mtimeMs: stat.mtimeMs, directory: false });
        }
      }
    };
    await visit(folder.absolutePath, "");
    return found;
  }

  /** The folder `rel` under `base`, made one step at a time where it is not there yet. */
  private async ensureFolder(base: SafePath, rel: string): Promise<SafePath> {
    let current = base;
    for (const segment of rel.split("/").filter(Boolean)) {
      const logical = path.posix.join(current.logicalPath, segment);
      const existing = await this.paths.resolveExisting(base.root.slug, logical).catch(() => null);
      if (existing) {
        current = existing;
        continue;
      }
      const target = await this.paths.resolveForCreate(base.root.slug, logical);
      if (isRemote(target.root)) await this.storage.remote.mkdir(target.root, target.logicalPath);
      else await fsp.mkdir(target.absolutePath).catch((error: unknown) => (isCode(error, "EEXIST") ? undefined : Promise.reject(error)));
      current = await this.paths.resolveExisting(base.root.slug, target.logicalPath);
    }
    if (!(await this.storage.stat(current)).isDirectory()) throw new AppError(409, "Target already exists", "TARGET_EXISTS");
    return current;
  }

  /** The names in a folder new files are going to, once what a conversion cut short left half-written there is gone. */
  private async taken(folder: SafePath): Promise<Set<string>> {
    await this.clearStale(isRemote(folder.root) ? path.join(this.appDataDir, "temp", "convert") : folder.absolutePath);
    return new Set((await this.storage.names(folder)).map(nameKey));
  }

  private async clearStale(dir: string): Promise<void> {
    const names = await fsp.readdir(dir).catch(() => []);
    for (const name of names) {
      if (!name.startsWith(CONVERT_PARTIAL)) continue;
      const full = path.join(dir, name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat?.isFile() && stat.mtimeMs < LOADED_AT) await fsp.rm(full, { force: true }).catch(() => undefined);
    }
  }

  /** A name no entry of the folder has yet: the one asked for, or it with a number after it. The name is then spoken for. */
  private freeName(taken: Set<string>, wanted: string): string {
    const extension = path.extname(wanted);
    const base = wanted.slice(0, wanted.length - extension.length);
    let name = nfc(wanted);
    for (let count = 2; taken.has(nameKey(name)); count += 1) name = nfc(`${base} (${count})${extension}`);
    taken.add(nameKey(name));
    return name;
  }

  /** Where a file is written before it is whole: beside where it will lie on disk, or for a remote in the app data. */
  private async partial(folder: SafePath, extension: string): Promise<string> {
    const name = `${CONVERT_PARTIAL}${id("part")}.${extension}`;
    if (!isRemote(folder.root)) return path.join(folder.absolutePath, name);
    const dir = path.join(this.appDataDir, "temp", "convert");
    await fsp.mkdir(dir, { recursive: true });
    return path.join(dir, name);
  }

  private async place(partial: string, folder: SafePath, name: string): Promise<void> {
    if (isRemote(folder.root)) await this.storage.remote.write(folder.root, path.posix.join(folder.logicalPath, name), createReadStream(partial));
    else await fsp.rename(partial, path.join(folder.absolutePath, name));
  }

  /** Converts one file into the folder. Resolves to the name of what lies there now, and whether that is the file itself and not a conversion of it. */
  private async convertOne(source: SafePath, stat: FileStat, folder: SafePath, taken: Set<string>, spec: ConvertSpec, keepSmaller: boolean, handle: TaskHandle): Promise<{ name: string; copied: boolean; /** How large what lies there is. */ size: number }> {
    const own = this.storage.name(source);
    const input = this.storage.mediaInput(source);
    let counted = 0;
    const count = (bytes: number) => {
      const upTo = Math.min(stat.size, Math.max(counted, Math.round(bytes)));
      handle.bytes(upTo - counted);
      counted = upTo;
    };
    const partial = await this.partial(folder, spec.format);
    try {
      const probe = await probeMedia(this.ffprobe, input);
      const accel = await this.accel();
      const encode = (gpu: ConvertAccel | null) => runFfmpeg(this.ffmpeg, convertArgs(spec, probe, input, partial, gpu), (seconds) => count(probe.duration > 0 ? (stat.size * seconds) / probe.duration : 0), handle.stopped);
      if (!usesHardware(spec, accel)) await encode(null);
      else {
        // A file the GPU chokes on (an odd size, a profile the driver lacks) is still one the CPU can do.
        await encode(accel).catch((error: unknown) => {
          if (error instanceof ConvertStopped) throw error;
          logger.warn("hardware conversion failed; trying again in software", { path: source.logicalPath, device: accel.device });
          return encode(null);
        });
      }
      const made = await fsp.stat(partial);
      if (made.size === 0) throw new AppError(422, "This file couldn’t be converted", "CONVERT_FAILED");
      if (keepSmaller && made.size >= stat.size) {
        await fsp.rm(partial, { force: true });
        return { name: await this.copyOriginal(source, stat, folder, taken), copied: true, size: stat.size };
      }
      const name = this.freeName(taken, outputName(own, spec.format));
      await this.place(partial, folder, name);
      return { name, copied: false, size: made.size };
    } finally {
      await fsp.rm(partial, { force: true });
      count(stat.size);
    }
  }

  /** Puts the file itself in the folder, under its own name where that is free. */
  private async copyOriginal(source: SafePath, stat: FileStat, folder: SafePath, taken: Set<string>, handle?: TaskHandle): Promise<string> {
    const name = this.freeName(taken, this.storage.name(source));
    const stream = await this.storage.source(source, stat).open();
    if (isRemote(folder.root)) await this.storage.remote.write(folder.root, path.posix.join(folder.logicalPath, name), stream);
    else {
      const partial = await this.partial(folder, "part");
      try {
        await pipeline(stream, createWriteStream(partial));
        await fsp.utimes(partial, stat.mtime, stat.mtime).catch(() => undefined);
        await fsp.rename(partial, path.join(folder.absolutePath, name));
      } finally {
        await fsp.rm(partial, { force: true });
      }
    }
    handle?.bytes(stat.size);
    return name;
  }

  /** Packs the chosen tracks of a video, and of the files brought to it, into one Matroska file beside it. */
  async runRemux(task: FileTask, actor: Actor, handle: TaskHandle): Promise<void> {
    const spec = remuxInputSchema.parse((JSON.parse(task.destination ?? "{}") as { remux?: unknown }).remux);
    const { safe: source, stat } = await this.file(actor, spec.source);
    const folder = await this.writableFolder(actor, { rootSlug: source.root.slug, path: path.posix.dirname(source.logicalPath) });
    const name = nfc(/\.mk[va]$/i.test(spec.name) ? spec.name : `${spec.name}.mkv`);
    await this.storage.assertNameAvailable(folder, name);
    await this.taken(folder);
    await handle.totals(1, stat.size);
    handle.show(source.logicalPath);

    const input = this.storage.mediaInput(source);
    const probe = await probeMedia(this.ffprobe, input, MEDIA_FORMATS);
    const inputs: RemuxInput[] = [{ input, formats: MEDIA_FORMATS }];
    const tracks: RemuxTrack[] = [];
    for (const track of spec.tracks) {
      const flags = { language: track.language, title: track.title, default: track.default, forced: track.forced, type: track.kind };
      if (track.from === "source") {
        const stream = probe.streams.filter((item) => item.type === track.kind && !item.attachedPic)[track.index];
        if (!stream) throw new AppError(400, "The video no longer has one of the chosen tracks", "REMUX_TRACK_MISSING");
        // The one form of text QuickTime keeps cannot lie in Matroska as it is.
        tracks.push({ ...flags, input: 0, map: String(stream.index), codec: stream.codec === "mov_text" ? "srt" : undefined });
        continue;
      }
      const added = await this.file(actor, track.file);
      const addedInput = this.storage.mediaInput(added.safe);
      const formats = track.kind === "subtitle" ? SUBTITLE_FORMATS : MEDIA_FORMATS;
      const addedProbe = await probeMedia(this.ffprobe, addedInput, formats);
      const stream = addedProbe.streams.find((item) => item.type === track.kind);
      if (!stream && track.kind === "audio") throw new AppError(422, "One of the added files has no sound in it", "REMUX_FILE_UNUSABLE");
      if (!stream) throw new AppError(422, "One of the added files has no subtitles in it", "REMUX_FILE_UNUSABLE");
      inputs.push({ input: addedInput, formats });
      tracks.push({ ...flags, input: inputs.length - 1, map: String(stream.index), codec: stream.codec === "mov_text" ? "srt" : undefined });
    }

    let counted = 0;
    const partial = await this.partial(folder, "mkv");
    try {
      await runFfmpeg(this.ffmpeg, remuxArgs(inputs, tracks, { attachments: spec.attachments, chapters: spec.chapters, title: spec.title }, partial), (seconds) => {
        const upTo = Math.min(stat.size, Math.max(counted, probe.duration > 0 ? Math.round((stat.size * seconds) / probe.duration) : 0));
        handle.bytes(upTo - counted);
        counted = upTo;
      }, handle.stopped);
      await this.storage.assertNameAvailable(folder, name);
      await this.place(partial, folder, name);
    } finally {
      await fsp.rm(partial, { force: true });
    }
    handle.bytes(stat.size - counted);
    handle.files(1);
    this.audit.write({ actorType: "user", actorId: actor.id, action: "remux", rootId: source.root.id, path: source.logicalPath, target: { rootSlug: folder.root.slug, path: path.posix.join(folder.logicalPath, name), tracks: tracks.length }, result: "success" });
  }
}

const isCode = (error: unknown, code: string) => Boolean(error && typeof error === "object" && "code" in error && error.code === code);
