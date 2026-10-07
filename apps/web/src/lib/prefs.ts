export type ThemePref = "system" | "light" | "dark";

/**
 * The choices that follow the account from one browser to the next. Each browser keeps its own copy as well,
 * so the page is drawn right before the account has answered, and on the pages shown before signing in.
 */
export type SyncedPrefs = { theme: ThemePref; locale: LocalePref; motion: MotionPref; windowControls: WindowControlsPref };

const themeKey = "kago.theme";
const media = globalThis.matchMedia?.("(prefers-color-scheme: dark)");

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

export const getTheme = () => read<ThemePref>(themeKey, ["system", "light", "dark"], "system");

/** The languages the interface is written in. */
export type Locale = "en" | "zh-TW" | "zh-CN" | "ja";
/** `system` follows the browser's own list of languages. */
export type LocalePref = Locale | "system";

const localeKey = "kago.locale";

export const getLocalePref = () => read<LocalePref>(localeKey, ["system", "en", "zh-TW", "zh-CN", "ja"], "system");

/** Settles once the account has the choice too, so the page can be reloaded without losing it. */
export const storeLocalePref = (locale: LocalePref) => store("locale", locale);

/** Which end of a title bar the window controls sit at. */
export type WindowControlsPref = "left" | "right";

const windowControlsKey = "kago.windowControls";

export const getWindowControls = () => read<WindowControlsPref>(windowControlsKey, ["left", "right"], "left");

/** The video quality last picked by hand: play the original file, or cap transcoding at a height. */
export type VideoQualityPref = "direct" | number;

const videoQualityKey = "kago.videoQuality";

export function getVideoQuality(): VideoQualityPref | null {
  try {
    const value = localStorage.getItem(videoQualityKey);
    if (value === "direct") return value;
    const height = Number(value);
    return value && Number.isFinite(height) ? height : null;
  } catch {
    return null;
  }
}

export function setVideoQuality(quality: VideoQualityPref) {
  try {
    localStorage.setItem(videoQualityKey, String(quality));
  } catch {
    // Private browsing: the choice just lasts for this window.
  }
}

const videoHdrKey = "kago.videoHdr";

/** Whether an HDR video is shown as HDR on a screen that can. Browsers render HDR darker than some expect, so it can be turned off by hand. */
export function getVideoHdr(): boolean {
  try {
    return localStorage.getItem(videoHdrKey) !== "off";
  } catch {
    return true;
  }
}

export function setVideoHdr(on: boolean) {
  try {
    localStorage.setItem(videoHdrKey, on ? "on" : "off");
  } catch {
    // Storage may be unavailable; the choice then lasts for this window only.
  }
}

const videoHdrLiftKey = "kago.videoHdrLift";

/** Whether a transcoded HDR10 picture is brightened to where other players show it; a browser shows it a stop darker. */
export function getVideoHdrLift(): boolean {
  try {
    return localStorage.getItem(videoHdrLiftKey) !== "off";
  } catch {
    return true;
  }
}

export function setVideoHdrLift(on: boolean) {
  try {
    localStorage.setItem(videoHdrLiftKey, on ? "on" : "off");
  } catch {
    // Storage may be unavailable; the choice then lasts for this window only.
  }
}

const subtitleKey = "kago.subtitles";

/** The subtitle choice last made by hand: `off`, or the language tag of the track that was picked. */
export function getSubtitlePref(): string | null {
  try {
    return localStorage.getItem(subtitleKey);
  } catch {
    return null;
  }
}

export function setSubtitlePref(value: string) {
  try {
    localStorage.setItem(subtitleKey, value);
  } catch {
    // Private browsing: the choice just lasts for this window.
  }
}

const videoVolumeKey = "kago.videoVolume";

/** The player's volume, carried from one video to the next. */
export function getVideoVolume(): { volume: number; muted: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(videoVolumeKey) ?? "{}") as { volume?: unknown; muted?: unknown };
    const volume = typeof saved.volume === "number" && saved.volume >= 0 && saved.volume <= 1 ? saved.volume : 1;
    return { volume, muted: saved.muted === true };
  } catch {
    return { volume: 1, muted: false };
  }
}

