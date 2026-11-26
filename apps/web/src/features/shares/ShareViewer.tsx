import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from "lucide-react";
import { KagoSpinner } from "@/components/kago/empty-state";
import { FileTile } from "@/components/kago/file-icon";
import { KagoIconButton } from "@/components/kago/icon-button";
import { PLAYER_CONTROL_CLASS } from "@/components/kago/player";
import { buttonVariants } from "@/components/ui/button";
import { formatSize } from "@/lib/format";
import { failureOf, guessType, shareEndpoint, viewerKind, type ShareFailure } from "@/lib/shareFolderModel";
import { cn } from "@/lib/utils";
import type { ShareItem } from "@/types/kago";
import { failureText } from "./shareFailures";
import { t } from "@/lib/i18n";
import { serverMessage } from "@/api/client";

/** The first part of a text file that is read; a longer one is cut here and the rest is for downloading. */
const TEXT_BYTES = 256 * 1024;
const SWIPE = 56;

/**
 * One file of a shared folder, large, over the page: a picture, a film, a sound, or text. What a browser cannot show
 * by itself says so, and where the link allows downloading, offers that instead. Stepping to the next or the previous
 * file is by the arrows, the arrow keys or a swipe; the address follows, so a reload comes back to the same file.
 */
export function ShareViewer({
  token,
  name,
  path,
  item,
  position,
  count,
  more,
  previous,
  next,
  canDownload,
  onStep,
  onClose
}: {
  token: string;
  /** The file's name and where it is below the shared folder, which are known from the address before the folder has been read. */
  name: string;
  path: string;
  item: ShareItem | null;
  /** Where this file stands among the ones that can be looked at, and how many there are; null while the folder has not been read as far as it. */
  position: number | null;
  count: number;
  /** More of the folder is still unread, so there are more files than `count`. */
  more: boolean;
  previous: ShareItem | null;
  next: ShareItem | null;
  canDownload: boolean;
  onStep: (item: ShareItem) => void;
  onClose: () => void;
}) {
  const type = item?.type ?? guessType(name);
  const kind = item ? (item.previewable ? viewerKind(item.type) : null) : viewerKind(type);
  const source = shareEndpoint(token, "preview", { path });
  const download = shareEndpoint(token, "download", { path });
  const dialog = useRef<HTMLDivElement>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    dialog.current?.focus();
  }, []);

  useEffect(() => {
    function keys(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") onClose();
      const media = event.target instanceof HTMLMediaElement;
      if (event.key === "ArrowLeft" && previous && !media) onStep(previous);
      if (event.key === "ArrowRight" && next && !media) onStep(next);
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [previous, next, onStep, onClose]);

  // The next picture is fetched while this one is looked at, so stepping to it is not a wait.
  useEffect(() => {
    if (!next || viewerKind(next.type) !== "image") return;
    const picture = new Image();
    picture.src = shareEndpoint(token, "preview", { path: next.path });
  }, [next, token]);

  return (
    <div ref={dialog} role="dialog" aria-modal="true" aria-label={name} tabIndex={-1} className="fixed inset-0 z-[900] flex flex-col bg-black text-white outline-none">
      <header className="flex shrink-0 items-center gap-1 px-1.5 pt-[max(env(safe-area-inset-top),6px)] pb-1.5">
        <KagoIconButton label={t("Close")} className={PLAYER_CONTROL_CLASS} onClick={onClose}>
          <X />
        </KagoIconButton>
        <div className="flex min-w-0 flex-1 flex-col px-1 leading-tight">
          <span className="truncate font-medium">{name}</span>
          <span className="truncate text-xs text-[#d4d6d9] tabular-nums">{[position !== null ? `${position} / ${count}${more ? "+" : ""}` : null, item ? formatSize(item.size) : null].filter(Boolean).join(" · ")}</span>
        </div>
        {canDownload ? (
          <a className={cn(buttonVariants({ variant: "default" }), "shrink-0")} href={download} download>
            <Download />
            {t("Download")}
          </a>
        ) : null}
      </header>

      <div
        className="relative flex min-h-0 flex-1 items-center justify-center"
        onPointerDown={(event) => {
          touch.current = event.pointerType === "touch" ? { x: event.clientX, y: event.clientY } : null;
        }}
        onPointerUp={(event) => {
          const start = touch.current;
          touch.current = null;
          if (!start) return;
          const dx = event.clientX - start.x;
          if (Math.abs(dx) < SWIPE || Math.abs(event.clientY - start.y) > Math.abs(dx) / 2) return;
          const target = dx < 0 ? next : previous;
          if (target) onStep(target);
        }}
        style={{ touchAction: "pan-y pinch-zoom" }}
      >
        <Body key={path} token={token} name={name} path={path} item={item} kind={kind} source={source} download={download} canDownload={canDownload} />
        {previous ? <Arrow side="left" label={t("Previous")} onClick={() => onStep(previous)} /> : null}
        {next ? <Arrow side="right" label={t("Next")} onClick={() => onStep(next)} /> : null}
      </div>
    </div>
  );
}

function Arrow({ side, label, onClick }: { side: "left" | "right"; label: string; onClick: () => void }) {
  return (
    <div className={cn("absolute inset-y-0 flex items-center px-1.5", side === "left" ? "left-0" : "right-0")}>
      <KagoIconButton label={label} className={cn(PLAYER_CONTROL_CLASS, "size-11 rounded-full bg-black/55 hover:bg-black/75")} onClick={onClick}>
        {side === "left" ? <ChevronLeft /> : <ChevronRight />}
      </KagoIconButton>
    </div>
  );
}

/**
 * Asks for the file's first byte to learn why it could not be shown: the server answers with the reason, which a
 * picture or a player that failed does not pass on.
 */
async function reasonFor(source: string): Promise<{ failure: ShareFailure; message: string }> {
  try {
    const response = await fetch(source, { credentials: "include", headers: { Range: "bytes=0-0" } });
    if (response.ok) return { failure: "other", message: t("This file can’t be shown here.") };
    const refusal = (await response.json().catch(() => ({}))) as { error?: unknown; code?: unknown };
    const failure = failureOf(typeof refusal.code === "string" ? refusal.code : undefined);
    return { failure, message: failureText(failure, serverMessage(refusal.error)) };
  } catch {
    return { failure: "other", message: t("Can’t reach the Kago server") };
  }
}

function Body({ token, name, path, item, kind, source, download, canDownload }: { token: string; name: string; path: string; item: ShareItem | null; kind: ReturnType<typeof viewerKind>; source: string; download: string; canDownload: boolean }) {
  const [failed, setFailed] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const fail = () => void reasonFor(source).then((reason) => setFailed(reason.message));
  const shown = { kind: "file", type: item?.type ?? guessType(name), name } as const;
  const noDownload = canDownload ? undefined : "nodownload noplaybackrate";

  if (kind === null || failed) {
    return (
      <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
        <FileTile item={shown} className="size-24" />
        <p className="m-0 text-[#d4d6d9]">{failed ?? (canDownload ? t("This kind of file can’t be viewed in the browser. Download it to open it.") : t("This kind of file can’t be viewed in the browser."))}</p>
        {canDownload && !failed ? (
          <a className={buttonVariants({ variant: "default", size: "lg" })} href={download} download>
            <Download />
            {t("Download")}
          </a>
        ) : null}
      </div>
    );
  }
  if (kind === "pdf") {
    return (
      <div className="flex max-w-sm flex-col items-center gap-3 px-6 text-center">
        <FileTile item={shown} className="size-24" />
        <a className={buttonVariants({ variant: "default", size: "lg" })} href={source} target="_blank" rel="noreferrer">
          <ExternalLink />
          {t("Open")}
        </a>
      </div>
    );
  }
  if (kind === "text") return <TextBody source={source} onFail={fail} />;
  if (kind === "video") return <video key={path} className="max-h-full max-w-full" src={source} controls playsInline preload="metadata" controlsList={noDownload} disablePictureInPicture={!canDownload} onError={fail} />;
  if (kind === "audio") {
    return (
      <div className="flex w-full max-w-sm flex-col items-center gap-5 px-6">
        <FileTile item={shown} className="size-28" />
        <audio key={path} className="w-full" src={source} controls preload="metadata" controlsList={noDownload} onError={fail} />
      </div>
    );
  }
  return (
    <>
      {loaded ? null : <KagoSpinner className="absolute size-5 text-[#d4d6d9]" />}
      <img key={path} src={source} alt={name} draggable={false} className={cn("max-h-full max-w-full object-contain select-none", loaded ? "" : "invisible")} onLoad={() => setLoaded(true)} onError={fail} />
    </>
  );
}

function TextBody({ source, onFail }: { source: string; onFail: () => void }) {
  const [text, setText] = useState<{ body: string; cut: number | null } | null>(null);
  useEffect(() => {
    let live = true;
    void fetch(source, { credentials: "include", headers: { Range: `bytes=0-${TEXT_BYTES - 1}` } })
      .then(async (response) => {
        if (!live) return;
        if (!response.ok) return onFail();
        const total = Number(/\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "")?.[1]);
        const body = await response.text();
        if (live) setText({ body, cut: Number.isFinite(total) && total > TEXT_BYTES ? total : null });
      })
      .catch(() => live && onFail());
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `onFail` is made anew every render; the text is read again only for another file.
  }, [source]);
  if (!text) return <KagoSpinner className="size-5 text-[#d4d6d9]" />;
  return (
    <div className="flex size-full min-h-0 flex-col">
      <pre className="m-0 min-h-0 flex-1 overflow-auto px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap text-[#e8eaed] [overflow-wrap:anywhere]">{text.body}</pre>
      {text.cut ? <p className="m-0 px-4 py-2 text-center text-xs text-[#d4d6d9]">{t("Showing the first {size} of {total}.", { size: formatSize(TEXT_BYTES), total: formatSize(text.cut) })}</p> : null}
    </div>
  );
}
