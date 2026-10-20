import path from "node:path";
import type { Db } from "../db/db.js";
import type { FsChanged } from "../ws/events.js";
import type { FileRef, FileTask } from "./types.js";

type Destination = Partial<FileRef> & { job?: { input?: FileRef }; sync?: { destination?: FileRef; options?: { dryRun?: boolean } } };

/**
 * What a finished task changed in the locations, by location, for whoever may see them to hear of it. Tasks that only
 * read (a download's archive, thumbnails, a sync's trial run) change nothing there.
 */
export function taskChanges(db: Db, task: FileTask): FsChanged[] {
  const sources = JSON.parse(task.sources_json) as FileRef[];
  const destination = JSON.parse(task.destination ?? "{}") as Destination;
  const changes = new Map<string, { paths: Set<string>; gone: Set<string>; trees: Set<string> }>();
  const at = (rootSlug: string) => changes.get(rootSlug) ?? changes.set(rootSlug, { paths: new Set(), gone: new Set(), trees: new Set() }).get(rootSlug)!;
  const folder = (ref: FileRef) => at(ref.rootSlug).paths.add(ref.path);
  const leaving = (ref: FileRef) => {
    at(ref.rootSlug).paths.add(path.posix.dirname(ref.path));
    at(ref.rootSlug).gone.add(ref.path);
  };
  const into = destination.rootSlug && destination.path ? { rootSlug: destination.rootSlug, path: destination.path } : undefined;

  if (task.type === "copy" && into) folder(into);
  else if (task.type === "move" && into) {
    folder(into);
    sources.forEach(leaving);
  } else if (task.type === "delete_to_trash" || task.type === "delete") sources.forEach(leaving);
  else if (task.type === "restore_trash") {
    // Each source names an item of the Trash, which remembers where it came from.
    for (const source of sources) {
      const item = db.prepare("SELECT roots.slug AS rootSlug, trash_items.original_path AS path FROM trash_items JOIN roots ON roots.id = trash_items.original_root_id WHERE trash_items.id = ?").get(source.path) as FileRef | undefined;
      if (item) folder({ rootSlug: item.rootSlug, path: path.posix.dirname(item.path) });
    }
  } else if (task.type === "compress" && into) folder({ rootSlug: into.rootSlug, path: path.posix.dirname(into.path) });
  else if (task.type === "extract" && into) at(into.rootSlug).trees.add(into.path);
  else if (task.type === "remux" && into) folder(into);
  else if (task.type === "convert" && into) {
    // A saved job keeps the folders it finds things in, and may clear out its input folder as it goes.
    if (destination.job?.input) {
      at(into.rootSlug).trees.add(into.path);
      at(destination.job.input.rootSlug).trees.add(destination.job.input.path);
    } else folder(into);
  } else if (task.type === "sync" && destination.sync?.destination && !destination.sync.options?.dryRun) {
    at(destination.sync.destination.rootSlug).trees.add(destination.sync.destination.path);
  }

  return [...changes].map(([rootSlug, { paths, gone, trees }]) => ({
    type: "fs.changed",
    rootSlug,
    paths: [...paths],
    ...(gone.size > 0 ? { gone: [...gone] } : {}),
    ...(trees.size > 0 ? { trees: [...trees] } : {})
  }));
}
