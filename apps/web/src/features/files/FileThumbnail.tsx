import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { thumbnailUrl } from "@/api/client";
import type { FileItem } from "@/types/kago";
import { cn } from "@/lib/utils";
import { FileTile } from "./FileIcon";
import { extensionOf, fileKind, KIND_TONES, thumbnailKind } from "./fileKind";

/**
 * A file at the size of a tile, showing what is in it where that can be drawn small:
 * pictures, videos and the first page of documents as a thumbnail, text as its opening lines on the sheet.
 * Everything else is its icon, as is anything whose thumbnail has not arrived or cannot be made.
 */
export function FileThumbnail({ rootSlug, item, size }: { rootSlug: string; item: Pick<FileItem, "kind" | "type" | "name" | "size" | "path" | "mtime">; size: number }) {
  const shows = thumbnailKind(item);
  // The address carries the mtime, so a file that changes is drawn again instead of coming from the browser's cache.
  const source = `${thumbnailUrl(rootSlug, item.path)}&v=${Math.round(item.mtime)}`;
  const excerpt = useQuery({
    queryKey: ["thumbnail-text", source],
    enabled: shows === "text",
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const response = await fetch(source, { credentials: "include" });
      // A file that only looks like text by its name comes back as a picture, or not at all.
      return response.ok && response.headers.get("Content-Type")?.startsWith("text/plain") ? response.text() : "";
    }
  });
  const tile = <FileTile item={item} text={excerpt.data || undefined} className="block" />;
  if (shows === null || shows === "text") return <span style={{ width: size, height: size }}>{tile}</span>;
  // A thumbnail replaces the icon, so what said which kind of file this is moves onto its corner.
  const badge =
    shows === "video" ? (
      <svg viewBox="0 0 10 10" aria-hidden className="m-0.5 size-2.5">
        <path d="M2.6 1.4 8.6 5 2.6 8.6Z" fill="currentColor" />
      </svg>
    ) : shows === "page" ? (
      <span className="px-1 text-[9px] leading-4 font-bold tracking-wide uppercase">{extensionOf(item.name)}</span>
    ) : null;
  return <Picture key={source} source={source} size={size} fallback={tile} badge={badge} tone={KIND_TONES[fileKind(item)]} />;
}

function Picture({ source, size, fallback, badge, tone }: { source: string; size: number; fallback: React.ReactNode; badge: React.ReactNode; tone: string }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  return (
    <span className="relative flex items-center justify-center" style={state === "loaded" ? undefined : { width: size, height: size }}>
      {state === "loaded" ? null : fallback}
      {state === "failed" ? null : (
        <img
          alt=""
          loading="lazy"
          draggable={false}
          src={source}
          // Until it has loaded it sits unseen over the icon, since a hidden image is never fetched.
          className={state === "loaded" ? "block rounded-sm object-contain ring-1 ring-line" : "absolute inset-0 size-full opacity-0"}
          style={state === "loaded" ? { maxWidth: size, maxHeight: size } : undefined}
          onLoad={() => setState("loaded")}
          onError={() => setState("failed")}
        />
      )}
      {badge && state === "loaded" ? (
        <span className={cn("absolute bottom-1 left-1", tone)}>
          <span className="flex items-center justify-center rounded-sm bg-current">
            <span className="flex text-surface">{badge}</span>
          </span>
        </span>
      ) : null}
    </span>
  );
}
