import { File, FileArchive, FileAudio, FileImage, FileText, FileVideo, Folder } from "lucide-react";
import { isVideoType } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { FileItem } from "@/types/kago";

export function isArchive(item: Pick<FileItem, "kind" | "name">) {
  return item.kind === "file" && item.name.toLowerCase().endsWith(".zip");
}

export function FileIcon({ item, className }: { item: Pick<FileItem, "kind" | "type" | "name">; className?: string }) {
  if (item.kind === "folder") return <Folder className={cn("fill-folder/25 text-folder", className)} />;
  const type = item.type;
  // Each broad kind has its own colour, so a mixed folder can be read by scanning the icons.
  const [Icon, tone] = type.startsWith("image/")
    ? [FileImage, "text-kind-image"]
    : isVideoType(type)
      ? [FileVideo, "text-kind-video"]
      : type.startsWith("audio/")
        ? [FileAudio, "text-kind-audio"]
        : isArchive(item)
          ? [FileArchive, "text-kind-archive"]
          : type === "application/pdf"
            ? [FileText, "text-kind-document"]
            : type.startsWith("text/")
              ? [FileText, "text-muted"]
              : [File, "text-muted"];
  return <Icon className={cn(tone, className)} />;
}
