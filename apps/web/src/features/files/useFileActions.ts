import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, downloadUrl } from "@/api/client";
import { baseName, ensureZipName, joinLogicalPath, needsNormalizing, nfc, parentPath, triggerDownload } from "@/lib/paths";
import { run } from "@/lib/run";
import type { UploadTree } from "@/lib/uploadTree";
import { useClipboardStore, type FileRef } from "@/stores/clipboard";
import { promptText } from "@/stores/dialogs";
import { toast } from "@/stores/toast";
import { isUploadCancelled, uploadForm, uploadLabel } from "@/stores/uploads";
import { useWorkspaceStore } from "@/stores/workspace";
import type { FileItem, FileTask, FileWindow } from "@/types/kago";

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
    await createTask(queryClient, { type, sources, destination });
    toast(type === "copy" ? "已建立複製任務" : "已建立搬移任務");
  });
}

export function setClipboard(mode: "copy" | "cut", items: FileRef[]) {
  if (items.length === 0) return;
  useClipboardStore.setState({ clip: { mode, items } });
  toast(`已${mode === "copy" ? "複製" : "剪下"} ${items.length} 個項目`);
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

/** Every file operation a window can start. Long-running ones only enqueue a server task. */
export function useFileActions(window: FileWindow) {
  const queryClient = useQueryClient();
  const refs = (paths: string[]): FileRef[] => paths.map((path) => ({ rootSlug: window.rootSlug, path }));
  const here = (path = window.logicalPath): FileRef => ({ rootSlug: window.rootSlug, path });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug, window.logicalPath] });
  /** An upload can land in folders other windows are showing, so every listing of the root is refetched. */
  const refreshRoot = () => queryClient.invalidateQueries({ queryKey: ["fs", "list", window.rootSlug] });
  const clearSelection = () => useWorkspaceStore.getState().selectItems(window.id, []);

  return {
    refresh,
    newFolder: () =>
      run(async () => {
        const name = nfc((await promptText({ title: "新增資料夾", defaultValue: "未命名資料夾", confirmLabel: "建立" })) ?? "");
        if (!name) return;
        await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: window.logicalPath, name }) });
        await refresh();
      }, "建立資料夾失敗"),
    /** Creates the tree's folders, then uploads its files folder by folder in batches the server accepts. */
    upload: (source: UploadTree | Promise<UploadTree>, path = window.logicalPath) =>
      run(async () => {
        const tree = await source;
        if (tree.files.length === 0 && tree.dirs.length === 0) return;
        const target = (dir: string) => (dir ? `${path === "/" ? "" : path}/${dir}` : path);
        try {
          for (const dir of tree.dirs) {
            const full = target(dir);
            await api("/api/fs/mkdir", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: parentPath(full), name: full.slice(full.lastIndexOf("/") + 1) }) });
          }
          const byDir = new Map<string, File[]>();
          for (const { file, dir } of tree.files) byDir.set(dir, [...(byDir.get(dir) ?? []), file]);
          for (const [dir, files] of byDir) {
            for (let start = 0; start < files.length; start += uploadBatchSize) {
              const batch = files.slice(start, start + uploadBatchSize);
              const form = new FormData();
              form.append("rootSlug", window.rootSlug);
              form.append("path", target(dir));
              for (const file of batch) form.append("file", file, nfc(file.name));
              await uploadForm("/api/fs/upload", form, uploadLabel(batch));
            }
          }
        } catch (error) {
          // Whatever made it across before the failure is already on disk.
          await refreshRoot();
          if (!isUploadCancelled(error)) throw error;
          toast("已取消上傳");
          return;
        }
        await refreshRoot();
        // A drop on a folder row lands inside that folder, out of sight; say so.
        const where = path === window.logicalPath ? "" : `到「${baseName(path)}」`;
        toast(tree.files.length > 0 ? `已上傳 ${tree.files.length} 個檔案${where}` : `已建立 ${tree.dirs.length} 個資料夾${where}`);
      }, "上傳失敗"),
    rename: (item: FileItem) =>
      run(async () => {
        const name = nfc((await promptText({ title: "重新命名", defaultValue: item.name, confirmLabel: "重新命名" })) ?? "");
        // Confirming the unchanged name still goes through for an NFD file, which rewrites it as NFC.
        if (!name || (name === item.name && !needsNormalizing(item.path))) return;
        await api("/api/fs/rename", { method: "POST", body: JSON.stringify({ rootSlug: window.rootSlug, path: item.path, name }) });
        clearSelection();
        // The item may sit in a folder opened in place rather than in the window's own.
        await refreshRoot();
      }, "重新命名失敗"),
    trash: (paths: string[]) =>
      run(async () => {
        await createTask(queryClient, { type: "delete_to_trash", sources: refs(paths) });
        clearSelection();
        await refreshRoot();
        toast(`已將 ${paths.length} 個項目移到垃圾桶`);
      }),
    compress: (paths: string[]) =>
      run(async () => {
        const name = await promptText({ title: "壓縮成 zip", defaultValue: `${window.title || "archive"}.zip`, confirmLabel: "壓縮" });
        if (!name) return;
        await createTask(queryClient, { type: "compress", sources: refs(paths), destination: here(joinLogicalPath(window.logicalPath, ensureZipName(name))) });
        toast("已建立壓縮任務");
      }),
    extract: (paths: string[]) =>
      run(async () => {
        await createTask(queryClient, { type: "extract", sources: refs(paths), destination: here() });
        toast("已建立解壓縮任務");
      }),
    /** A single file downloads directly; folders and multi-selections are zipped server-side first, outside the user's folders. */
    download: (items: FileItem[]) =>
      run(async () => {
        const [first] = items;
        if (!first) return;
        if (items.length === 1 && first.kind === "file") {
          triggerDownload(downloadUrl(window.rootSlug, first.path));
          return;
        }
        const task = await createTask(queryClient, { type: "download_zip", sources: refs(items.map((item) => item.path)) });
        pendingDownloads.add(task.id);
        toast("正在打包，完成後會自動下載");
      }),
    addToShelf: (paths: string[]) =>
      run(async () => {
        const shelves = await api<Array<{ id: string }>>("/api/shelves");
        const shelfId = shelves[0]?.id;
        if (!shelfId) return;
        await Promise.all(refs(paths).map((ref) => api(`/api/shelves/${shelfId}/items`, { method: "POST", body: JSON.stringify(ref) })));
        await queryClient.invalidateQueries({ queryKey: ["shelves"] });
        toast(`已加入中轉區（${paths.length}）`);
      }, "無法加入中轉區"),
    transfer: (type: "copy" | "move", sources: FileRef[], path?: string) => transferFiles(queryClient, type, sources, here(path)),
    copy: (paths: string[]) => setClipboard("copy", refs(paths)),
    cut: (paths: string[]) => setClipboard("cut", refs(paths)),
    paste: () => pasteClipboard(queryClient, here())
  };
}

export type FileActions = ReturnType<typeof useFileActions>;
