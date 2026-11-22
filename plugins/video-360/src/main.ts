import { connect } from "@kago/plugin-sdk";
import "@kago/plugin-sdk/kago.css";
import "./style.css";
import { controlsShown, createSlider, element, formatClock, IDLE_MS, playerButton, setGlyph, setLabel } from "./controls";
import { parseMovie, readMoov, type Movie, type Track } from "./mp4";
import { PanoramaPlayer } from "./panorama";
import { chooseBackend, lensMime, type BackendId, type Browser } from "./backends";
import { LensVideosPlayer } from "./lenses";
import { audioConfig, Player, videoConfig, type Playback, type StreamSource } from "./player";
import type { FileReader } from "./reads";
import { opticsFor, planRecording, type Recording } from "./source";
import { Stitcher, type View } from "./stitch";
import { stringsFor } from "./strings";

const MUTED_KEY = "muted";
const VOLUME_KEY = "volume";
const VOLUME_STEP = 0.1;
/** How long the hint to drag and zoom stays up once the picture is there. */
const HINT_MS = 4500;
const DEGREE = Math.PI / 180;
const HOME: View = { yaw: 0, pitch: 0, fov: 80 * DEGREE };
const MIN_FOV = 20 * DEGREE;
const MAX_FOV = 120 * DEGREE;
/** How far the arrow keys seek, in seconds. */
const STEP = 5;
/** How long a wait on Kago's server goes before the viewer says what it is waiting for. */
const SAY_WAIT = 4000;

const kago = await connect();
const text = stringsFor(kago.locale);
let muted = (await kago.storage.get(MUTED_KEY)) === "true";
const storedVolume = await kago.storage.get(VOLUME_KEY);
let volume = storedVolume !== null && Number.isFinite(Number(storedVolume)) && Number(storedVolume) >= 0 && Number(storedVolume) <= 1 ? Number(storedVolume) : 1;

const canvas = element("canvas", "stage");
const centre = element("div", "kago-player-centre");
const notice = element("span", "notice kago-player-glass kago-player-pill");
notice.hidden = true;
const playKey = playerButton(() => (player?.playing ? player.pause() : player?.play()), "kago-player-key");
const muteButton = playerButton(() => setSound(volume || 1, !silent()));
const resetButton = playerButton(() => setView(HOME));
setGlyph(resetButton, "reset");
setLabel(resetButton, text.reset);
const fullscreenButton = playerButton(() => toggleFullscreen());
const time = element("span", "kago-player-time");
const scrubber = createSlider(text.position, "", (seconds) => formatClock(seconds, (player?.duration ?? 0) >= 3600), {
  // Committed on release: every seek may have the decoders start over.
  onCommit: (seconds) => player?.seek(seconds)
});
const volumeSlider = createSlider(text.volume, "kago-player-volume", (level) => `${Math.round(level * 100)}%`, {
  onChange: (level) => setSound(level, false, false),
  onCommit: () => saveSound()
});
const row = element("div", "kago-player-row", playKey, muteButton, volumeSlider.element, time, element("div", "kago-player-spacer"), resetButton, fullscreenButton);
const bar = element("div", "kago-player-bar kago-player-glass", scrubber.element, row);
const viewer = element("main", "kago-player viewer", canvas, centre, notice, bar);
viewer.tabIndex = -1;
document.body.append(viewer);

let player: Playback | null = null;
let stitcher: Stitcher | null = null;
let view: View = { ...HOME };
let dirty = true;
let failed = false;
/** Whether Kago's server stitches the picture, which can keep the viewer waiting a while. */
let stitchedByServer = false;
const hint = matchMedia("(pointer: coarse)").matches ? text.touchHint : text.hint;
let waitingSince: number | null = null;

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

const silent = () => muted || volume === 0;

// A held arrow key or a dragged slider changes the sound many times a second; only where it comes to rest is kept.
let saveTimer: ReturnType<typeof setTimeout> | undefined;
function saveSound() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    kago.storage.set(MUTED_KEY, String(muted));
    kago.storage.set(VOLUME_KEY, String(volume));
  }, 300);
}

function setSound(nextVolume: number, nextMuted: boolean, save = true) {
  volume = Math.min(1, Math.max(0, nextVolume));
  muted = nextMuted;
  player?.setSound(volume, muted);
  if (save) saveSound();
  render();
}

