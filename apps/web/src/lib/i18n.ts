import { ja } from "../locales/ja";
import { zhCN } from "../locales/zh-CN";
import { zhTW } from "../locales/zh-TW";
import { getLocalePref, storeLocalePref, type Locale, type LocalePref } from "./prefs";

/**
 * One language's wording, keyed by the English the code is written in. A message missing from a
 * dictionary is shown in English; `pnpm i18n` lists the ones each language still lacks.
 */
export type Dictionary = Record<string, string>;

/** Each language under its own name, the way a language picker lists them. */
export const localeNames: Record<Locale, string> = { en: "English", "zh-TW": "繁體中文", "zh-CN": "简体中文", ja: "日本語" };

// English is the source text and needs no dictionary.
const dictionaries: Record<Exclude<Locale, "en">, Dictionary> = { "zh-TW": zhTW, "zh-CN": zhCN, ja };

function supported(tag: string): Locale | null {
  try {
    const { language, script } = new Intl.Locale(tag).maximize();
    if (language === "zh") return script === "Hans" ? "zh-CN" : "zh-TW";
    return language === "en" || language === "ja" ? language : null;
  } catch {
    return null;
  }
}

function detect(): Locale {
  for (const tag of globalThis.navigator?.languages ?? []) {
    const match = supported(tag);
    if (match) return match;
  }
  return "en";
}

const pref = getLocalePref();

/**
 * The language of the interface. It is settled once, as the page loads, so that labels kept in
 * module constants and stores can be translated where they are written; changing it reloads.
 */
export const locale: Locale = pref === "system" ? detect() : pref;

const messages = locale === "en" ? null : dictionaries[locale];
const plural = new Intl.PluralRules(locale);

// Written with the script, which is what picks between the Chinese and Japanese forms of a character.
if (typeof document !== "undefined") document.documentElement.lang = locale === "zh-TW" ? "zh-Hant" : locale === "zh-CN" ? "zh-Hans" : locale;

/**
 * `message`, written in English, in the language of the interface, with each `{name}` filled in
 * from `params`. Text may give a singular and a plural as `one | other`, which `count` picks
 * between. Where one English wording needs two translations, a note after `##` tells them apart:
 * `t("Location##GPS")` reads "Location" in English.
 */
export function t(message: string, params?: Record<string, string | number>): string {
  let text = messages?.[message] ?? message.split("##")[0]!;
  if (text.includes(" | ")) {
    const [one, other] = text.split(" | ");
    text = typeof params?.count === "number" && plural.select(params.count) === "one" ? one! : other!;
  }
  return params ? text.replace(/\{(\w+)\}/g, (placeholder, name: string) => (name in params ? String(params[name]) : placeholder)) : text;
}

export function setLocale(next: LocalePref) {
  void storeLocalePref(next).finally(() => location.reload());
}
