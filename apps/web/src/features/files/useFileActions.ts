import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, downloadUrl } from "@/api/client";
import { baseName, ensureZipName, joinLogicalPath, needsNormalizing, nfc, parentPath, triggerDownload } from "@/lib/paths";
import { run } from "@/lib/run";
import type { UploadTree } from "@/lib/uploadTree";
import { useClipboardStore, type FileRef } from "@/stores/clipboard";
import { promptText } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import { hideTrashing } from "@/stores/trashing";
import { followTask } from "@/features/tasks/taskToast";
import { isUploadCancelled, uploadForm, uploadLabel } from "@/stores/uploads";
import { folderTitle, useWorkspaceStore } from "@/stores/workspace";
import { startExtract } from "./ArchivePassword";
import { promptCompress } from "./CompressDialog";
import type { FileItem, FileTask, FileWindow } from "@/types/kago";
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

async function createTask(queryClient: QueryClient, body: Record<string, unknown>) {
  const task = await api<FileTask>("/api/tasks", { method: "POST", body: JSON.stringify(body) });
  await queryClient.invalidateQueries({ queryKey: ["tasks"] });
  return task;
}

const isInFolder = (source: FileRef, folder: FileRef) => source.rootSlug === folder.rootSlug && parentPath(source.path) === folder.path;

export function transferFiles(queryClient: QueryClient, type: "copy" | "move", sources: FileRef[], destination: FileRef) {
  return run(async () => {
    followTask(await createTask(queryClient, { type, sources, destination }));
  });
}

