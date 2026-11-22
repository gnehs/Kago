import { Pause, Play, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from "lucide-react";
import { useState, type ComponentProps, type ReactNode } from "react";
import { KagoIconButton } from "@/components/kago/icon-button";
import type { TimelinePicture } from "@/features/files/storyboard";
import { formatClock } from "@/lib/format";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Classes that put a ghost control on the player's dark bar, whatever the app theme is. */
export const PLAYER_CONTROL_CLASS = "text-[#d4d6d9] hover:text-white data-[popup-open]:text-white";

export function PlayerButton({ className, ...props }: ComponentProps<typeof KagoIconButton>) {
  return <KagoIconButton className={cn("size-7", PLAYER_CONTROL_CLASS, className)} {...props} />;
}

/** A step to another track or video. Left out where there is nothing to step through. */
type TransportStep = { label: string; disabled?: boolean; onClick: () => void };

/**
 * The row under the playhead that the video and the music player share: stepping, play and pause, the sound,
 * and the time. Whatever else a player has goes at the far end.
 */
export function PlayerTransport({
  playing,
  onTogglePlay,
  previous,
  next,
  sound,
  onSound,
  time,
  duration,
  children
}: {
  playing: boolean;
  onTogglePlay: () => void;
  previous?: TransportStep;
  next?: TransportStep;
  sound: { volume: number; muted: boolean };
  onSound: (volume: number, muted: boolean) => void;
  time: number;
  duration: number;
  children?: ReactNode;
}) {
  const silent = sound.muted || sound.volume === 0;
  const VolumeIcon = silent ? VolumeX : sound.volume < 0.5 ? Volume1 : Volume2;
  const long = duration >= 3600;
  return (
    <div className="flex items-center gap-1">
      {previous ? (
        <PlayerButton label={previous.label} disabled={previous.disabled} onClick={previous.onClick}>
          <SkipBack className="fill-current" />
        </PlayerButton>
      ) : null}
      <PlayerButton label={playing ? t("Pause (Space)") : t("Play (Space)")} className="kago-player-key mx-1 size-8 rounded-full" onClick={onTogglePlay}>
        {playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
      </PlayerButton>
      {next ? (
        <PlayerButton label={next.label} disabled={next.disabled} onClick={next.onClick}>
          <SkipForward className="fill-current" />
        </PlayerButton>
      ) : null}
      <PlayerButton label={silent ? t("Unmute (M)") : t("Mute (M)")} onClick={() => onSound(sound.volume || 1, !silent)}>
        <VolumeIcon />
      </PlayerButton>
      <PlayerSlider label={t("Volume")} className="hidden w-16 @sm:block" value={silent ? 0 : sound.volume} max={1} format={(volume) => `${Math.round(volume * 100)}%`} onChange={(volume) => onSound(volume, false)} />
      <span className="min-w-0 truncate px-1.5 text-xs text-white/80 tabular-nums">
        {formatClock(time, long)} / {formatClock(duration, long)}
      </span>
      <div className="flex-1" />
      {children}
    </div>
  );
}

/**
 * A thin track for the playhead and the volume. `onChange` follows the drag; `onCommit` fires once
 * on release. The keyboard reaches both through the player's own shortcuts, so it takes no focus.
 */
export function PlayerSlider({
  label,
  value,
  max,
  loaded = 0,
  format,
  className,
  onChange,
  onCommit,
  onPreview,
  picture,
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
  onPreview?: (value: number | null) => void;
  /** What stands at a value, shown over the hint of it. */
  picture?: (value: number) => TimelinePicture | null;
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
    onPreview?.(null);
    if (drag === null) return;
    if (commit) onCommit?.(valueAt(event));
    setDrag(null);
    onDragging?.(false);
  };
  const hint = drag ?? hover;
  const shownPicture = hint === null ? null : (picture?.(hint) ?? null);

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
        onPreview?.(next);
      }}
      onPointerMove={(event) => {
        if (!enabled) return;
        const next = valueAt(event);
        setHover(next);
        if (event.pointerType !== "touch" || drag !== null) onPreview?.(next);
        if (drag === null) return;
        setDrag(next);
        onChange?.(next);
      }}
      onPointerLeave={() => {
        setHover(null);
        onPreview?.(null);
      }}
      onPointerUp={(event) => end(event, true)}
      onPointerCancel={(event) => end(event, false)}
    >
      <div className="kago-player-track absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full">
        <div className="absolute inset-y-0 left-0 rounded-full bg-white/25" style={{ width: percent(loaded) }} />
        <div className="kago-player-fill absolute inset-y-0 left-0 rounded-full" style={{ width: percent(shown) }} />
      </div>
      <div
        className={cn("kago-player-knob absolute top-1/2 size-3.5 -translate-1/2 rounded-full opacity-0 group-hover/slider:opacity-100", drag !== null && "opacity-100")}
        style={{ left: percent(shown) }}
      />
      {hint === null ? null : shownPicture ? (
        // Kept whole inside the slider: a picture half off the edge of the player is no use at either end.
        <div
          className="pointer-events-none absolute bottom-full mb-2 flex -translate-x-1/2 flex-col items-center gap-1.5"
          style={{ left: `clamp(${shownPicture.width / 2}px, ${percent(hint)}, calc(100% - ${shownPicture.width / 2}px))` }}
        >
          <div
            className="rounded-md bg-black shadow-[0_0_0_1px_rgb(255_255_255/0.28),0_8px_24px_rgb(0_0_0/0.5)]"
            style={{
              width: shownPicture.width,
              height: shownPicture.height,
              backgroundImage: `url("${shownPicture.url}")`,
              backgroundPosition: `-${shownPicture.x}px -${shownPicture.y}px`,
              backgroundSize: `${shownPicture.sheetWidth}px ${shownPicture.sheetHeight}px`
            }}
          />
          <span className="kago-player-glass rounded-sm px-1.5 py-0.5 text-xs whitespace-nowrap tabular-nums">{format(hint)}</span>
        </div>
      ) : (
        <span className="kago-player-glass pointer-events-none absolute bottom-full mb-2 -translate-x-1/2 rounded-sm px-1.5 py-0.5 text-xs whitespace-nowrap tabular-nums" style={{ left: percent(hint) }}>
          {format(hint)}
        </span>
      )}
    </div>
  );
}
