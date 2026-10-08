import { useEffect, useMemo, type RefObject } from "react";

/** What the music is drawn as. */
export type VisualStyle = "bars" | "scope" | "ambience";

export const VISUAL_STYLES: VisualStyle[] = ["bars", "scope", "ambience"];

type Rgb = [number, number, number];

/** One frame's worth of sound and the canvas to draw it on. Sizes are in the canvas's own pixels. */
type Frame = {
  context: CanvasRenderingContext2D;
  width: number;
  height: number;
  /** How much of the bottom of the canvas lies under the controls. */
  floor: number;
  /** Canvas pixels to a CSS pixel. */
  scale: number;
  /** Loudness by frequency, low to high, and the waveform itself; both 0–255. */
  spectrum: Uint8Array;
  wave: Uint8Array;
  /** Seconds since the frame before. */
  elapsed: number;
  accent: Rgb;
};

type Draw = (frame: Frame) => void;

const mix = (from: Rgb, to: Rgb, amount: number): Rgb => [0, 1, 2].map((index) => Math.round(from[index]! + (to[index]! - from[index]!) * amount)) as Rgb;
const css = ([red, green, blue]: Rgb, alpha = 1) => `rgb(${red} ${green} ${blue} / ${alpha})`;
const WHITE: Rgb = [255, 255, 255];
const FALLBACK_ACCENT: Rgb = [91, 141, 250];