// The controls fade out while the video plays and come back with the pointer.
let active = true;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function wake() {
  active = true;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => (active = false), IDLE_MS);
}
viewer.addEventListener("pointermove", wake);
viewer.addEventListener("pointerleave", () => (active = false));
viewer.addEventListener("focusin", wake);

function toggleFullscreen() {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void viewer.requestFullscreen().catch(() => undefined);
}

/** When the hint to drag and zoom goes: it is said once, as the picture first appears. */
let hintUntil: number | null = null;
let showing: string | null = null;
function say(kind: string, message: string | null) {
  if (showing === `${kind}:${message}`) return;
  showing = `${kind}:${message}`;
  centre.replaceChildren();
  if (kind === "badge") {
    const badge = element("span", "kago-player-badge kago-player-glass");
    setGlyph(badge, "play");
    centre.append(badge);
  } else if (message !== null) {
    // A wait that is over before it is noticed never flashes the words.
    centre.append(element("span", `kago-player-pill kago-player-glass${kind === "waiting" ? " late" : ""}`, message));
  }
}

function render() {
  const playing = player?.playing ?? false;
  const duration = player?.duration ?? 0;
  const now = player?.time() ?? 0;
  const long = duration >= 3600;
  const quiet = silent();
  setGlyph(playKey, playing ? "pause" : "play");
  setLabel(playKey, playing ? text.pause : text.play);
  setGlyph(muteButton, quiet ? "muted" : volume < 0.5 ? "quiet" : "loud");
  setLabel(muteButton, quiet ? text.unmute : text.mute);
  const fullscreen = document.fullscreenElement === viewer;
  setGlyph(fullscreenButton, fullscreen ? "minimize" : "maximize");
  setLabel(fullscreenButton, fullscreen ? text.exitFullscreen : text.fullscreen);
  time.textContent = `${formatClock(now, long)} / ${formatClock(duration, long)}`;
  scrubber.show(now, duration, player?.buffered() ?? 0);
  volumeSlider.show(quiet ? 0 : volume, 1);
  for (const control of [playKey, muteButton, resetButton]) control.disabled = !player;

  const waiting = !stitcher?.ready || Boolean(player?.waiting);
  waitingSince = waiting ? (waitingSince ?? performance.now()) : null;
  if (!waiting && player && hintUntil === null) hintUntil = performance.now() + HINT_MS;
  if (waiting) say("waiting", stitchedByServer && waitingSince !== null && performance.now() - waitingSince >= SAY_WAIT ? text.preparing : text.loading);
  else if (hintUntil !== null && performance.now() < hintUntil && playing && !failed) say("hint", hint);
  else say(playing || !player ? "none" : "badge", null);

  const shown = controlsShown({ playing, active, dragging: scrubber.dragging() || volumeSlider.dragging() });
  viewer.toggleAttribute("data-controls", shown);
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
// Sound may start with any click in the frame, the controls' included.
addEventListener("pointerdown", () => player?.resumeAudio(), { capture: true });
/** Where and when a press began: one that barely moves is a click, which plays or pauses as it does in Kago's own player. */
let press: { x: number; y: number; at: number; wasShown: boolean } | null = null;
canvas.addEventListener("pointerdown", (event) => {
  canvas.setPointerCapture(event.pointerId);
  press = pointers.size === 0 ? { x: event.clientX, y: event.clientY, at: performance.now(), wasShown: viewer.hasAttribute("data-controls") } : null;
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
    const click = type === "pointerup" && press && Math.hypot(event.clientX - press.x, event.clientY - press.y) < 4 && performance.now() - press.at < 500;
    // A tap first brings the controls back; there is no hover to do that on a touch screen.
    if (click && !(event.pointerType === "touch" && !press!.wasShown)) (player?.playing ? player.pause() : player?.play());
    press = null;
    pointers.delete(event.pointerId);
    pinch = spread();
  });
}
canvas.addEventListener("dblclick", toggleFullscreen);
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    setView({ ...view, fov: view.fov * Math.exp(event.deltaY * 0.0015) });
  },
  { passive: false }
);

