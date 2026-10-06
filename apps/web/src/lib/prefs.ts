export type ThemePref = "system" | "light" | "dark";
export type DensityPref = "comfortable" | "compact";

const themeKey = "kago.theme";
const densityKey = "kago.density";
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
export const getDensity = () => read<DensityPref>(densityKey, ["comfortable", "compact"], "comfortable");

export function applyPrefs() {
  const theme = getTheme();
  const resolved = theme === "system" ? (media?.matches ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.density = getDensity();
}

export function setTheme(theme: ThemePref) {
  localStorage.setItem(themeKey, theme);
  applyPrefs();
}

export function setDensity(density: DensityPref) {
  localStorage.setItem(densityKey, density);
  applyPrefs();
}

media?.addEventListener("change", applyPrefs);
