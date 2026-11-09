import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, ApiError, apiLines, downloadUrl, serverMessage } from "@/api/client";
import { dropLeft } from "@/api/hooks";
import { formatSize } from "@/lib/format";
import { baseName, ensureZipName, isInside, isWithin, joinLogicalPath, needsNormalizing, nfc, parentPath, triggerDownload } from "@/lib/paths";
import { run } from "@/lib/run";
import { randomId } from "@/lib/utils";
import type { UploadTree } from "@/lib/uploadTree";
import { useClipboardStore, type FileRef } from "@/stores/clipboard";
import { chooseAction, promptText } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import { hideLeaving, leavingSettled, showLeaving } from "@/stores/leaving";
import { followTask } from "@/features/tasks/taskToast";
import { isUploadCancelled, uploadForm, uploadLabel } from "@/stores/uploads";
import { folderTitle, useWorkspaceStore } from "@/stores/workspace";
import { startExtract } from "./ArchivePassword";
import { askConflicts, resolveConflicts, type Conflict, type ConflictChoices } from "./TransferConflicts";
import { MAX_BATCH_RENAME, promptBatchRename } from "./BatchRenameDialog";
import { promptCompress } from "./CompressDialog";
import { promptConvert } from "@/features/convert/ConvertDialog";
import type { MediaKind } from "@/features/convert/convertSpec";
import type { FileItem, FileList, FileTask, FileWindow } from "@/types/kago";
import { t } from "@/lib/i18n";

export type { FileRef };

/** The server takes at most this many files per upload request. */
const uploadBatchSize = 20;

export const KAGO_DRAG_TYPE = "application/kago-files";

export function readDraggedFiles(dataTransfer: DataTransfer): FileRef[] {
  try {
    const parsed = JSON.parse(dataTransfer.getData(KAGO_DRAG_TYPE) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item?.rootSlug === "string" && typeof item?.path === "string") : [];
  } catch {
    return [];
  }
}

/** Download archives requested in this tab; each one starts downloading as soon as its task finishes. */
export const pendingDownloads = new Set<string>();

/**
 * `leaving` are hidden from their folders before the task is asked for: a quick one is over before its id is back,
 * and hiding them only then would leave them hidden for good.
 */
async function createTask(queryClient: QueryClient, body: Record<string, unknown>, leaving?: FileRef[]) {
  const asking = leaving && `asking:${randomId()}`;
  if (asking) hideLeaving(asking, leaving);
  let task: FileTask;
  try {
    task = await api<FileTask>("/api/tasks", { method: "POST", body: JSON.stringify(body) });
  } finally {
    if (asking) showLeaving(asking);
  }
  // Its end may have been heard before this answer: finished, what it carried is taken out of the listings that kept it.
  if (leaving && leavingSettled(task.id)) dropLeft(queryClient, leaving);
  if (leaving) hideLeaving(task.id, leaving);
  await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  return task;
}

const isInFolder = (source: FileRef, folder: FileRef) => source.rootSlug === folder.rootSlug && parentPath(source.path) === folder.path;

/**
 * Leaves out whatever is inside another of the items. A selection can hold a folder and what is in it, when the folder
 * is open in place; acting on both would do everything inside twice.
 */
export const outermost = <T extends { path: string; rootSlug?: string }>(items: T[]) =>
  items.filter((item) => !items.some((other) => other.rootSlug === item.rootSlug && isInside(item.path, other.path)));

/** The deepest folder that holds every one of the paths. */
function commonFolder(paths: string[]) {
  let folder = parentPath(paths[0] ?? "/");
  while (folder !== "/" && !paths.every((path) => isInside(path, folder))) folder = parentPath(folder);
  return folder;
}

/**
 * The sources that can be put into a folder: no folder goes into itself or one inside it. One dropped onto itself
 * among others is left out quietly, as the place the rest are going; one that holds the folder is said to be refused.
 */
