import { Play, X } from "lucide-react";
import { useLayoutEffect, useRef } from "react";
import { KagoIconButton } from "@/components/kago/icon-button";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { FileItem } from "@/types/kago";
import { PLAYER_CONTROL_CLASS } from "./VideoPlayer";

type VideoPlaylistProps = {
  id: string;
  videos: FileItem[];
  currentPath: string;
  loading: boolean;
  error: boolean;
  onSelect: (item: FileItem) => void;
  onClose: () => void;
  returnFocus?: () => void;
};

/** A folder's videos over the player, so the list follows the picture into fullscreen and PiP. */
export function VideoPlaylist({ id, videos, currentPath, loading, error, onSelect, onClose, returnFocus }: VideoPlaylistProps) {
  const list = useRef<HTMLOListElement>(null);
  const scrollTarget = useRef({ id, currentPath, scrolled: false });

  useLayoutEffect(() => {
    const target = scrollTarget.current;
    if (target.id !== id || target.currentPath !== currentPath) {
      target.id = id;
      target.currentPath = currentPath;
      target.scrolled = false;
    }
    if (target.scrolled) return;

    const node = list.current;
    const index = videos.findIndex((video) => video.path === currentPath);
    const row = node?.children[index] as HTMLElement | undefined;
    if (!node || !row) return;

    // Keep the scroll inside the list; scrollIntoView can move the page behind the player.
    const listRect = node.getBoundingClientRect();
    const rowRect = row.getBoundingClientRect();
    const inset = 8;
    let top = node.scrollTop;
    if (rowRect.top < listRect.top + inset) top += rowRect.top - listRect.top - inset;
    else if (rowRect.bottom > listRect.bottom - inset) top += rowRect.bottom - listRect.bottom + inset;
    if (top !== node.scrollTop) node.scrollTo({ top: Math.max(0, top), behavior: "auto" });
    target.scrolled = true;
  }, [currentPath, id, videos]);

  return (
    <aside
      id={id}
      aria-label={t("Playlist")}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      }}
      className="kago-player-glass absolute top-2 right-2 bottom-[84px] flex w-[min(18rem,calc(100%-1rem))] flex-col rounded-lg text-xs"
    >
      <header className="flex shrink-0 items-center py-1 pr-1 pl-3">
        <strong className="min-w-0 flex-1 truncate font-semibold">{t("Playlist")}</strong>
        <KagoIconButton label={t("Close")} className={`size-6 ${PLAYER_CONTROL_CLASS}`} onClick={onClose}>
          <X />
        </KagoIconButton>
      </header>

      <ol ref={list} className="m-0 min-h-0 flex-1 scroll-fade list-none overflow-y-auto p-1">
        {videos.map((video, index) => {
          const current = video.path === currentPath;
          return (
            <li key={video.path}>
              <button
                type="button"
                aria-current={current ? "true" : undefined}
                className={cn(
                  "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
                  current ? "bg-white/20" : "hover:bg-white/10"
                )}
                onClick={(event) => {
                  onSelect(video);
                  if (event.detail > 0) returnFocus?.();
                }}
              >
                <span className="flex w-5 shrink-0 justify-end text-xs tabular-nums opacity-70" aria-hidden="true">
                  {current ? <Play className="size-3.5 fill-current" /> : index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate">{video.name}</span>
              </button>
            </li>
          );
        })}
        {!videos.length && !loading && !error ? (
          <li className="px-2 py-3 text-center text-white/60">{t("No videos in this folder")}</li>
        ) : null}
      </ol>

      {loading && !error ? <div role="status" className="shrink-0 border-t border-white/10 px-3 py-2 text-white/70">{t("Loading…")}</div> : null}
      {error ? <div role="alert" className="shrink-0 border-t border-white/10 px-3 py-2 text-white/80">{t("Couldn’t load the folder")}</div> : null}
    </aside>
  );
}
