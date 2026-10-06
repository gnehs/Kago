import { Maximize, Minimize, Pause, PictureInPicture2, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { KagoIconButton } from "@/components/kago/icon-button";
import { formatClock } from "@/lib/format";
import { getVideoVolume, setVideoVolume } from "@/lib/prefs";
import { cn } from "@/lib/utils";
import { startCompositePip } from "./compositePip";

const IDLE_MS = 2500;
const SEEK_STEP = 5;
const VOLUME_STEP = 0.1;
/** The room the control bar takes at the bottom of the picture, in pixels. */
const CONTROLS_HEIGHT = 68;

/** Classes that put a ghost control on the player's dark bar, whatever the app theme is. */
export const PLAYER_CONTROL_CLASS = "text-white/85 hover:bg-white/15 hover:text-white data-[popup-open]:bg-white/15 data-[popup-open]:text-white";

/** Chromium's Document Picture-in-Picture: a floating window that holds page content, not just a video's frames. */
const documentPip = (globalThis as { documentPictureInPicture?: { requestWindow: (options: { width: number; height: number }) => Promise<Window> } }).documentPictureInPicture;

/** Gives a floating window the page's styles, which it does not inherit. */
function copyStyles(target: Document) {
  for (const sheet of document.styleSheets) {
    try {
      const style = target.createElement("style");
      style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
      target.head.append(style);
    } catch {
      // A cross-origin sheet hides its rules; link it instead.
      if (!sheet.href) continue;
      const link = target.createElement("link");
      link.rel = "stylesheet";
      link.href = sheet.href;
      target.head.append(link);
    }
  }
  target.documentElement.dataset.theme = document.documentElement.dataset.theme;
  target.body.className = "flex flex-col bg-black";
  target.body.style.minWidth = "0";
}

/** Another video to go to from this one. */
export type PlayerNeighbour = { label: string; go: () => void };

type SettingsSlot = { container: HTMLElement | null; onOpenChange: (open: boolean) => void };

/**
 * Kago's video player: the picture fills the frame and the controls float over it, fading out
 * while it plays. It only drives the `<video>` element; whoever owns `videoRef` sets its source.
 */
export function VideoPlayer({
  videoRef,
  mediaKey,
  fallbackDuration = 0,
  previous,
  next,
  notice,
  renderSettings,
  onAspect,
  onLoadedData,
  onPlaying,
  onError
}: {
  videoRef: RefObject<HTMLVideoElement | null>;
  /** The length to show until the element knows its own. */
  fallbackDuration?: number;
  /** Changes when a different video is put in the player, as opposed to another rendition of the same one. */
  mediaKey?: string;
  /** The videos before and after this one, where it is one of several; null at either end. */
  previous?: PlayerNeighbour | null;
  next?: PlayerNeighbour | null;
  notice?: string | null;
  /** The quality menu, given where to mount its popup and a way to keep the controls up while it is open. */
  renderSettings?: (slot: SettingsSlot) => ReactNode;
  onAspect?: (aspect: number) => void;
  onLoadedData?: () => void;
  onPlaying?: () => void;
  onError?: () => void;
}) {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [ownDuration, setOwnDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [sound, setSound] = useState(getVideoVolume);
  const [fullscreen, setFullscreen] = useState(false);
  const [pip, setPip] = useState(false);
  // The player lives in an element of its own so it can be carried into a floating window whole, subtitles and
  // controls included. React listens for events on that element, so they keep arriving wherever it is.
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.className = "flex min-h-0 flex-1 flex-col";
    return element;
  });
  const home = useRef<HTMLDivElement>(null);
  const endComposite = useRef<(() => void) | null>(null);
  const [floating, setFloating] = useState<Window | null>(null);

  useLayoutEffect(() => {
    home.current?.append(host);
    return () => host.remove();
  }, [host]);

  useEffect(() => () => floating?.close(), [floating]);
  useEffect(() => () => endComposite.current?.(), []);
  const [active, setActive] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  // Waiting on the network: before the first frame, or stalled mid-way with nothing left buffered.
  const [loading, setLoading] = useState(false);
  const [frame, setFrame] = useState({ width: 0, height: 0 });
  const [pictureAspect, setPictureAspect] = useState(0);

  // A change of quality keeps the playhead on screen while it loads; a change of video starts the display over.
  useEffect(() => {
    setTime(0);
    setBuffered(0);
    setOwnDuration(0);
  }, [mediaKey]);

  const duration = ownDuration || fallbackDuration;
  const long = duration >= 3600;
  const controlsShown = !playing || active || menuOpen || scrubbing;

  const wake = () => {
    setActive(true);
    globalThis.clearTimeout(idleTimer.current);
    idleTimer.current = globalThis.setTimeout(() => setActive(false), IDLE_MS);
  };

  useEffect(() => () => globalThis.clearTimeout(idleTimer.current), []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const saved = getVideoVolume();
    video.volume = saved.volume;
    video.muted = saved.muted;
    // React has no props for these two.
    const onPip = () => setPip(document.pictureInPictureElement === video);
    video.addEventListener("enterpictureinpicture", onPip);
    video.addEventListener("leavepictureinpicture", onPip);
    return () => {
      video.removeEventListener("enterpictureinpicture", onPip);
      video.removeEventListener("leavepictureinpicture", onPip);
    };
  }, [videoRef]);

  useEffect(() => {
    if (!container) return;
    // Shortcuts work as soon as the window opens, without a first click on the picture.
    container.focus({ preventScroll: true });
    const onChange = () => setFullscreen(document.fullscreenElement === container);
    document.addEventListener("fullscreenchange", onChange);
    const observer = new ResizeObserver(() => setFrame({ width: container.clientWidth, height: container.clientHeight }));
    observer.observe(container);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      observer.disconnect();
    };
  }, [container]);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused || video.ended) void video.play().catch(() => {});
    else video.pause();
  };

  const seekTo = (seconds: number) => {
    const video = videoRef.current;
    if (!video || duration <= 0) return;
    const next = Math.min(Math.max(0, seconds), duration);
    video.currentTime = next;
    setTime(next);
  };

  const changeSound = (volume: number, muted: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = Math.min(1, Math.max(0, volume));
    video.muted = muted;
  };

  const toggleFullscreen = () => {
    if (floating) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (container?.requestFullscreen) void container.requestFullscreen().catch(() => {});
    // iPhone Safari can only take the video itself fullscreen, with its own controls.
    else (videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.();
  };

  /** The browser's own picture-in-picture. Only a video's frames float this way, so subtitles are painted into them. */
  const toggleVideoPip = () => {
    if (endComposite.current) return endComposite.current();
    if (document.pictureInPictureElement) return void document.exitPictureInPicture().catch(() => {});
    const video = videoRef.current;
    if (!video) return;
    const plain = () => void video.requestPictureInPicture().catch(() => {});
    const subtitles = () => container?.querySelector<HTMLCanvasElement>("canvas.libassjs-canvas") ?? null;
    if (!subtitles() || video.videoHeight === 0) return plain();
    startCompositePip(video, subtitles, () => {
      endComposite.current = null;
      setPip(false);
    }).then((end) => {
      endComposite.current = end;
      setPip(true);
    }, plain);
  };

  /** Moves the player between documents. A media element may start over when it changes document, so the playhead is put back. */
  const carry = (move: () => void) => {
    const video = videoRef.current;
    const time = video?.currentTime ?? 0;
    const playing = video ? !video.paused && !video.ended : false;
    move();
    if (!video) return;
    const restore = () => {
      if (Math.abs(video.currentTime - time) > 1) video.currentTime = time;
      if (playing && video.paused) void video.play().catch(() => {});
    };
    if (video.readyState > 0) restore();
    else video.addEventListener("loadedmetadata", restore, { once: true });
  };

  const togglePip = () => {
    if (floating) return floating.close();
    if (!documentPip || pip) return toggleVideoPip();
    const video = videoRef.current;
    const ratio = video && video.videoHeight > 0 ? video.videoWidth / video.videoHeight : 16 / 9;
    const width = ratio >= 1 ? 480 : 270;
    void documentPip.requestWindow({ width, height: Math.round(width / ratio) }).then((target) => {
      copyStyles(target.document);
      target.document.title = document.title;
      carry(() => target.document.body.append(host));
      target.addEventListener("pagehide", () => {
        carry(() => home.current?.append(host));
        setFloating(null);
      });
      setFloating(target);
      // A browser that has the API but will not open the window still gets a floating video.
    }, toggleVideoPip);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as Element;
    if (target.closest("[role=menu]")) return;
    if (event.key === "Escape") {
      // Leaving fullscreen must not also close the window.
      if (fullscreen) event.stopPropagation();
      return;
    }
    // A focused button keeps the keys it answers to itself.
    if (target.closest("button") && [" ", "Enter", "ArrowUp", "ArrowDown"].includes(event.key)) return;
    const key = event.key.toLowerCase();
    if (key === " " || key === "k") togglePlay();
    else if (key === "arrowleft") seekTo(time - SEEK_STEP);
    else if (key === "arrowright") seekTo(time + SEEK_STEP);
    else if (key === "arrowup") changeSound(sound.volume + VOLUME_STEP, false);
    else if (key === "arrowdown") changeSound(sound.volume - VOLUME_STEP, false);
    else if (key === "m") changeSound(sound.volume, !sound.muted);
    else if (key === "f") toggleFullscreen();
    else if (key === "n" && event.shiftKey && next) next.go();
    else if (key === "p" && event.shiftKey && previous) previous.go();
    else return;
    event.preventDefault();
    wake();
  };

  const silent = sound.muted || sound.volume === 0;
  const VolumeIcon = silent ? VolumeX : sound.volume < 0.5 ? Volume1 : Volume2;

  const player = (
    <div
      ref={setContainer}
      tabIndex={-1}
      className={cn(
        "@container relative min-h-0 flex-1 overflow-hidden bg-black outline-none",
        // The subtitle renderer adds its canvas next to the video. While the control bar is up the canvas shrinks
        // towards its top edge: lines at the bottom clear the bar, and ones pinned to the top stay in view.
        "[&_.libassjs-canvas]:origin-top [&_.libassjs-canvas]:scale-(--subtitle-scale) [&_.libassjs-canvas]:transition-transform [&_.libassjs-canvas]:duration-150",
        !controlsShown && "cursor-none"
      )}
      style={{ "--subtitle-scale": controlsShown ? subtitleScale(frame, pictureAspect) : 1 } as React.CSSProperties}
      onPointerMove={wake}
      onPointerLeave={() => setActive(false)}
      onKeyDown={onKeyDown}
    >
      <video
        ref={videoRef}
        playsInline
        // The original file is buffered ahead as soon as it opens, as a transcoded stream is, rather than on the first press of play.
        preload="auto"
        onLoadStart={() => setLoading(true)}
        onWaiting={() => setLoading(true)}
        onCanPlay={() => setLoading(false)}
        onEmptied={() => setLoading(false)}
        className="absolute inset-0 size-full object-contain"
        onClick={(event) => {
          // A tap first brings the controls back; there is no hover to do that on a touch screen.
          if ((event.nativeEvent as PointerEvent).pointerType === "touch" && !controlsShown) wake();
          else togglePlay();
        }}
        onDoubleClick={toggleFullscreen}
        onPlay={() => {
          setPlaying(true);
          wake();
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          // While a new source loads the element sits at zero; keep showing where it will resume.
          if (event.currentTarget.readyState > 0) setTime(event.currentTarget.currentTime);
        }}
        onDurationChange={(event) => setOwnDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
        onProgress={(event) => setBuffered(bufferedEnd(event.currentTarget))}
        onVolumeChange={(event) => {
          const next = { volume: event.currentTarget.volume, muted: event.currentTarget.muted };
          setSound(next);
          setVideoVolume(next.volume, next.muted);
        }}
        onLoadedMetadata={(event) => {
          const { videoWidth, videoHeight } = event.currentTarget;
          if (videoWidth <= 0 || videoHeight <= 0) return;
          setPictureAspect(videoWidth / videoHeight);
          onAspect?.(videoWidth / videoHeight);
        }}
        onLoadedData={onLoadedData}
        onPlaying={() => {
          setLoading(false);
          onPlaying?.();
        }}
        onError={onError}
      />

      {(notice ?? (loading ? "載入中…" : null)) ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <span className="rounded-full bg-black/75 px-3 py-1 text-xs text-white">{notice ?? "載入中…"}</span>
        </div>
      ) : playing ? null : (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-black/60 text-white">
            <Play className="size-6! translate-x-0.5 fill-current" />
          </span>
        </div>
      )}

      <div
        className={cn(
          "absolute inset-x-2 bottom-2 flex flex-col rounded-lg bg-black/75 px-2 pt-1 pb-1 text-white transition-opacity duration-150",
          controlsShown ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onFocus={wake}
      >
        <Slider
          label="播放進度"
          value={time}
          max={duration}
          loaded={buffered}
          format={(seconds) => formatClock(seconds, long)}
          onDragging={setScrubbing}
          // Committed on release: every seek in a transcoded stream may restart the encoder.
          onCommit={seekTo}
        />
        <div className="flex items-center gap-0.5">
          {previous !== undefined ? (
            <PlayerButton label={previous ? `上一部：${previous.label}（⇧P）` : "沒有上一部"} disabled={!previous} onClick={() => previous?.go()}>
              <SkipBack className="fill-current" />
            </PlayerButton>
          ) : null}
          <PlayerButton label={playing ? "暫停（空白鍵）" : "播放（空白鍵）"} onClick={togglePlay}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </PlayerButton>
          {next !== undefined ? (
            <PlayerButton label={next ? `下一部：${next.label}（⇧N）` : "沒有下一部"} disabled={!next} onClick={() => next?.go()}>
              <SkipForward className="fill-current" />
            </PlayerButton>
          ) : null}
          <PlayerButton label={silent ? "取消靜音（M）" : "靜音（M）"} onClick={() => changeSound(sound.volume || 1, !silent)}>
            <VolumeIcon />
          </PlayerButton>
          <Slider
            label="音量"
            className="hidden w-16 @sm:block"
            value={silent ? 0 : sound.volume}
            max={1}
            format={(volume) => `${Math.round(volume * 100)}%`}
            onChange={(volume) => changeSound(volume, false)}
          />
          <span className="min-w-0 truncate px-1.5 text-xs text-white/85 tabular-nums">
            {formatClock(time, long)} / {formatClock(duration, long)}
          </span>
          <div className="flex-1" />
          {renderSettings?.({ container: fullscreen || floating ? container : null, onOpenChange: setMenuOpen })}
          {documentPip || document.pictureInPictureEnabled ? (
            <PlayerButton label={pip || floating ? "結束子母畫面" : "子母畫面"} className={floating ? undefined : "hidden @sm:inline-flex"} onClick={togglePip}>
              <PictureInPicture2 />
            </PlayerButton>
          ) : null}
          {floating ? null : (
            <PlayerButton label={fullscreen ? "結束全螢幕（F）" : "全螢幕（F）"} onClick={toggleFullscreen}>
              {fullscreen ? <Minimize /> : <Maximize />}
            </PlayerButton>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <>
      {floating ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-black text-white/80">
          <PictureInPicture2 />
          <span>正在子母畫面中播放</span>
          <Button onClick={() => floating.close()}>回到這裡播放</Button>
        </div>
      ) : null}
      <div ref={home} className="contents" />
      {createPortal(player, host)}
    </>
  );
}

/**
 * How much the subtitles shrink to clear the control bar. They cover the picture, not the frame: when the picture
 * is letterboxed, the bar sits partly or wholly in the black below it and less room, or none, has to be made.
 */
function subtitleScale(frame: { width: number; height: number }, aspect: number) {
  if (frame.height <= 0) return 1;
  const picture = aspect > 0 ? Math.min(frame.height, frame.width / aspect) : frame.height;
  const covered = CONTROLS_HEIGHT - (frame.height - picture) / 2;
  return covered > 0 && picture > CONTROLS_HEIGHT * 2 ? (picture - covered) / picture : 1;
}

function PlayerButton({ className, ...props }: ComponentProps<typeof KagoIconButton>) {
  return <KagoIconButton className={cn("size-7", PLAYER_CONTROL_CLASS, className)} {...props} />;
}

/** How far the stretch of loaded video around the playhead reaches. */
function bufferedEnd(video: HTMLVideoElement) {
  const ranges = video.buffered;
  for (let index = 0; index < ranges.length; index += 1) {
    if (ranges.start(index) <= video.currentTime + 0.5 && video.currentTime <= ranges.end(index)) return ranges.end(index);
  }
  return 0;
}

/**
 * A thin track for the playhead and the volume. `onChange` follows the drag; `onCommit` fires once
 * on release. The keyboard reaches both through the player's own shortcuts, so it takes no focus.
 */
function Slider({
  label,
  value,
  max,
  loaded = 0,
  format,
  className,
  onChange,
  onCommit,
  onDragging
}: {
  label: string;
  value: number;
  max: number;
  loaded?: number;
  format: (value: number) => string;
  className?: string;
  onChange?: (value: number) => void;
  onCommit?: (value: number) => void;
  onDragging?: (dragging: boolean) => void;
}) {
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const enabled = max > 0;
  const shown = drag ?? value;
  const percent = (amount: number) => `${enabled ? Math.min(100, Math.max(0, (amount / max) * 100)) : 0}%`;
  const valueAt = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * max;
  };
  const end = (event: React.PointerEvent<HTMLElement>, commit: boolean) => {
    if (drag === null) return;
    if (commit) onCommit?.(valueAt(event));
    setDrag(null);
    onDragging?.(false);
  };
  const hint = drag ?? hover;

  return (
    <div
      role="slider"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={shown}
      aria-valuetext={format(shown)}
      aria-disabled={!enabled}
      className={cn("group/slider relative h-4 touch-none", className)}
      onPointerDown={(event) => {
        if (!enabled || !event.isPrimary || event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const next = valueAt(event);
        setDrag(next);
        onDragging?.(true);
        onChange?.(next);
      }}
      onPointerMove={(event) => {
        if (!enabled) return;
        const next = valueAt(event);
        setHover(next);
        if (drag === null) return;
        setDrag(next);
        onChange?.(next);
      }}
      onPointerLeave={() => setHover(null)}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
    >
      <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 overflow-hidden rounded-full bg-white/25">
        <div className="absolute inset-y-0 left-0 bg-white/30" style={{ width: percent(loaded) }} />
        <div className="absolute inset-y-0 left-0 bg-white" style={{ width: percent(shown) }} />
      </div>
      <div
        className={cn("absolute top-1/2 size-3 -translate-1/2 rounded-full bg-white opacity-0 group-hover/slider:opacity-100", drag !== null && "opacity-100")}
        style={{ left: percent(shown) }}
      />
      {hint === null ? null : (
        <span className="pointer-events-none absolute bottom-full mb-1.5 -translate-x-1/2 rounded-sm bg-black/85 px-1.5 py-0.5 text-xs whitespace-nowrap text-white tabular-nums" style={{ left: percent(hint) }}>
          {format(hint)}
        </span>
      )}
    </div>
  );
}