export function placeable(sources: FileRef[], destination: FileRef) {
  const holds = (source: FileRef) => source.rootSlug === destination.rootSlug && isWithin(destination.path, source.path);
  if (sources.some((source) => holds(source) && source.path !== destination.path)) toast(t("A folder can’t be put inside itself"), "error");
  return sources.filter((source) => !holds(source));
}

/**
 * Items that have left where they were, for the Trash or another folder. They are no longer there to paste or act on,
 * so the clipboard and every window's and tab's selection let go of them and of what is inside them.
 */
function letGo(refs: FileRef[]) {
  const gone = (item: FileRef) => refs.some((ref) => ref.rootSlug === item.rootSlug && isWithin(item.path, ref.path));
  useClipboardStore.setState(({ clip }) => {
    if (!clip?.items.some(gone)) return { clip };
    const items = clip.items.filter((item) => !gone(item));
    return { clip: items.length > 0 ? { ...clip, items } : null };
  });
  useWorkspaceStore.getState().deselect(refs);
}

/** Copies or moves the sources into a folder, asking first about each name the folder already has. Resolves to the task, once there is one. */
export function transferFiles(queryClient: QueryClient, type: "copy" | "move", sources: FileRef[], destination: FileRef) {
  return run(async () => {
    const placed = placeable(outermost(sources), destination);
    if (placed.length === 0) return;
    const conflicts = await resolveConflicts(type, placed, destination);
    if (!conflicts) return;
    const carried = placed.filter((source) => conflicts[baseName(source.path)] !== "skip");
    if (carried.length === 0) return;
    const task = await createTask(queryClient, { type, sources: carried, destination, options: { conflicts } }, type === "move" ? carried : undefined);
    if (type === "move") {
      // A window inside a moved folder goes along with it, unless it is kept beside a namesake under a name not known yet.
      for (const source of carried) {
        if (conflicts[baseName(source.path)] === "keep") continue;
        const name = source.path.slice(source.path.lastIndexOf("/") + 1);
        useWorkspaceStore.getState().followFolder(source, { rootSlug: destination.rootSlug, path: `${destination.path === "/" ? "" : destination.path}/${name}` });
      }
      letGo(carried);
    }
    followTask(task);
    return task;
  });
}

export function setClipboard(mode: "copy" | "cut", picked: FileRef[]) {
  const items = outermost(picked);
  if (items.length === 0) return;
  useClipboardStore.setState({ clip: { mode, items } });
  toast(mode === "copy" ? t("Copied {count} item | Copied {count} items", { count: items.length }) : t("Cut {count} item | Cut {count} items", { count: items.length }));
}

export async function pasteClipboard(queryClient: QueryClient, destination: FileRef) {
  const clip = useClipboardStore.getState().clip;
  if (!clip) return;
  if (clip.mode === "copy") {
    await transferFiles(queryClient, "copy", clip.items, destination);
    return;
  }
  // Cut items that already live here have nowhere to go.
  const sources = clip.items.filter((item) => !isInFolder(item, destination));
  // They stay on the clipboard until they are on their way, so a paste called off or refused can be made again.
  if (sources.length > 0 && (await transferFiles(queryClient, "move", sources, destination))) useClipboardStore.setState({ clip: null });
}

/** Asks for a name and makes a folder of it inside `folder`. Resolves to whether one was made. */
export function newFolderIn(queryClient: QueryClient, folder: FileRef) {
  return run(async () => {
    const name = nfc((await promptText({ title: t("New folder"), defaultValue: t("untitled folder"), confirmLabel: t("Create") })) ?? "");
    if (!name) return false;
    await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug: folder.rootSlug, path: folder.path, name }) });
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", folder.rootSlug, folder.path] });
    return true;
  }, t("Couldn’t create the folder"));
}

