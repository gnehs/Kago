import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo, Folder } from "lucide-react";
import { cn } from "@/lib/utils";
import type { FileItem } from "@/types/kago";

export function isArchive(item: Pick<FileItem, "kind" | "name">) {
  return item.kind === "file" && item.name.toLowerCase().endsWith(".zip");
}

export function FileIcon({ item, className }: { item: Pick<FileItem, "kind" | "type" | "name">; className?: string }) {
  if (item.kind === "folder") return <Folder className={cn("fill-folder/25 text-folder", className)} />;
  const type = item.type;
  const Icon = type.startsWith("image/")
    ? FileImage
    : type.startsWith("video/")
      ? FileVideo
      : type.startsWith("audio/")
        ? FileAudio
        : isArchive(item)
          ? FileArchive
          : type.startsWith("text/") || type === "application/pdf"
            ? FileText
            : File;
  return <Icon className={cn("text-muted", className)} />;
}
