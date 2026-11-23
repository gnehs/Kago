import { byName } from "@/lib/sort";
import type { FileItem, FolderView } from "@/types/kago";

const compare = (a: string, b: string) => byName.compare(a, b);

export function sortItems(items: FileItem[], sortBy: FolderView["sortBy"], direction: FolderView["sortDirection"]) {
  const sign = direction === "asc" ? 1 : -1;
  return [...items].sort((a, b) => {
    // Folders stay grouped first, like Finder and File Station, whatever the sort column.
    if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
    const primary = sortBy === "size" ? a.size - b.size : sortBy === "mtime" ? a.mtime - b.mtime : sortBy === "type" ? compare(a.type, b.type) : compare(a.name, b.name);
    return (primary || compare(a.name, b.name)) * sign;
  });
}