function parseHex(value: string): Rgb {
  const hex = /^#([0-9a-f]{6})$/i.exec(value.trim())?.[1];
  return hex ? [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as Rgb : FALLBACK_ACCENT;
}

/** How loud the lowest notes are, 0–1: what a picture can be made to beat with. */
function bass(spectrum: Uint8Array) {
  let sum = 0;
  for (let bin = 1; bin <= 8; bin += 1) sum += spectrum[bin]!;
  return sum / (8 * 255);
}

/**
 * A spectrum analyser: a row of bars that jump with the music and fall back slowly, each with a cap
 * that hangs where the bar last peaked. They stand on the control bar and are mirrored faintly under it.
 */
function bars(): Draw {
  let levels: number[] = [];
  let peaks: number[] = [];
  return ({ context, width, height, floor, scale, spectrum, elapsed, accent }) => {
    context.clearRect(0, 0, width, height);
    const pitch = 9 * scale;
    const bar = 6 * scale;
    const count = Math.max(8, Math.floor((width - 32 * scale) / pitch));
    const left = (width - (count - 1) * pitch - bar) / 2;
    const base = height - floor;
    const room = Math.max(0, base - 72 * scale);
    if (levels.length !== count) {
      levels = new Array<number>(count).fill(0);
      peaks = new Array<number>(count).fill(0);
    }
    // Pitch is heard in octaves, so the bands widen as they go up; the top quarter of the spectrum is all but silent.
    const first = 2;
    const last = spectrum.length * 0.72;
    const tone = context.createLinearGradient(0, base - room, 0, base);
    tone.addColorStop(0, css(mix(accent, WHITE, 0.55)));
    tone.addColorStop(1, css(accent));
    const mirror = context.createLinearGradient(0, base, 0, base + room * 0.3);
    mirror.addColorStop(0, css(accent, 0.28));
    mirror.addColorStop(1, css(accent, 0));
    for (let index = 0; index < count; index += 1) {
      const from = Math.floor(first * (last / first) ** (index / count));
      const to = Math.max(from + 1, Math.floor(first * (last / first) ** ((index + 1) / count)));
      let loudest = 0;
      for (let bin = from; bin < to; bin += 1) loudest = Math.max(loudest, spectrum[bin] ?? 0);
      const level = Math.max((loudest / 255) ** 1.4, levels[index]! - elapsed * 1.6);
      levels[index] = level;
      peaks[index] = Math.max(level, peaks[index]! - elapsed * 0.3);
      const x = left + index * pitch;
      const tall = Math.max(scale, level * room);
      context.fillStyle = tone;
      context.beginPath();
      context.roundRect(x, base - tall, bar, tall, [scale * 1.5, scale * 1.5, 0, 0]);
      context.fill();
      context.fillStyle = mirror;
      context.fillRect(x, base + scale, bar, tall * 0.3);
      if (peaks[index]! > 0.01) {
        context.fillStyle = css(WHITE, 0.75);
        context.fillRect(x, base - peaks[index]! * room - 3 * scale, bar, 1.5 * scale);
      }
    }
  };
}

/** An oscilloscope: the waveform as one glowing line, each trace fading the way a phosphor screen lets go of it. */
function scope(): Draw {
  return ({ context, width, height, floor, scale, wave, accent }) => {
    context.fillStyle = "rgb(0 0 0 / 0.3)";
    context.fillRect(0, 0, width, height);
    const middle = (height - floor) / 2 + 16 * scale;
    const reach = (height - floor) * 0.36;
    // Starting each trace where the wave rises through zero keeps a steady note standing still.
    let start = 0;
    for (let at = 1; at < wave.length / 2; at += 1) {
      if (wave[at - 1]! < 128 && wave[at]! >= 128) {
        start = at;
        break;
      }
    }
    const span = wave.length / 2;
    context.beginPath();
    for (let step = 0; step <= span; step += 2) {
      const x = (step / span) * width;
      const y = middle + ((wave[start + step] ?? 128) / 128 - 1) * reach;
      if (step === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.lineJoin = "round";
    context.lineWidth = 2 * scale;
    context.strokeStyle = css(mix(accent, WHITE, 0.45));
    context.shadowColor = css(accent);
    context.shadowBlur = 14 * scale;
    context.stroke();
    context.shadowBlur = 0;
  };
}

/**
 * A ring drawn from the waveform that beats with the bass, on a picture that keeps flowing outwards:
 * every frame is the last one, a little larger, turned and dimmer, with the new ring on top.
 */
function ambience(): Draw {
  let turn = 0;
  return ({ context, width, height, floor, scale, spectrum, wave, elapsed, accent }) => {
    const low = bass(spectrum);
    const centerX = width / 2;
    const centerY = (height - floor) / 2 + 16 * scale;
    const grow = 1 + (0.9 + low * 1.6) * elapsed;
    context.save();
    context.translate(centerX, centerY);
    context.rotate((0.25 + low * 0.5) * elapsed);
    context.scale(grow, grow);
    context.translate(-centerX, -centerY);
    context.globalAlpha = 0.94;
    context.drawImage(context.canvas, 0, 0);
    context.restore();
    context.fillStyle = `rgb(0 0 0 / ${Math.min(1, elapsed * 3.5)})`;
    context.fillRect(0, 0, width, height);

    turn += elapsed * 0.4;
    const radius = Math.min(width, height - floor) * (0.14 + low * 0.08);
    const points = 180;
    context.beginPath();
    for (let point = 0; point <= points; point += 1) {
      // The wave is read out and back so the ring closes where it began.
      const sample = point <= points / 2 ? point : points - point;
      const swing = ((wave[sample * 4] ?? 128) / 128 - 1) * radius * 0.9;
      const angle = (point / points) * Math.PI * 2 + turn;
      const x = centerX + Math.cos(angle) * (radius + swing);
      const y = centerY + Math.sin(angle) * (radius + swing);
      if (point === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.closePath();
    context.lineJoin = "round";
    context.lineWidth = 2 * scale;
    context.strokeStyle = css(mix(accent, WHITE, 0.1 + low * 0.4));
    context.stroke();
  };
}

const VISUALS: Record<VisualStyle, () => Draw> = { bars, scope, ambience };

/** How long the picture keeps moving after the sound stops, so it settles instead of freezing mid-beat. */
const SETTLE_MS = 2500;

/**
 * Draws the sound passing through `analyser` on a canvas, for as long as it is `running` and a moment after.
 * Nothing is drawn, and no frame is asked for, while there is nothing to see.
 */
export function useAudioVisual(canvasRef: RefObject<HTMLCanvasElement | null>, analyser: () => AnalyserNode | null, style: VisualStyle | null, running: boolean, floor: number) {
  // What a picture remembers from frame to frame outlasts a pause, so its bars fall instead of vanishing.
  const draw = useMemo(() => (style ? VISUALS[style]() : null), [style]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || !draw) return;
    let spectrum = new Uint8Array(0);
    let wave = new Uint8Array(0);
    let accent = FALLBACK_ACCENT;
    let request = 0;
    let last = performance.now();
    let frames = 0;
    const until = running ? Infinity : last + SETTLE_MS;

    const tick = (now: number) => {
      const scale = globalThis.devicePixelRatio || 1;
      const width = Math.round(canvas.clientWidth * scale);
      const height = Math.round(canvas.clientHeight * scale);
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      // The accent differs between the themes, and the theme can change while a song plays.
      if (frames % 120 === 0) accent = parseHex(getComputedStyle(canvas).getPropertyValue("--kago-accent"));
      frames += 1;
      const node = analyser();
      if (node && spectrum.length !== node.frequencyBinCount) {
        spectrum = new Uint8Array(node.frequencyBinCount);
        wave = new Uint8Array(node.fftSize).fill(128);
      }
      node?.getByteFrequencyData(spectrum);
      node?.getByteTimeDomainData(wave);
      if (width > 0 && height > 0) draw({ context, width, height, floor: floor * scale, scale, spectrum, wave, elapsed: Math.min(0.1, (now - last) / 1000), accent });
      last = now;
      if (now < until) request = requestAnimationFrame(tick);
    };
    request = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(request);
  }, [canvasRef, analyser, draw, running, floor]);

  // A picture that is turned off leaves nothing behind.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!style && canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
  }, [canvasRef, style]);
}