export function setVideoVolume(volume: number, muted: boolean) {
  try {
    localStorage.setItem(videoVolumeKey, JSON.stringify({ volume, muted }));
  } catch {
    // Private browsing: the volume just lasts for this window.
  }
}

const imageInfoKey = "kago.imageInfo";

/** Whether picture windows open with their shooting data beside the picture. */
export function getImageInfoOpen() {
  try {
    return localStorage.getItem(imageInfoKey) === "open";
  } catch {
    return false;
  }
}

export function setImageInfoOpen(open: boolean) {
  try {
    localStorage.setItem(imageInfoKey, open ? "open" : "closed");
  } catch {
    // Private browsing: the choice just lasts for this window.
  }
}

/** Whether windows and dialogs are seen to come and go. Off, everything simply appears and disappears. */
export type MotionPref = "on" | "off";

const motionKey = "kago.motion";

export const getMotion = () => read<MotionPref>(motionKey, ["on", "off"], "on");

const synced: { [K in keyof SyncedPrefs]: { key: string; allowed: readonly SyncedPrefs[K][]; fallback: SyncedPrefs[K] } } = {
  theme: { key: themeKey, allowed: ["system", "light", "dark"], fallback: "system" },
  locale: { key: localeKey, allowed: ["system", "en", "zh-TW", "zh-CN", "ja"], fallback: "system" },
  motion: { key: motionKey, allowed: ["on", "off"], fallback: "on" },
  windowControls: { key: windowControlsKey, allowed: ["left", "right"], fallback: "left" }
};

let saveToAccount: (patch: Partial<SyncedPrefs>) => Promise<void> = async () => {};

/** Names what sends a choice on to the account. Until someone is signed in there is nowhere to send it. */
export function onPrefChange(save: typeof saveToAccount) {
  saveToAccount = save;
}

function store<K extends keyof SyncedPrefs>(name: K, value: SyncedPrefs[K]) {
  try {
    localStorage.setItem(synced[name].key, value);
  } catch {
    // Private browsing: the account still hears of it, and this window goes by what it loaded with.
  }
  return saveToAccount({ [name]: value });
}

/**
 * Takes the account's choices over this browser's. Returns what this browser has chosen that the account has yet
 * to hear of, which is how choices made before they were kept with the account find their way there.
 */
export function adoptPrefs(remote: Partial<Record<keyof SyncedPrefs, string>>): Partial<SyncedPrefs> {
  const unsent: Partial<Record<keyof SyncedPrefs, string>> = {};
  let localeChanged = false;
  for (const name of Object.keys(synced) as Array<keyof SyncedPrefs>) {
    const { key, fallback } = synced[name];
    const allowed: readonly string[] = synced[name].allowed;
    const value = remote[name];
    try {
      const local = localStorage.getItem(key);
      if (value === undefined || !allowed.includes(value)) {
        if (local !== null && allowed.includes(local)) unsent[name] = local;
      } else if (value !== (local !== null && allowed.includes(local) ? local : fallback)) {
        localStorage.setItem(key, value);
        if (name === "locale") localeChanged = true;
      }
    } catch {
      // Without storage this browser has nothing of its own to compare with or to keep.
    }
  }
  applyPrefs();
  // The language is settled as the page loads, so another one takes a fresh page.
  if (localeChanged) location.reload();
  return unsent as Partial<SyncedPrefs>;
}

export function applyPrefs() {
  const theme = getTheme();
  const resolved = theme === "system" ? (media?.matches ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.windowControls = getWindowControls();
  document.documentElement.dataset.motion = getMotion();
}

export function setMotion(motion: MotionPref) {
  void store("motion", motion);
  applyPrefs();
}

export function setWindowControls(side: WindowControlsPref) {
  void store("windowControls", side);
  applyPrefs();
}

export function setTheme(theme: ThemePref) {
  void store("theme", theme);
  applyPrefs();
}

media?.addEventListener("change", applyPrefs);