export function setClipboard(mode: "copy" | "cut", items: FileRef[]) {
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
  useClipboardStore.setState({ clip: null });
  if (sources.length > 0) await transferFiles(queryClient, "move", sources, destination);
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
export function renameFile(queryClient: QueryClient, item: FileRef & { name: string }, onRenamed?: (path: string) => void) {
  return run(async () => {
    const name = nfc((await promptText({ title: t("Rename"), defaultValue: item.name, confirmLabel: t("Rename") })) ?? "");
    // Confirming the unchanged name still goes through for an NFD file, which rewrites it as NFC.
    if (!name || (name === item.name && !needsNormalizing(item.path))) return;
    const renamed = await api<{ path: string }>("/api/fs/rename", { method: "POST", body: JSON.stringify({ rootSlug: item.rootSlug, path: item.path, name }) });
    onRenamed?.(renamed.path);
    // The item may sit in a folder opened in place rather than in the window's own.
    await queryClient.invalidateQueries({ queryKey: ["fs", "list", item.rootSlug] });
  }, t("Couldn’t rename"));
}

/** Resolves to the task moving them, or to nothing when it could not be started. */
export function trashFiles(queryClient: QueryClient, sources: FileRef[]) {
  return run(async () => {
    const task = await createTask(queryClient, { type: "delete_to_trash", sources });
    // The server moves them in the background; here they are gone at once.
    hideTrashing(task.id, sources);
    toast(t("Moved {count} item to Trash | Moved {count} items to Trash", { count: sources.length }));
    return task;
  });
}

/** A single file downloads directly; folders and multi-selections are zipped server-side first, outside the user's folders. */
export function downloadFiles(queryClient: QueryClient, rootSlug: string, items: Array<Pick<FileItem, "path" | "kind">>) {
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

/** Every file operation a window can start. Long-running ones only enqueue a server task. */
export function useFileActions(window: FileWindow) {
  const queryClient = useQueryClient();
  const refs = (paths: string[]): FileRef[] => paths.map((path) => ({ rootSlug: window.rootSlug, path }));
  const here = (path = window.logicalPath): FileRef => ({ rootSlug: window.rootSlug, path });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
  /** An upload can land in folders other windows are showing, so every listing of the root is refetched. */
  const refreshRoot = (rootSlug = window.rootSlug) => queryClient.invalidateQueries({ queryKey: ["fs", "list", rootSlug] });
  const clearSelection = () => useWorkspaceStore.getState().selectItems(window.id, []);

  return {
    refresh,
    newFolder: () => newFolderIn(queryClient, here()),
    /** Asks for a name, makes a folder of it beside the items, and moves them into it. */
    newFolderWith: (paths: string[]) =>
      run(async () => {
        // What is inside a selected folder goes along with that folder.
        const sources = paths.filter((path) => !paths.some((other) => path.startsWith(`${other}/`)));
        const [first] = sources;
        if (first === undefined) return;
        // In one folder they cannot share a name; said before there is an empty folder to show for it.
        if (new Set(sources.map((path) => baseName(path))).size < sources.length) throw new Error(t("Multiple sources resolve to the same target"));
        // With folders opened in place the items may be in several, so the new one goes in the folder that holds them all.
        let parent = parentPath(first);
        while (parent !== "/" && !sources.every((path) => path.startsWith(`${parent}/`))) parent = parentPath(parent);
        const count = sources.length;
        const title = count > 1 ? t("New folder with {count} item | New folder with {count} items", { count }) : t("New folder with selection");
        const name = nfc((await promptText({ title, defaultValue: t("untitled folder"), confirmLabel: t("Create") })) ?? "");
        if (!name) return;
        const folder = await api<{ path: string }>("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: parent, name }) });
        await refreshRoot();
        useWorkspaceStore.getState().selectItems(window.id, [folder.path]);
        await transferFiles(queryClient, "move", refs(sources), here(folder.path));
      }, t("Couldn’t create the folder")),
    /** Creates the tree's folders, then uploads its files folder by folder in batches the server accepts. */
    upload: (source: UploadTree | Promise<UploadTree>, path = window.logicalPath, rootSlug = window.rootSlug) =>
      run(async () => {
        const tree = await source;
        if (tree.files.length === 0 && tree.dirs.length === 0) return;
        const target = (dir: string) => (dir ? `${path === "/" ? "" : path}/${dir}` : path);
        try {
          for (const dir of tree.dirs) {
            const full = target(dir);
            await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug, path: parentPath(full), name: full.slice(full.lastIndexOf("/") + 1) }) });
          }
          const byDir = new Map<string, File[]>();
          for (const { file, dir } of tree.files) byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
          for (const [dir, files] of byDir) {
            for (let start = 0; start < files.length; start += uploadBatchSize) {
              const batch = files.slice(start, start + uploadBatchSize);
              const form = new FormData();
              form.append("rootSlug", rootSlug);
              form.append("path", target(dir));
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
        if (tree.files.length > 0) toast(folder ? t("Uploaded {count} file to “{folder}” | Uploaded {count} files to “{folder}”", { count: tree.files.length, folder }) : t("Uploaded {count} file | Uploaded {count} files", { count: tree.files.length }));
        else toast(folder ? t("Created {count} folder in “{folder}” | Created {count} folders in “{folder}”", { count: tree.dirs.length, folder }) : t("Created {count} folder | Created {count} folders", { count: tree.dirs.length }));
      }, t("Upload failed")),
    rename: (item: FileItem) => renameFile(queryClient, { rootSlug: window.rootSlug, path: item.path, name: item.name }, clearSelection),
    trash: async (paths: string[]) => {
      if (await trashFiles(queryClient, refs(paths))) clearSelection();
    },
    compress: (paths: string[]) =>
      run(async () => {
        const choice = await promptCompress({ title: t("Compress to zip"), defaultName: `${window.title || "archive"}.zip` });
        if (!choice) return;
        followTask(await createTask(queryClient, { type: "compress", sources: refs(paths), destination: here(joinLogicalPath(window.logicalPath, ensureZipName(choice.name))), options: choice.options }));
      }),
    extract: (paths: string[]) => run(() => startExtract(queryClient, { sources: refs(paths), destination: here() })),
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
    paste: () => pasteClipboard(queryClient, here())
  };
}

export type FileActions = ReturnType<typeof useFileActions>;