/** Asks for another name for an item. `onRenamed` hears where it is now before any listing is asked for again. */
export function renameFile(queryClient: QueryClient, item: FileRef & { name: string; kind?: FileItem["kind"] }, onRenamed?: (path: string) => void) {
  return run(async () => {
    // A file's name is selected without its extension, so typing over it keeps the type; a dotfile's whole name is its name.
    const dot = item.name.lastIndexOf(".");
    const selectEnd = item.kind === "file" && dot > 0 ? dot : undefined;
    const name = nfc((await promptText({ title: t("Rename"), defaultValue: item.name, selectEnd, confirmLabel: t("Rename") })) ?? "");
    // Confirming the unchanged name still goes through for an NFD file, which rewrites it as NFC.
    if (!name || (name === item.name && !needsNormalizing(item.path))) return;
    const renamed = await api<{ path: string }>("/api/fs/rename", { method: "POST", body: JSON.stringify({ rootSlug: item.rootSlug, path: item.path, name }) });
    // Every window showing a renamed folder, or one inside it, follows it to its new name.
    useWorkspaceStore.getState().followFolder(item, { rootSlug: item.rootSlug, path: renamed.path });
    onRenamed?.(renamed.path);
    // The item may sit in a folder opened in place rather than in the window's own.
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", item.rootSlug, parentPath(item.path)], exact: true }, { cancelRefetch: false });
  }, t("Couldn’t rename"));
}

/** Past this much to copy, moving to the Trash is slow enough to ask whether it is wanted at all. */
const SLOW_TRASH_BYTES = 1024 ** 3;

/** Resolves to the task moving them, or to nothing when it could not be started. */
export function trashFiles(queryClient: QueryClient, picked: FileRef[]) {
  const sources = outermost(picked);
  return run(async () => {
    // The Trash of a location is on its own disk, and getting there is a rename. Only what has to be copied to it takes time.
    const { copyBytes } = await api<{ copyBytes: number }>("/api/trash/cost", { method: "POST", body: JSON.stringify({ sources }) });
    let type = "delete_to_trash";
    if (copyBytes >= SLOW_TRASH_BYTES) {
      const choice = await chooseAction({
        title: t("Moving this to the Trash will take a while"),
        description: t("The Trash is on another disk, so {size} has to be copied there first. Deleting right away is instant, but can’t be undone.", { size: formatSize(copyBytes) }),
        confirmLabel: t("Move to Trash"),
        alternative: { label: t("Delete right away"), destructive: true }
      });
      if (!choice) return;
      if (choice === "alternative") type = "delete";
    }
    // The server moves them in the background; here they are gone at once.
    const task = await createTask(queryClient, { type, sources }, sources);
    letGo(sources);
    toast(type === "delete" ? t("Deleted {count} item | Deleted {count} items", { count: sources.length }) : t("Moved {count} item to Trash | Moved {count} items to Trash", { count: sources.length }));
    return task;
  });
}

/** A single file downloads directly; folders and multi-selections are zipped server-side first, outside the user's folders. */
export function downloadFiles(queryClient: QueryClient, rootSlug: string, picked: Array<Pick<FileItem, "path" | "kind">>) {
  const items = outermost(picked);
  return run(async () => {
    const [first] = items;
    if (!first) return;
    if (items.length === 1 && first.kind === "file") {
      triggerDownload(downloadUrl(rootSlug, first.path));
      return;
    }
    const task = await createTask(queryClient, { type: "download_zip", sources: items.map((item) => ({ rootSlug, path: item.path })) });
    pendingDownloads.add(task.id);
    toast(t("Zipping. The download starts when it’s ready"));
  });
}

/** What a folder holds: its listing when one has been read whole, or else what the server says of it now. */
async function folderItems(queryClient: QueryClient, rootSlug: string, path: string): Promise<FileItem[]> {
  const listed = queryClient.getQueryData<FileList>(["fs", "list", rootSlug, path]);
  if (listed && !listed.partial) return listed.items;
  const items: FileItem[] = [];
  for await (const line of apiLines<{ items?: FileItem[]; error?: string; code?: string }>(`/api/fs/list?${new URLSearchParams({ rootSlug, path }).toString()}`)) {
    if (line.error) throw new ApiError(serverMessage(line.error), line.code ?? "REQUEST_FAILED", 500);
    if (line.items) items.push(...line.items);
  }
  return items;
}

