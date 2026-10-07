export type ThemePref = "system" | "light" | "dark";

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

export function storeLocalePref(locale: LocalePref) {
  try {
    localStorage.setItem(localeKey, locale);
  } catch {
    // Private browsing: the browser's language stays in charge.
  }
}

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

export function applyPrefs() {
  const theme = getTheme();
  const resolved = theme === "system" ? (media?.matches ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.windowControls = getWindowControls();
}

export function setWindowControls(side: WindowControlsPref) {
  localStorage.setItem(windowControlsKey, side);
  applyPrefs();
}

export function setTheme(theme: ThemePref) {
  localStorage.setItem(themeKey, theme);
  applyPrefs();
}

media?.addEventListener("change", applyPrefs);
