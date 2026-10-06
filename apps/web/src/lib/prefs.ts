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

export function applyPrefs() {
  const theme = getTheme();
  const resolved = theme === "system" ? (media?.matches ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
}

export function setTheme(theme: ThemePref) {
  localStorage.setItem(themeKey, theme);
  applyPrefs();
}

media?.addEventListener("change", applyPrefs);