/** Asks about each file and folder of an upload whose name the destination already has, the way a copy asks. */
async function askUploadConflicts(queryClient: QueryClient, tree: UploadTree, destination: FileRef): Promise<ConflictChoices | null> {
  const there = new Map((await folderItems(queryClient, destination.rootSlug, destination.path)).map((item) => [nfc(item.name), item]));
  const arriving = [
    ...tree.dirs.filter((dir) => !dir.includes("/")).map((dir) => ({ name: nfc(dir), kind: "folder" as const, size: 0, mtime: 0 })),
    ...tree.files.filter((entry) => !entry.dir).map(({ file }) => ({ name: nfc(file.name), kind: "file" as const, size: file.size, mtime: file.lastModified }))
  ];
  const conflicts = arriving.flatMap((entry): Conflict[] => {
    const existing = there.get(entry.name);
    if (!existing) return [];
    const details = { kind: existing.kind, size: existing.kind === "folder" ? 0 : existing.size, mtime: existing.mtime };
    return [{ ...entry, rootSlug: destination.rootSlug, path: joinLogicalPath(destination.path, entry.name), existing: details, same: false }];
  });
  return conflicts.length === 0 ? {} : askConflicts("upload", conflicts, destination);
}

/** Every file operation a window can start. Long-running ones only enqueue a server task. */
export function useFileActions(window: FileWindow) {
  const queryClient = useQueryClient();
  const refs = (paths: string[]): FileRef[] => paths.map((path) => ({ rootSlug: window.rootSlug, path }));
  const here = (path = window.logicalPath): FileRef => ({ rootSlug: window.rootSlug, path });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
  /** An upload can land in folders other windows are showing, so every listing of the root is refetched; searches are not. */
  const refreshRoot = (rootSlug = window.rootSlug) => queryClient.invalidateQueries({ queryKey: ["fs", "list", rootSlug], predicate: (query) => query.queryKey.length === 4 }, { cancelRefetch: false });
  const clearSelection = () => useWorkspaceStore.getState().selectItems(window.id, []);

  return {
    refresh,
    newFolder: (path = window.logicalPath) => newFolderIn(queryClient, here(path)),
    /** Asks for a name, makes a folder of it beside the items, and moves them into it. */
    newFolderWith: (paths: string[]) =>
      run(async () => {
        const sources = outermost(refs(paths)).map((ref) => ref.path);
        if (sources.length === 0) return;
        // In one folder they cannot share a name; said before there is an empty folder to show for it.
        if (new Set(sources.map((path) => baseName(path))).size < sources.length) throw new Error(t("Multiple sources resolve to the same target"));
        // With folders opened in place the items may be in several, so the new one goes in the folder that holds them all.
        const parent = commonFolder(sources);
        const count = sources.length;
        const title = count > 1 ? t("New folder with {count} item | New folder with {count} items", { count }) : t("New folder with selection");
        const name = nfc((await promptText({ title, defaultValue: t("untitled folder"), confirmLabel: t("Create") })) ?? "");
        if (!name) return;
        const folder = await api<{ path: string }>("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: parent, name }) });
        await refreshRoot();
        useWorkspaceStore.getState().selectItems(window.id, [folder.path]);
        await transferFiles(queryClient, "move", refs(sources), here(folder.path));
      }, t("Couldn’t create the folder")),
    /**
     * Creates the tree's folders, then uploads its files folder by folder in batches the server accepts. Whatever the
     * destination already has the name of is asked about first, as a copy asks.
     */
    upload: (source: UploadTree | Promise<UploadTree>, path = window.logicalPath, rootSlug = window.rootSlug) =>
      run(async () => {
        const tree = await source;
        if (tree.files.length === 0 && tree.dirs.length === 0) return;
        const choices = await askUploadConflicts(queryClient, tree, { rootSlug, path });
        if (!choices) return;
        const topOf = (dir: string) => dir.split("/")[0]!;
        const choiceOf = (dir: string) => choices[nfc(topOf(dir))];
        /** Where the folders at the top of the tree were made: a folder kept beside its namesake has a name of the server's choosing. */
        const placed = new Map<string, string>();
        const target = (dir: string) => {
          if (!dir) return path;
          const top = topOf(dir);
          return (placed.get(top) ?? `${path === "/" ? "" : path}/${top}`) + dir.slice(top.length);
        };
        const dirs = tree.dirs.filter((dir) => choiceOf(dir) !== "skip");
        const files = tree.files.filter(({ file, dir }) => (dir ? choiceOf(dir) : choices[nfc(file.name)]) !== "skip");
        if (files.length === 0 && dirs.length === 0) return;
        try {
          for (const dir of dirs) {
            const top = dir === topOf(dir);
            const choice = choiceOf(dir);
            // A folder merged into its namesake has the folders inside it merged in turn.
            const conflict = choice?.startsWith("merge_") ? "merge" : top ? choice : undefined;
            const full = target(dir);
            const made = await api<{ path: string }>("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug, path: parentPath(full), name: full.slice(full.lastIndexOf("/") + 1), conflict }) });
            if (top) placed.set(dir, made.path);
          }
          const byDir = new Map<string, File[]>();
          for (const { file, dir } of files) byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
          for (const [dir, inDir] of byDir) {
            const choice = dir ? choiceOf(dir) : undefined;
            for (let start = 0; start < inDir.length; start += uploadBatchSize) {
              const batch = inDir.slice(start, start + uploadBatchSize);
              // A file at the top meets its namesake as was chosen for it; one in a merged folder, as was chosen for the files both folders have.
              const conflicts: Record<string, string> = {};
              for (const file of batch) {
                const action = dir ? (choice?.startsWith("merge_") ? choice.slice("merge_".length) : undefined) : choices[nfc(file.name)];
                if (action) conflicts[nfc(file.name)] = action;
              }
              const form = new FormData();
              form.append("rootSlug", rootSlug);
              form.append("path", target(dir));
              if (Object.keys(conflicts).length > 0) form.append("conflicts", JSON.stringify(conflicts));
              for (const file of batch) form.append("file", file, nfc(file.name));
              await uploadForm("/api/fs/upload", form, uploadLabel(batch));
            }
          }
        } catch (error) {
          // Whatever made it across before the failure is already on disk.
          await refreshRoot(rootSlug);
          if (!isUploadCancelled(error)) throw error;
          toast(t("Upload cancelled"));
          return;
        }
        await refreshRoot(rootSlug);
        // A drop on a folder row, or on one in the sidebar, lands inside that folder, out of sight; say so.
        const folder = path === window.logicalPath && rootSlug === window.rootSlug ? "" : folderTitle(rootSlug, path);
        if (files.length > 0) toast(folder ? t("Uploaded {count} file to “{folder}” | Uploaded {count} files to “{folder}”", { count: files.length, folder }) : t("Uploaded {count} file | Uploaded {count} files", { count: files.length }));
        else toast(folder ? t("Created {count} folder in “{folder}” | Created {count} folders in “{folder}”", { count: dirs.length, folder }) : t("Created {count} folder | Created {count} folders", { count: dirs.length }));
      }, t("Upload failed")),
    rename: (item: FileItem) => renameFile(queryClient, { rootSlug: window.rootSlug, path: item.path, name: item.name, kind: item.kind }, clearSelection),
    /** Asks for a pattern and names the items by it. What is beside each of them, in its own folder, has its name taken. */
    renameMany: (items: FileItem[]) =>
      run(async () => {
        if (items.length > MAX_BATCH_RENAME) throw new Error(t("At most {max} items can be renamed at once", { max: MAX_BATCH_RENAME }));
        const folders = [...new Set(items.map((item) => parentPath(item.path)))];
        const existing = (await Promise.all(folders.map((folder) => folderItems(queryClient, window.rootSlug, folder)))).flat().map((item) => item.path);
        const names = await promptBatchRename({ rootSlug: window.rootSlug, items, existing });
        if (!names) return;
        const renamed = await api<{ items: Array<{ from: string; path: string }> }>("/api/fs/rename-many", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, items: names }) });
        // They stay selected under their new names; the rest of the selection is where it was.
        const moved = new Map(renamed.items.map((item) => [item.from, item.path]));
        useWorkspaceStore.getState().selectItems(window.id, items.map((item) => moved.get(item.path) ?? item.path));
        for (const item of renamed.items) useWorkspaceStore.getState().followFolder({ rootSlug: window.rootSlug, path: item.from }, { rootSlug: window.rootSlug, path: item.path });
        await refreshRoot();
        toast(t("Renamed {count} item | Renamed {count} items", { count: names.length }));
      }, t("Couldn’t rename")),
    trash: async (paths: string[]) => {
      if (await trashFiles(queryClient, refs(paths))) clearSelection();
    },
    /** The archive goes in the folder the items are in, which with folders open in place may be below the window's own. */
    compress: (paths: string[]) =>
      run(async () => {
        const sources = outermost(refs(paths));
        if (sources.length === 0) return;
        const folder = commonFolder(sources.map((source) => source.path));
        const choice = await promptCompress({ title: t("Compress to zip"), defaultName: `${baseName(folder) || window.title || "archive"}.zip` });
        if (!choice) return;
        followTask(await createTask(queryClient, { type: "compress", sources, destination: here(joinLogicalPath(folder, ensureZipName(choice.name))), options: choice.options }));
      }),
    /** Asks what to make of some media files of one kind and converts them into the folder they are in. */
    convert: (items: FileItem[], kind: MediaKind) =>
      run(async () => {
        const spec = await promptConvert({ kind, names: items.map((item) => nfc(item.name)) });
        if (!spec) return;
        const task = await api<FileTask>("/api/convert", { method: "POST", body: JSON.stringify({ sources: refs(items.map((item) => item.path)), destination: here(commonFolder(items.map((item) => item.path))), spec }) });
        await queryClient.invalidateQueries({ queryKey: ["tasks"] });
        followTask(task);
      }, t("Couldn’t start the conversion")),
    extract: (paths: string[]) => run(() => startExtract(queryClient, { sources: refs(paths), destination: here(commonFolder(paths)) })),
    download: (items: FileItem[]) => downloadFiles(queryClient, window.rootSlug, items),
    addToShelf: (paths: string[]) =>
      run(async () => {
        const shelves = await api<Array<{ id: string }>>("/api/shelves");
        const shelfId = shelves[0]?.id;
        if (!shelfId) return;
        await Promise.all(refs(paths).map((ref) => api(`/api/shelves/${shelfId}/items`, { method: "POST", body: JSON.stringify(ref) })));
        await queryClient.invalidateQueries({ queryKey: ["shelves"] });
        toast(t("Added to Shelf ({count})", { count: paths.length }));
      }, t("Couldn’t add to Shelf")),
    transfer: (type: "copy" | "move", sources: FileRef[], destination: FileRef = here()) => transferFiles(queryClient, type, sources, destination),
    copy: (paths: string[]) => setClipboard("copy", refs(paths)),
    cut: (paths: string[]) => setClipboard("cut", refs(paths)),
    paste: (path = window.logicalPath) => pasteClipboard(queryClient, here(path))
  };
}

export type FileActions = ReturnType<typeof useFileActions>;
