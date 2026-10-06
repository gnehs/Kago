import { Maximize, Minimize, Pause, PictureInPicture2, Play, Volume1, Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { KagoIconButton } from "@/components/kago/icon-button";
import { formatClock } from "@/lib/format";
import { getVideoVolume, setVideoVolume } from "@/lib/prefs";
import { cn } from "@/lib/utils";

const IDLE_MS = 2500;
const SEEK_STEP = 5;
const VOLUME_STEP = 0.1;
/** The room the control bar takes at the bottom of the picture, in pixels. */
const CONTROLS_HEIGHT = 68;

/** Classes that put a ghost control on the player's dark bar, whatever the app theme is. */
export const PLAYER_CONTROL_CLASS = "text-white/85 hover:bg-white/15 hover:text-white data-[popup-open]:bg-white/15 data-[popup-open]:text-white";

type SettingsSlot = { container: HTMLElement | null; onOpenChange: (open: boolean) => void };

/**
 * Kago's video player: the picture fills the frame and the controls float over it, fading out
 * while it plays. It only drives the `<video>` element; whoever owns `videoRef` sets its source.
 */
export function VideoPlayer({
  videoRef,
  fallbackDuration = 0,
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
  const [active, setActive] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [height, setHeight] = useState(0);

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
    const observer = new ResizeObserver(() => setHeight(container.clientHeight));
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
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (container?.requestFullscreen) void container.requestFullscreen().catch(() => {});
    // iPhone Safari can only take the video itself fullscreen, with its own controls.
    else (videoRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null)?.webkitEnterFullscreen?.();
  };

  const togglePip = () => {
    if (document.pictureInPictureElement) void document.exitPictureInPicture().catch(() => {});
    else void videoRef.current?.requestPictureInPicture().catch(() => {});
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
    else return;
    event.preventDefault();
    wake();
  };

  const silent = sound.muted || sound.volume === 0;
  const VolumeIcon = silent ? VolumeX : sound.volume < 0.5 ? Volume1 : Volume2;

  return (
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
      style={{ "--subtitle-scale": controlsShown && height > CONTROLS_HEIGHT * 2 ? (height - CONTROLS_HEIGHT) / height : 1 } as React.CSSProperties}
      onPointerMove={wake}
      onPointerLeave={() => setActive(false)}
      onKeyDown={onKeyDown}
    >
      <video
        ref={videoRef}
        playsInline
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
          if (videoWidth > 0 && videoHeight > 0) onAspect?.(videoWidth / videoHeight);
        }}
        onLoadedData={onLoadedData}
        onPlaying={onPlaying}
        onError={onError}
      />

      {notice ? (
        <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center">
          <span className="rounded-full bg-black/75 px-3 py-1 text-xs text-white">{notice}</span>
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
          <PlayerButton label={playing ? "暫停（空白鍵）" : "播放（空白鍵）"} onClick={togglePlay}>
            {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </PlayerButton>
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
          <span className="truncate px-1.5 text-xs text-white/85 tabular-nums">
            {formatClock(time, long)} / {formatClock(duration, long)}
          </span>
          <div className="flex-1" />
          {renderSettings?.({ container: fullscreen ? container : null, onOpenChange: setMenuOpen })}
          {document.pictureInPictureEnabled ? (
            <PlayerButton label={pip ? "結束子母畫面" : "子母畫面"} className="hidden @sm:inline-flex" onClick={togglePip}>
              <PictureInPicture2 />
            </PlayerButton>
          ) : null}
          <PlayerButton label={fullscreen ? "結束全螢幕（F）" : "全螢幕（F）"} onClick={toggleFullscreen}>
            {fullscreen ? <Minimize /> : <Maximize />}
          </PlayerButton>
        </div>
      </div>
    </div>
  );
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
