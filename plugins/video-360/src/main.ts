import { connect } from "@kago/plugin-sdk";
import "@kago/plugin-sdk/kago.css";
import "./style.css";
import { parseMovie, readMoov, type Movie, type Track } from "./mp4";
import { audioConfig, Player, videoConfig, type FileReader, type StreamSource } from "./player";
import { opticsFor, planRecording, type Recording } from "./source";
import { Stitcher, type View } from "./stitch";
import { stringsFor } from "./strings";

const MUTED_KEY = "muted";
const DEGREE = Math.PI / 180;
const HOME: View = { yaw: 0, pitch: 0, fov: 80 * DEGREE };
const MIN_FOV = 20 * DEGREE;
const MAX_FOV = 120 * DEGREE;
/** How far the arrow keys seek, in seconds. */
const STEP = 5;

// Lucide's glyphs, as Kago draws them elsewhere: Play, Pause, Volume2, VolumeX, RotateCcw and LoaderCircle.
const SPEAKER = "M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z";
const GLYPHS = {
  play: ["M6 3 20 12 6 21Z"],
  pause: ["M15 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "M7 4h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z"],
  sound: [SPEAKER, "M16 9a5 5 0 0 1 0 6", "M19.364 18.364a9 9 0 0 0 0-12.728"],
  muted: [SPEAKER, "M22 9 16 15", "M16 9 22 15"],
  reset: ["M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8", "M3 3v5h5"],
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

function iconButton(onClick: () => void) {
  const button = element("button", "kago-button");
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function setIcon(button: HTMLButtonElement, name: keyof typeof GLYPHS, label: string) {
  if (button.dataset.glyph !== name) {
    button.replaceChildren(glyph(name));
    button.dataset.glyph = name;
  }
  button.ariaLabel = label;
  button.dataset.tip = label;
}

function clock(seconds: number, total: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const minutes = Math.floor(whole / 60);
  return total >= 3600 ? `${Math.floor(minutes / 60)}:${pad(minutes % 60)}:${pad(whole % 60)}` : `${minutes}:${pad(whole % 60)}`;
}

const kago = await connect();
const text = stringsFor(kago.locale);
let muted = (await kago.storage.get(MUTED_KEY)) === "true";

const canvas = element("canvas", "stage");
const waiting = element("div", "waiting", glyph("spinner", "kago-glyph kago-spinner"));
waiting.role = "status";
waiting.ariaLabel = text.loading;
const playButton = iconButton(() => (player?.playing ? player.pause() : player?.play()));
const time = element("span", "time");
const scrubber = element("input", "scrubber");
scrubber.type = "range";
scrubber.min = "0";
scrubber.step = "any";
scrubber.ariaLabel = text.position;
const notice = element("span", "notice");
const muteButton = iconButton(() => setMuted(!muted));
const resetButton = iconButton(() => setView(HOME));
setIcon(resetButton, "reset", text.reset);
resetButton.classList.add("last");
document.body.append(element("main", "viewer", canvas, waiting), element("footer", "kago-status-bar", playButton, time, scrubber, notice, muteButton, resetButton));

let player: Player | null = null;
let stitcher: Stitcher | null = null;
let view: View = { ...HOME };
let dirty = true;
let failed = false;

function fail(reason: "unsupported" | "unreadable", message?: string) {
  if (failed) return;
  failed = true;
  kago.fail(reason, message);
}

// Whatever stops the start short says so, instead of leaving the spinner turning.
addEventListener("error", () => fail("unreadable"));
addEventListener("unhandledrejection", () => fail("unreadable"));

function setView(next: View) {
  view = { yaw: next.yaw, pitch: Math.max(-89 * DEGREE, Math.min(89 * DEGREE, next.pitch)), fov: Math.max(MIN_FOV, Math.min(MAX_FOV, next.fov)) };
  dirty = true;
}

function setMuted(next: boolean) {
  muted = next;
  kago.storage.set(MUTED_KEY, String(next));
  player?.setMuted(next);
  render();
}

let scrubbing = false;
function render() {
  const playing = player?.playing ?? false;
  setIcon(playButton, playing ? "pause" : "play", playing ? text.pause : text.play);
  setIcon(muteButton, muted ? "muted" : "sound", muted ? text.unmute : text.mute);
  const duration = player?.duration ?? 0;
  const now = player?.time() ?? 0;
  time.textContent = `${clock(now, duration)} / ${clock(duration, duration)}`;
  scrubber.max = String(duration);
  if (!scrubbing) scrubber.value = String(now);
  scrubber.style.setProperty("--progress", `${duration ? (Number(scrubber.value) / duration) * 100 : 0}%`);
  for (const control of [playButton, scrubber, muteButton, resetButton]) control.disabled = !player;
  waiting.hidden = Boolean(stitcher?.ready) && !player?.waiting;
}

function frame() {
  if (failed) return;
  player?.tick();
  if (stitcher && dirty) {
    stitcher.draw(view);
    dirty = false;
  }
  render();
  requestAnimationFrame(frame);
}

// Dragging turns the view as if the sphere were held: what is under the pointer stays under it.
const pointers = new Map<number, { x: number; y: number }>();
let pinch = 0;
const spread = () => {
  const [a, b] = [...pointers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
};
canvas.addEventListener("pointerdown", (event) => {
  player?.resumeAudio();
  canvas.setPointerCapture(event.pointerId);
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  pinch = spread();
});
canvas.addEventListener("pointermove", (event) => {
  const last = pointers.get(event.pointerId);
  if (!last) return;
  const next = { x: event.clientX, y: event.clientY };
  pointers.set(event.pointerId, next);
  if (pointers.size === 2) {
    const now = spread();
    if (pinch && now) setView({ ...view, fov: view.fov * (pinch / now) });
    pinch = now;
    return;
  }
  const perPixel = view.fov / canvas.clientHeight;
  setView({ ...view, yaw: view.yaw - (next.x - last.x) * perPixel, pitch: view.pitch + (next.y - last.y) * perPixel });
});
for (const type of ["pointerup", "pointercancel"] as const) {
  canvas.addEventListener(type, (event) => {
    pointers.delete(event.pointerId);
    pinch = spread();
  });
}
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    setView({ ...view, fov: view.fov * Math.exp(event.deltaY * 0.0015) });
  },
  { passive: false }
);

scrubber.addEventListener("pointerdown", () => (scrubbing = true));
scrubber.addEventListener("change", () => (scrubbing = false));
scrubber.addEventListener("input", () => player?.seek(Number(scrubber.value)));

addEventListener("keydown", (event) => {
  player?.resumeAudio();
  if (event.metaKey || event.ctrlKey || event.altKey || !player) return;
  if (event.target === scrubber && event.key.startsWith("Arrow")) return;
  if (event.key === " ") player.playing ? player.pause() : player.play();
  else if (event.key === "m" || event.key === "M") setMuted(!muted);
  else if (event.key === "r" || event.key === "R") setView(HOME);
  else if (event.key === "ArrowLeft") player.seek(player.time() - STEP);
  else if (event.key === "ArrowRight") player.seek(player.time() + STEP);
  else return;
  event.preventDefault();
});

render();
requestAnimationFrame(frame);

if (typeof VideoDecoder === "undefined") {
  // WebCodecs exist only in a secure context, so Kago opened at a plain http:// address other than localhost has none.
  fail("unsupported", isSecureContext ? text.unsupported.replace("{codec}", "WebCodecs") : text.insecure);
  throw new Error("WebCodecs is not available");
}

const files = [kago.file, ...kago.companions];
const read: FileReader = (file, start, end) => kago.read(start, end, file);
let movies: (Movie | null)[];
try {
  movies = await Promise.all(
    files.map(async (file, index) => {
      const moov = await readMoov((start, end) => read(index, start, end), file.size);
      return moov ? parseMovie(moov) : null;
    })
  );
} catch {
  fail("unreadable");
  throw new Error("the recording could not be read");
}

const recording: Recording = files.map((file, index) => ({
  name: file.name,
  videos: (movies[index]?.tracks ?? []).filter((track) => track.kind === "video" && track.codec).map((track) => ({ file: index, trackId: track.id, codec: track.codec, width: track.width, height: track.height }))
}));
const plan = planRecording(recording);
if (!plan) {
  fail("unsupported", text.notPanorama);
  throw new Error("no video to show");
}
const trackOf = (file: number, id: number) => movies[file]!.tracks.find((track) => track.id === id)!;
const sources: StreamSource[] = plan.streams.map(({ file, trackId }) => ({ file, track: trackOf(file, trackId) }));
for (const { track } of sources) {
  const support = await VideoDecoder.isConfigSupported(videoConfig(track)).catch(() => ({ supported: false }));
  if (!support.supported) {
    fail("unsupported", text.unsupported.replace("{codec}", track.codec ?? track.format));
    throw new Error(`${track.codec} is not supported`);
  }
}

/** The sound, from the file of the front lens if it has some, else from any other. */
async function findAudio(): Promise<StreamSource | null> {
  // Safari decodes video with WebCodecs before it decodes sound with them; such a browser plays the video silent.
  if (typeof AudioDecoder === "undefined") return null;
  const order = [...new Set([...sources.map((source) => source.file), ...files.keys()])];
  for (const file of order) {
    const track: Track | undefined = movies[file]?.tracks.find((candidate) => candidate.kind === "audio" && candidate.codec);
    if (track && (await AudioDecoder.isConfigSupported(audioConfig(track)).catch(() => ({ supported: false }))).supported) return { file, track };
  }
  return null;
}

const extension = kago.file.name.split(".").at(-1)?.toLowerCase() ?? "";
try {
  stitcher = new Stitcher(canvas, plan.lenses, opticsFor(extension));
} catch {
  fail("unsupported");
  throw new Error("WebGL 2 is not available");
}
notice.textContent = plan.missingLens ? text.oneLens : matchMedia("(pointer: coarse)").matches ? text.touchHint : text.hint;
notice.title = notice.textContent;

const cover = movies[0]?.cover;
if (cover) {
  // DJI's cameras keep the whole sphere, already stitched, as the recording's cover: it shows while the first frames decode.
  void createImageBitmap(new Blob([cover], { type: "image/jpeg" }))
    .then((picture) => {
      stitcher?.uploadPoster(picture);
      picture.close();
      dirty = true;
    })
    .catch(() => undefined);
}

player = new Player(
  sources,
  await findAudio(),
  read,
  (stream, decoded) => {
    stitcher?.upload(stream, decoded);
    dirty = true;
  },
  () => fail("unreadable")
);
player.setMuted(muted);
// Read by the end-to-end check, which measures how well playback keeps up.
Object.assign(globalThis, { video360: player.stats });
player.seek(0);
player.play();

// Browsers allow only so many graphics contexts and hardware decoders at once, so these are given back as soon as the window goes.
addEventListener("pagehide", () => {
  player?.destroy();
  stitcher?.destroy();
});
