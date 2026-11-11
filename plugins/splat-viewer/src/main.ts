import { connect } from "@kago/plugin-sdk";
import "@kago/plugin-sdk/kago.css";
import "./style.css";
import { openScene, type Scene, type SceneState, type SplatMode } from "./scene";
import { stringsFor } from "./strings";

/** How fast a scene is flown through, as a multiple of the viewer's own pace. */
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8] as const;
const SPEED_KEY = "speed";

// Lucide's glyphs, as Kago draws them elsewhere: Rotate3d, Move3d, Scan, RotateCcw, Check and LoaderCircle.
const GLYPHS = {
  orbit: ["M16.466 7.5C15.643 4.237 13.952 2 12 2 9.239 2 7 6.477 7 12s2.239 10 5 10c.342 0 .677-.069 1-.2", "m15.194 13.707 3.814 1.86-1.86 3.814", "M19 15.57c-1.804.885-4.274 1.43-7 1.43-5.523 0-10-2.239-10-5s4.477-5 10-5c4.838 0 8.873 1.718 9.8 4"],
  fly: ["M5 3v16h16", "m5 19 6-6", "m2 6 3-3 3 3", "m18 16 3 3-3 3"],
  frame: ["M3 7V5a2 2 0 0 1 2-2h2", "M17 3h2a2 2 0 0 1 2 2v2", "M21 17v2a2 2 0 0 1-2 2h-2", "M7 21H5a2 2 0 0 1-2-2v-2"],
  reset: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
  check: ["M20 6 9 17l-5-5"],
  spinner: ["M21 12a9 9 0 1 1-6.219-8.56"]
};

function glyph(name: keyof typeof GLYPHS, className = "kago-glyph") {
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

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, ...children: (Node | string)[]) {
  const node = document.createElement(tag);
  node.className = className;
  node.append(...children);
  return node;
}

function iconButton(label: string, name: keyof typeof GLYPHS, onClick: () => void) {
  const button = element("button", "kago-button", glyph(name));
  button.type = "button";
  button.ariaLabel = label;
  button.dataset.tip = label;
  button.addEventListener("click", onClick);
  return button;
}

const kago = await connect();
const text = stringsFor(kago.locale);
const stored = Number(await kago.storage.get(SPEED_KEY));
let speed: number = SPEEDS.find((allowed) => allowed === stored) ?? 1;
let state: SceneState = { loaded: false, progress: 0, mode: null, touch: false };
let scene: Scene | null = null;

const stage = element("div", "stage");
const waiting = element("div", "waiting", glyph("spinner", "kago-glyph kago-spinner"));
waiting.role = "status";
waiting.ariaLabel = text.loading;
const hint = element("span", "hint");
const orbit = iconButton(text.orbitButton, "orbit", () => scene?.setMode("orbit"));
// Flying is steered from the keyboard, which a touch screen does not have.
const fly = iconButton(text.flyButton, "fly", () => scene?.setMode("fly"));
const speedButton = element("button", "kago-button speed");
speedButton.type = "button";
speedButton.ariaLabel = text.speed;
speedButton.ariaHasPopup = "menu";
const frame = iconButton(text.frame, "frame", () => scene?.frame());
const reset = iconButton(text.reset, "reset", () => scene?.reset());
reset.classList.add("last");
document.body.append(element("main", "viewer", stage, waiting), element("footer", "kago-status-bar", hint, orbit, fly, speedButton, frame, reset));

let menu: HTMLElement | null = null;
function closeMenu() {
  menu?.remove();
  menu = null;
  speedButton.ariaExpanded = "false";
}

function openMenu() {
  const rect = speedButton.getBoundingClientRect();
  menu = element(
    "div",
    "kago-menu",
    ...SPEEDS.map((option) => {
      const item = element("button", "kago-menu-item", option === speed ? glyph("check") : element("span", "kago-glyph"), `${option}×`);
      item.type = "button";
      item.role = "menuitemradio";
      item.ariaChecked = String(option === speed);
      item.addEventListener("pointermove", () => item.focus());
      item.addEventListener("click", () => {
        speed = option;
        kago.storage.set(SPEED_KEY, String(option));
        scene?.setSpeed(option);
        closeMenu();
        render();
      });
      return item;
    })
  );
  menu.role = "menu";
  menu.ariaLabel = text.speed;
  // Hung above the button, its right edge on the button's, as Kago's menus are on a status bar.
  menu.style.bottom = `${innerHeight - rect.top + 4}px`;
  menu.style.right = `${innerWidth - rect.right}px`;
  document.body.append(menu);
  speedButton.ariaExpanded = "true";
}

speedButton.addEventListener("click", () => (menu ? closeMenu() : openMenu()));
addEventListener("pointerdown", (event) => {
  if (menu && !menu.contains(event.target as Node) && event.target !== speedButton) closeMenu();
});
addEventListener("keydown", (event) => {
  if (!menu || event.key !== "Escape") return;
  // The menu is what Escape closes here, not the window around it.
  event.preventDefault();
  closeMenu();
  speedButton.focus();
});

/** How the camera is moved, said once in the status bar instead of in a panel over the scene. */
function hintText() {
  if (!state.loaded) return text.progress.replace("{percent}", String(state.progress));
  if (state.touch) return state.mode === "orbit" ? text.touchOrbit : "";
  return state.mode === "orbit" ? text.orbit : state.mode === "fly" ? text.fly : "";
}

function render() {
  hint.textContent = hintText();
  waiting.hidden = state.loaded;
  for (const [button, mode] of [[orbit, "orbit"], [fly, "fly"]] as [HTMLButtonElement, SplatMode][]) {
    button.disabled = !state.loaded;
    button.ariaPressed = String(state.mode === mode);
  }
  fly.hidden = state.touch;
  frame.disabled = reset.disabled = !state.loaded;
  speedButton.hidden = state.mode !== "fly";
  speedButton.textContent = `${speed}×`;
  if (speedButton.hidden) closeMenu();
}

render();
let failed = false;
scene = await openScene(
  stage,
  kago,
  speed,
  (next) => {
    state = next;
    render();
  },
  (error) => {
    if (failed) return;
    failed = true;
    kago.fail(error === "not-splat" ? "unsupported" : "unreadable", error === "not-splat" ? text.notSplat : undefined);
  }
);
// Browsers allow only so many graphics contexts at once, so this one is given back as soon as the window goes.
addEventListener("pagehide", () => scene?.destroy());
