import path from "node:path";
import type { TaskType } from "@kago/contract";
import type { Db } from "../db/db.js";
import type { FsChanged } from "../ws/events.js";
import type { TaskService } from "./task.service.js";
import type { Actor, FileRef, FileTask } from "./types.js";

/**
 * Tasks wait in two lines, each with a worker of its own. Converting takes hours where copying takes minutes, so it
 * has a line to itself: `media` for conversions, `files` for everything else.
 */
export type TaskLane = "files" | "media";

/** A task's destination, read only as far as the kinds here need. */
export type TaskDestination = Partial<FileRef> & {
  job?: { id?: string; input?: FileRef };
  sync?: { jobId?: string; destination?: FileRef; options?: { dryRun?: boolean } };
};

/** What `changes` is given: the finished task, and the ways to say what it changed. */
type Announce = {
  db: Db;
  sources: FileRef[];
  destination: TaskDestination;
  /** The folder or file its destination names, when it names one. */
  into?: FileRef;
  /** A folder that holds something else now. */
  folder(ref: FileRef): void;
  /** An item no longer where it was. */
  leaving(ref: FileRef): void;
  /** A folder anything inside which may have changed. */
  tree(ref: FileRef): void;
};

export type TaskKind = {
  lane: TaskLane;
  run(tasks: TaskService, task: FileTask, actor: Actor): Promise<void>;
  /**
   * What a retry checks again before it queues the task as it was. A type asked for through `create` gives back what
   * that logged of it, which the retry logs again.
   */
  recheck(tasks: TaskService, task: FileTask, actor: Actor): Promise<object | void>;
  /** What finishing it changed in the locations. Tasks that only read change nothing there. */
  changes(announce: Announce): void;
  /** The saved job it is a run of, as its destination names it. */
  jobOf?(destination: TaskDestination): string | undefined;
};

const asked: TaskKind["recheck"] = (tasks, task, actor) => tasks.assertInputTask(actor, task);
const media: TaskKind["recheck"] = (tasks, task, actor) => tasks.assertMediaTask(actor, task);
const nothing = () => undefined;

/** What every type of task means, by type. */
export const taskKinds: Record<TaskType, TaskKind> = {
  copy: {
    lane: "files",
    run: (tasks, task, actor) => tasks.runCopyLike(task, actor, false),
    recheck: asked,
    changes: ({ into, folder }) => into && folder(into)
  },
  move: {
    lane: "files",
    run: (tasks, task, actor) => tasks.runCopyLike(task, actor, true),
    recheck: asked,
    changes: ({ into, sources, folder, leaving }) => {
      if (!into) return;
      folder(into);
      sources.forEach(leaving);
    }
  },
  delete_to_trash: {
    lane: "files",
    run: (tasks, task, actor) => tasks.runTrash(task, actor),
    recheck: asked,
    changes: ({ sources, leaving }) => sources.forEach(leaving)
  },
  delete: {
    lane: "files",
    run: (tasks, task, actor) => tasks.runDelete(task, actor),
    recheck: asked,
    changes: ({ sources, leaving }) => sources.forEach(leaving)
  },
  restore_trash: {
    lane: "files",
    run: (tasks, task, actor) => tasks.runRestore(task, actor),
    recheck: asked,
    changes: ({ db, sources, folder }) => {
      // Each source names an item of the Trash, which remembers where it came from.
      for (const source of sources) {
        const item = db.prepare("SELECT roots.slug AS rootSlug, trash_items.original_path AS path FROM trash_items JOIN roots ON roots.id = trash_items.original_root_id WHERE trash_items.id = ?").get(source.path) as FileRef | undefined;
        if (item) folder({ rootSlug: item.rootSlug, path: path.posix.dirname(item.path) });
      }
    }
  },
  empty_trash: { lane: "files", run: (tasks, task, actor) => tasks.runEmptyTrash(task, actor), recheck: asked, changes: nothing },
  compress: {
    lane: "files",
    run: (tasks, task, actor) => tasks.runCompress(task, actor),
    recheck: asked,
    changes: ({ into, folder }) => into && folder({ rootSlug: into.rootSlug, path: path.posix.dirname(into.path) })
  },
  download_zip: { lane: "files", run: (tasks, task, actor) => tasks.runDownloadZip(task, actor), recheck: asked, changes: nothing },
  extract: {
    lane: "files",
    run: (tasks, task, actor) => tasks.runExtract(task, actor),
    recheck: asked,
    changes: ({ into, tree }) => into && tree(into)
  },
  thumbnail: { lane: "files", run: (tasks, task, actor) => tasks.runThumbnail(task, actor), recheck: asked, changes: nothing },
  sync: {
    lane: "files",
    run: (tasks, task, actor) => tasks.runSync(task, actor),
    recheck: (tasks, task, actor) => tasks.assertSyncTask(actor, task),
    changes: ({ destination: { sync }, tree }) => sync?.destination && !sync.options?.dryRun && tree(sync.destination),
    jobOf: (destination) => destination.sync?.jobId
  },
  convert: {
    lane: "media",
    run: (tasks, task, actor) => tasks.convert.run(task, actor, tasks.handle(task.id)),
    recheck: media,
    changes: ({ into, destination: { job }, folder, tree }) => {
      if (!into) return;
      // A saved job keeps the folders it finds things in, and may clear out its input folder as it goes.
      if (job?.input) {
        tree(into);
        tree(job.input);
      } else folder(into);
    },
    jobOf: (destination) => destination.job?.id
  },
  remux: {
    lane: "media",
    run: (tasks, task, actor) => tasks.convert.runRemux(task, actor, tasks.handle(task.id)),
    recheck: media,
    changes: ({ into, folder }) => into && folder(into)
  }
};

/** The types whose tasks wait in the `media` lane. */
export const mediaTaskTypes = (Object.keys(taskKinds) as TaskType[]).filter((type) => taskKinds[type].lane === "media");

/** What a finished task changed in the locations, by location, for whoever may see them to hear of it. */
export function taskChanges(db: Db, task: FileTask): FsChanged[] {
  const sources = JSON.parse(task.sources_json) as FileRef[];
  const destination = JSON.parse(task.destination ?? "{}") as TaskDestination;
  const changes = new Map<string, { paths: Set<string>; gone: Set<string>; trees: Set<string> }>();
  const at = (rootSlug: string) => changes.get(rootSlug) ?? changes.set(rootSlug, { paths: new Set(), gone: new Set(), trees: new Set() }).get(rootSlug)!;
  taskKinds[task.type].changes({
    db,
    sources,
    destination,
    into: destination.rootSlug && destination.path ? { rootSlug: destination.rootSlug, path: destination.path } : undefined,
    folder: (ref) => at(ref.rootSlug).paths.add(ref.path),
    leaving: (ref) => {
      at(ref.rootSlug).paths.add(path.posix.dirname(ref.path));
      at(ref.rootSlug).gone.add(ref.path);
    },
    tree: (ref) => at(ref.rootSlug).trees.add(ref.path)
  });
  return [...changes].map(([rootSlug, { paths, gone, trees }]) => ({
    type: "fs.changed",
    rootSlug,
    paths: [...paths],
    ...(gone.size > 0 ? { gone: [...gone] } : {}),
    ...(trees.size > 0 ? { trees: [...trees] } : {})
  }));
}
