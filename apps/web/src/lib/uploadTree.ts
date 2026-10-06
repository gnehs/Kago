import { nfc } from "./paths";

/** What one upload carries: folders to create (parents first) and files with the folder they go into, both relative to the destination. */
export type UploadTree = {
  dirs: string[];
  files: Array<{ file: File; dir: string }>;
};

/** Finder litters folders with these; they are never what the user meant to upload. */
const ignoredNames = new Set([".DS_Store"]);

const joinRelative = (dir: string, name: string) => (dir ? `${dir}/${nfc(name)}` : nfc(name));

export const flatTree = (files: File[]): UploadTree => ({ dirs: [], files: files.map((file) => ({ file, dir: "" })) });

/** Files picked through a `webkitdirectory` input, which only reports each file's relative path. */
export function pickedFolderTree(files: File[]): UploadTree {
  const dirs = new Set<string>();
  const tree: UploadTree = { dirs: [], files: [] };
  for (const file of files) {
    if (ignoredNames.has(file.name)) continue;
    const parts = file.webkitRelativePath.split("/").slice(0, -1).map(nfc);
    for (let depth = 1; depth <= parts.length; depth++) dirs.add(parts.slice(0, depth).join("/"));
    tree.files.push({ file, dir: parts.join("/") });
  }
  // A parent is always a prefix of its children, so sorting puts it first.
  tree.dirs = [...dirs].sort();
  return tree;
}

const readFile = (entry: FileSystemFileEntry) => new Promise<File>((resolve, reject) => entry.file(resolve, reject));

async function readChildren(entry: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = entry.createReader();
  const children: FileSystemEntry[] = [];
  // readEntries hands out the listing in chunks and signals the end with an empty one.
  for (;;) {
    const chunk = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (chunk.length === 0) return children;
    children.push(...chunk);
  }
}

async function walk(entry: FileSystemEntry, dir: string, tree: UploadTree): Promise<void> {
  if (ignoredNames.has(entry.name)) return;
  if (entry.isFile) {
    tree.files.push({ file: await readFile(entry as FileSystemFileEntry), dir });
    return;
  }
  const path = joinRelative(dir, entry.name);
  tree.dirs.push(path);
  for (const child of await readChildren(entry as FileSystemDirectoryEntry)) await walk(child, path, tree);
}

/**
 * Reads a drop of files and folders. A dropped folder shows up in `dataTransfer.files` as an unreadable
 * File, so folders are walked through their entries instead. Returns null when the drop carries no files.
 */
export function droppedTree(dataTransfer: DataTransfer): Promise<UploadTree> | null {
  if (dataTransfer.files.length === 0) return null;
  // The entries are only reachable while the drop event is being dispatched, so collect them before any await.
  const entries = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => item.webkitGetAsEntry?.() ?? null);
  if (entries.length === 0 || entries.includes(null)) return Promise.resolve(flatTree(Array.from(dataTransfer.files)));
  return (async () => {
    const tree: UploadTree = { dirs: [], files: [] };
    for (const entry of entries) await walk(entry!, "", tree);
    return tree;
  })();
}
