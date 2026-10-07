import { nfc } from "./filename.js";

export type SubtitleFormat = "ass" | "srt";
/** Picture subtitles kept in files of their own: a Blu-ray stream, or a DVD one as an index beside its `.sub`. */
export type PictureSubtitleFormat = "pgs" | "vobsub";

/** What a sidecar subtitle's file name says about it. */
export type SubtitleName = {
  format: SubtitleFormat | PictureSubtitleFormat;
  /** A BCP 47 tag such as `en` or `zh-Hant`; empty when the name carries none. */
  language: string;
  /** Whatever is left of the name once the flags and the language are taken out. */
  title: string;
  default: boolean;
  forced: boolean;
  /** For the deaf and hard of hearing. */
  sdh: boolean;
};

const FORMATS: Record<string, SubtitleName["format"]> = { ass: "ass", ssa: "ass", srt: "srt", sup: "pgs", idx: "vobsub" };

export const isPictureFormat = (format: string): format is PictureSubtitleFormat => format === "pgs" || format === "vobsub";

/** Spellings that are not language tags themselves, as fansub releases and three-letter ISO codes write them. */
const LANGUAGE_ALIASES: Record<string, string> = {
  tc: "zh-Hant", cht: "zh-Hant", zht: "zh-Hant", big5: "zh-Hant", 繁體: "zh-Hant", 繁体: "zh-Hant", 繁中: "zh-Hant", 繁: "zh-Hant",
  sc: "zh-Hans", chs: "zh-Hans", zhs: "zh-Hans", gb: "zh-Hans", 简体: "zh-Hans", 簡體: "zh-Hans", 简中: "zh-Hans", 简: "zh-Hans",
  chi: "zh", zho: "zh", chinese: "zh", 中文: "zh",
  eng: "en", english: "en",
  jp: "ja", jpn: "ja", japanese: "ja", 日文: "ja", 日本語: "ja",
  kr: "ko", kor: "ko", korean: "ko",
  fre: "fr", fra: "fr", french: "fr",
  ger: "de", deu: "de", german: "de",
  spa: "es", spanish: "es",
  ita: "it", por: "pt", rus: "ru", tha: "th", vie: "vi", ind: "id"
};

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "none" });

/**
 * The tag for a language as a container's metadata gives it (`chi`, `eng`, `zh-TW`). Chinese is
 * usually tagged without its script, which the track's title then spells out.
 */
export function streamLanguage(code: string, title: string): string {
  const language = languageOf(code.trim().toLowerCase());
  if (language === "und") return "";
  if (language !== "zh") return language;
  if (/繁|traditional|cht|big5|\btc\b/i.test(title)) return "zh-Hant";
  if (/简|簡|simplified|chs|\bgb\b|\bsc\b/i.test(title)) return "zh-Hans";
  return language;
}

function languageOf(token: string): string {
  // Bilingual tracks are written `chs&jpn` or `tc+jp`; the first one is the reader's language.
  const first = token.split(/[&+]/)[0]!.replaceAll("_", "-");
  const alias = LANGUAGE_ALIASES[first];
  if (alias) return alias;
  if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(first)) return "";
  try {
    const tag = Intl.getCanonicalLocales(first)[0]!;
    // A well-formed tag is not yet a language: `.final.srt` must stay a title.
    return languageNames.of(tag) ? tag : "";
  } catch {
    return "";
  }
}

/**
 * Reads a subtitle's name against the video it sits next to, the way Jellyfin, Plex and Kodi do:
 * `Movie.srt`, `Movie.en.srt`, `Movie.zh-TW.forced.ass`, `Movie.Commentary.en.sdh.srt`, `Movie.en.sup`, `Movie.idx`.
 * Returns null when the file is not a subtitle of that video.
 */
export function parseSubtitleName(videoName: string, fileName: string): SubtitleName | null {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  const format = FORMATS[extension];
  if (!format || !fileName.includes(".")) return null;
  const stem = nfc(videoName.includes(".") ? videoName.slice(0, videoName.lastIndexOf(".")) : videoName).toLowerCase();
  const own = nfc(fileName.slice(0, fileName.lastIndexOf("."))).toLowerCase();
  if (own !== stem && !own.startsWith(`${stem}.`)) return null;

  const result: SubtitleName = { format, language: "", title: "", default: false, forced: false, sdh: false };
  const original = nfc(fileName.slice(0, fileName.lastIndexOf("."))).slice(stem.length + 1);
  const title: string[] = [];
  let hi = false;
  for (const part of original.split(".").filter(Boolean)) {
    const token = part.toLowerCase();
    if (token === "default") result.default = true;
    else if (token === "forced" || token === "foreign") result.forced = true;
    else if (token === "sdh" || token === "cc") result.sdh = true;
    // `hi` is "hearing impaired" next to a language and Hindi on its own.
    else if (token === "hi") hi = true;
    else if (!result.language && languageOf(token)) result.language = languageOf(token);
    else title.push(part);
  }
  if (hi && result.language) result.sdh = true;
  else if (hi) result.language = "hi";
  result.title = title.join(".");
  return result;
}
