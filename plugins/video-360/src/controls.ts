/** How long the controls stay up after the pointer last moved, while the video plays. */
export const IDLE_MS = 2500;

/** The controls are up while paused, and while playing only as long as the pointer is about or a slider is held. */
export const controlsShown = (state: { playing: boolean; active: boolean; dragging: boolean }) => !state.playing || state.active || state.dragging;

/** `0:12`, or `1:02:03` for a video of an hour or more. */
export function formatClock(seconds: number, long: boolean) {
  const whole = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor((whole % 3600) / 60);
  return long ? `${Math.floor(whole / 3600)}:${pad(minutes)}:${pad(whole % 60)}` : `${Math.floor(whole / 60)}:${pad(whole % 60)}`;
}

// Lucide's glyphs, as Kago draws them elsewhere.
const SPEAKER = "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z";
const GLYPHS = {
  play: ["M6 3 20 12 6 21Z"],
  pause: ["M15 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M7 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"],
  loud: [SPEAKER, "M16 9a5 5 0 0 1 0 6", "M19.364 18.364a9 9 0 0 0 0-12.728"],
  quiet: [SPEAKER, "M16 9a5 5 0 0 1 0 6"],
  muted: [SPEAKER, "M22 9 16 15", "M16 9 22 15"],
  reset: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  maximize: ["M8 3H5a2 2 0 0 0-2 2v3", "M21 8V5a2 2 0 0 0-2-2h-3", "M3 16v3a2 2 0 0 0 2 2h3", "M16 21h3a2 2 0 0 0 2-2v-3"],
  minimize: ["M8 3v3a2 2 0 0 1-2 2H3", "M21 8h-3a2 2 0 0 1-2-2V3", "M3 16h3a2 2 0 0 1 2 2v3", "M16 21v-3a2 2 0 0 1 2-2h3"]
} as const;

export type GlyphName = keyof typeof GLYPHS;

function glyph(name: GlyphName, className: string) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  for (const d of GLYPHS[name]) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

/** The native player draws these solid. */
const SOLID: GlyphName[] = ["play", "pause"];

export function setGlyph(host: HTMLElement, name: GlyphName) {
  if (host.dataset.glyph === name) return;
  host.dataset.glyph = name;
  host.replaceChildren(glyph(name, SOLID.includes(name) ? "kago-glyph kago-glyph-solid" : "kago-glyph"));
}

export function playerButton(onClick: () => void, className = "") {
  const button = element("button", `kago-player-button ${className}`.trim());
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

/** Names a button, in its tooltip and to a screen reader. */
export function setLabel(button: HTMLElement, label: string) {
  button.ariaLabel = label;
  button.dataset.tip = label;
}

export type Slider = {
  readonly element: HTMLElement;
  /** Whether the pointer holds it. */
  readonly dragging: () => boolean;
  /** Shows where the value is, and how much of the track is loaded, out of `max`. */
  show(value: number, max: number, loaded?: number): void;
};

/**
 * A thin track the pointer drags. `onChange` follows the drag and `onCommit` fires once on release. The keyboard
 * reaches the sliders through the player's own shortcuts, so they take no focus.
 */
export function createSlider(
  label: string,
  className: string,
  format: (value: number) => string,
  handlers: { onChange?: (value: number) => void; onCommit?: (value: number) => void; onDragging?: (dragging: boolean) => void }
): Slider {
  const loaded = element("div", "kago-player-loaded");
  const track = element("div", "kago-player-track", loaded, element("div", "kago-player-fill"));
  const hint = element("span", "kago-player-hint kago-player-glass");
  hint.hidden = true;
  const root = element("div", `kago-player-slider ${className}`.trim(), track, element("div", "kago-player-knob"), hint);
  root.role = "slider";
  root.ariaLabel = label;
  root.ariaValueMin = "0";
  let max = 0;
  let drag: number | null = null;

  const valueAt = (event: PointerEvent) => {
    const rect = root.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)) * max;
  };
  const percent = (amount: number) => `${max > 0 ? Math.min(100, Math.max(0, (amount / max) * 100)) : 0}%`;
  const hover = (amount: number | null) => {
    hint.hidden = amount === null;
    if (amount === null) return;
    hint.textContent = format(amount);
    root.style.setProperty("--hint", percent(amount));
  };
  const finish = (event: PointerEvent, commit: boolean) => {
    if (drag === null) return;
    const at = valueAt(event);
    drag = null;
    delete root.dataset.dragging;
    handlers.onDragging?.(false);
    if (commit) handlers.onCommit?.(at);
  };

  root.addEventListener("pointerdown", (event) => {
    if (max <= 0 || !event.isPrimary || event.button !== 0) return;
    root.setPointerCapture(event.pointerId);
    drag = valueAt(event);
    root.dataset.dragging = "";
    handlers.onDragging?.(true);
    handlers.onChange?.(drag);
  });
  root.addEventListener("pointermove", (event) => {
    if (max <= 0) return;
    const at = valueAt(event);
    hover(at);
    if (drag === null) return;
    drag = at;
    handlers.onChange?.(at);
  });
  root.addEventListener("pointerleave", () => hover(null));
  root.addEventListener("pointerup", (event) => finish(event, true));
  root.addEventListener("pointercancel", (event) => finish(event, false));

  return {
    element: root,
    dragging: () => drag !== null,
    show(value, total, buffered = 0) {
      max = total;
      const shown = drag ?? value;
      root.ariaDisabled = String(total <= 0);
      root.ariaValueMax = String(total);
      root.ariaValueNow = String(shown);
      root.ariaValueText = format(shown);
      root.style.setProperty("--value", percent(shown));
      root.style.setProperty("--loaded", percent(buffered));
    }
  };
}