addEventListener("keydown", (event) => {
  player?.resumeAudio();
  if (event.metaKey || event.ctrlKey || event.altKey || !player) return;
  // A focused button keeps the keys it answers to itself.
  if ((event.target as Element).closest("button") && [" ", "Enter"].includes(event.key)) return;
  const key = event.key.toLowerCase();
  if (key === " " || key === "k") player.playing ? player.pause() : player.play();
  else if (key === "m") setSound(volume || 1, !silent());
  else if (key === "f") toggleFullscreen();
  else if (key === "r") setView(HOME);
  else if (key === "arrowleft") player.seek(player.time() - STEP);
  else if (key === "arrowright") player.seek(player.time() + STEP);
  else if (key === "arrowup") setSound(volume + VOLUME_STEP, false);
  else if (key === "arrowdown") setSound(volume - VOLUME_STEP, false);
  else return;
  event.preventDefault();
  wake();
});

render();
requestAnimationFrame(frame);

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

const browser: Browser = {
  // WebCodecs exist only in a secure context, so Kago opened at a plain http:// address other than localhost has none.
  decodes: typeof VideoDecoder === "undefined" ? null : async (track) => (await VideoDecoder.isConfigSupported(videoConfig(track)).catch(() => ({ supported: false }))).supported === true,
  plays: typeof MediaSource === "undefined" ? null : (mime) => MediaSource.isTypeSupported(mime)
};
const backend = await chooseBackend(browser, sources.map((source) => source.track));
const lensCodec = sources[0]!.track.codec ?? sources[0]!.track.format;
if (backend === null) {
  fail("unsupported", isSecureContext ? text.unsupported.replace("{codec}", lensCodec) : text.insecure);
  throw new Error(`${lensCodec} is not supported`);
}
stitchedByServer = backend === "panorama";

/** The sound, from the file of the front lens if it has some, else from any other, if this browser plays it. */
async function findAudio(plays: (track: Track) => Promise<boolean>): Promise<StreamSource | null> {
  const order = [...new Set([...sources.map((source) => source.file), ...files.keys()])];
  for (const file of order) {
    const track: Track | undefined = movies[file]?.tracks.find((candidate) => candidate.kind === "audio" && candidate.codec);
    if (track && (await plays(track))) return { file, track };
  }
  return null;
}

const extension = kago.file.name.split(".").at(-1)?.toLowerCase() ?? "";
try {
  stitcher = new Stitcher(canvas, stitchedByServer ? { kind: "equirect" } : { kind: "fisheye", lenses: plan.lenses, optics: opticsFor(extension) });
} catch {
  fail("unsupported");
  throw new Error("WebGL 2 is not available");
}
if (plan.missingLens) {
  notice.textContent = text.oneLens;
  notice.hidden = false;
}

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

const present = (stream: number, picture: VideoFrame | HTMLVideoElement) => {
  stitcher?.upload(stream, picture);
  dirty = true;
};
const open: Record<BackendId, () => Promise<Playback>> = {
  decoders: async () => {
    // Safari decodes video with WebCodecs before it decodes sound with them; such a browser plays the video silent.
    const audio = typeof AudioDecoder === "undefined" ? null : await findAudio(async (track) => (await AudioDecoder.isConfigSupported(audioConfig(track)).catch(() => ({ supported: false }))).supported === true);
    return new Player(sources, audio, read, present, () => fail("unreadable"));
  },
  "lens-videos": async () => LensVideosPlayer.open(sources, await findAudio(async (track) => browser.plays!(lensMime(track))), read, viewer, present, () => fail("unreadable")),
  panorama: async () => {
    try {
      return await PanoramaPlayer.open(kago.panorama, viewer, (video) => present(0, video), (reason) => fail(reason, reason === "unsupported" ? text.unsupported.replace("{codec}", lensCodec) : undefined));
    } catch {
      fail("unsupported", text.noPanorama);
      throw new Error("Kago could not stitch the recording");
    }
  }
};
player = await open[backend]();
player.setSound(volume, muted);
// Read by the end-to-end check, which measures how well playback keeps up.
Object.assign(globalThis, { video360: player.stats });
player.seek(0);
player.play();

// Browsers allow only so many graphics contexts and hardware decoders at once, so these are given back as soon as the window goes.
addEventListener("pagehide", () => {
  player?.destroy();
  stitcher?.destroy();
});
