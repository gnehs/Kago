import notoJp from "@expo-google-fonts/noto-sans-jp/400Regular/NotoSansJP_400Regular.ttf?url";
import notoKr from "@expo-google-fonts/noto-sans-kr/400Regular/NotoSansKR_400Regular.ttf?url";
import notoSc from "@expo-google-fonts/noto-sans-sc/400Regular/NotoSansSC_400Regular.ttf?url";
import notoTc from "@expo-google-fonts/noto-sans-tc/400Regular/NotoSansTC_400Regular.ttf?url";
import type { SubtitleTrack } from "@/types/kago";

/** The regional cuts of Noto Sans. libass draws with font files of its own, so one has to be handed to it. */
export type CjkFont = "tc" | "sc" | "jp" | "kr";

const CJK_FONTS: Record<CjkFont, { url: string; family: string; legacyEncoding: string }> = {
  tc: { url: notoTc, family: "Noto Sans TC", legacyEncoding: "big5" },
  sc: { url: notoSc, family: "Noto Sans SC", legacyEncoding: "gb18030" },
  jp: { url: notoJp, family: "Noto Sans JP", legacyEncoding: "shift_jis" },
  kr: { url: notoKr, family: "Noto Sans KR", legacyEncoding: "euc-kr" }
};

export const cjkFontUrl = (font: CjkFont) => new URL(CJK_FONTS[font].url, location.href).href;
export const cjkFontFamily = (font: CjkFont) => CJK_FONTS[font].family;

function cjkFontOfLanguage(tag: string): CjkFont | null {
  try {
    const locale = new Intl.Locale(tag).maximize();
    if (locale.language === "ja") return "jp";
    if (locale.language === "ko") return "kr";
    if (locale.language === "zh") return locale.script === "Hans" ? "sc" : "tc";
  } catch {
    // Not a language tag.
  }
  return null;
}

/** The font for a reader: the track's own language if it names one, otherwise the browser's languages in order. */
export function cjkFontForReader(trackLanguage: string): CjkFont {
  for (const tag of [trackLanguage, ...navigator.languages]) {
    const font = tag ? cjkFontOfLanguage(tag) : null;
    if (font) return font;
  }
  return "tc";
}

// A handful of everyday characters that exist in only one of the two scripts is enough to tell them apart.
const SIMPLIFIED_ONLY = /[们这说对时会过还个为来后发国学没样种问间关现开点经么让见长东车书电话]/g;
const TRADITIONAL_ONLY = /[們這說對時會過還個為來後發國學沒樣種問間關現開點經麼讓見長東車書電話]/g;

/**
 * The fonts a subtitle needs, most important first. What is written decides: a file with kana needs
 * the Japanese cut whatever its name says, and a bilingual one needs two. The reader's own font leads
 * when the text does not settle it.
 */
export function cjkFontsFor(text: string, trackLanguage: string): CjkFont[] {
  const reader = cjkFontForReader(trackLanguage);
  const simplified = text.match(SIMPLIFIED_ONLY)?.length ?? 0;
  const traditional = text.match(TRADITIONAL_ONLY)?.length ?? 0;
  const found: CjkFont[] = [];
  if (/[぀-ヿ]/.test(text)) found.push("jp");
  if (/[가-힯]/.test(text)) found.push("kr");
  if (simplified > traditional) found.push("sc");
  else if (traditional > 0) found.push("tc");
  return found.includes(reader) ? [reader, ...found.filter((font) => font !== reader)] : [...found, reader];
}

/**
 * Subtitle files are UTF-8 nowadays, but older ones come in the code page of wherever they were made.
 * Without a byte-order mark and with bytes that are not UTF-8, the reader's own region is the best guess.
 */
export function decodeSubtitle(buffer: ArrayBuffer, trackLanguage: string): string {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(buffer);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(buffer);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder(CJK_FONTS[cjkFontForReader(trackLanguage)].legacyEncoding).decode(buffer);
  }
}

const SRT_TIMING = /(\d+):(\d\d):(\d\d)[,.](\d{1,3})\s*-->\s*(\d+):(\d\d):(\d\d)[,.](\d{1,3})/;

const assTime = (hours: string, minutes: string, seconds: string, millis: string) => `${Number(hours)}:${minutes}:${seconds}.${millis.padEnd(3, "0").slice(0, 2)}`;

function srtTextToAss(text: string): string {
  return text
    .replace(/<(\/?)([biu])>/gi, (_match, close: string, tag: string) => `{\\${tag.toLowerCase()}${close ? 0 : 1}}`)
    .replace(/<font[^>]*?color=["']?#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})["']?[^>]*>/gi, (_match, red: string, green: string, blue: string) => `{\\c&H${blue}${green}${red}&}`)
    .replace(/<\/font>/gi, "{\\c}")
    .replace(/<[^>]+>/g, "")
    .trim()
    .replace(/\n/g, "\\N");
}

/**
 * Rewrites SubRip as ASS so that one renderer draws every subtitle. `aspect` shapes the script's
 * canvas like the video, with its short side at 1080, so text is the same size on a portrait clip.
 */
export function srtToAss(srt: string, aspect: number, fontFamily: string): string {
  const landscape = !(aspect > 0) || aspect >= 1;
  const width = landscape ? Math.round(1080 * (aspect > 0 ? aspect : 16 / 9)) : 1080;
  const height = landscape ? 1080 : Math.round(1080 / aspect);
  const events: string[] = [];
  for (const block of srt.replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => SRT_TIMING.test(line));
    if (at === -1) continue;
    const time = SRT_TIMING.exec(lines[at]!)!;
    const text = srtTextToAss(lines.slice(at + 1).join("\n"));
    if (text) events.push(`Dialogue: 0,${assTime(time[1]!, time[2]!, time[3]!, time[4]!)},${assTime(time[5]!, time[6]!, time[7]!, time[8]!)},Default,,0,0,0,,${text}`);
  }
  return [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${fontFamily},60,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,2,60,60,56,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...events,
    ""
  ].join("\n");
}

const languageNames = new Intl.DisplayNames(["zh-TW"], { type: "language", fallback: "none" });

export const languageLabel = (tag: string) => (tag ? (languageNames.of(tag) ?? tag) : "");

export function subtitleLabel(track: SubtitleTrack): string {
  const language = languageLabel(track.language);
  const flags = [track.sdh ? "聽障" : "", track.forced ? "強制" : ""].filter(Boolean).join("、");
  // Streams are often titled with nothing but their language.
  const label = [language, track.title === language ? "" : track.title].filter(Boolean).join(" · ") || "字幕";
  return flags ? `${label}（${flags}）` : label;
}

function sameLanguage(a: string, b: string): boolean {
  try {
    const left = new Intl.Locale(a).maximize();
    const right = new Intl.Locale(b).maximize();
    // Chinese is two written languages: Traditional subtitles do not serve a Simplified reader.
    return left.language === right.language && (left.language !== "zh" || left.script === right.script);
  } catch {
    return false;
  }
}

/**
 * The track to show when none was picked in this window. `remembered` is the last choice made by
 * hand: `off`, or a language. Otherwise a file marked default, then the reader's language, then
 * the stream the video itself marks default, then the first.
 */
export function pickSubtitle(tracks: SubtitleTrack[], remembered: string | null): SubtitleTrack | null {
  if (remembered === "off" || tracks.length === 0) return null;
  // Forced tracks only translate signs and foreign lines; they are no substitute for the full one.
  const full = tracks.some((track) => !track.forced) ? tracks.filter((track) => !track.forced) : tracks;
  const byLanguage = (tag: string) => full.find((track) => track.language && sameLanguage(track.language, tag));
  if (remembered) {
    const match = byLanguage(remembered);
    if (match) return match;
  }
  // A file put next to the video and marked default was chosen by whoever put it there.
  const marked = full.find((track) => track.default && !track.embedded);
  if (marked) return marked;
  for (const tag of navigator.languages) {
    const match = byLanguage(tag);
    if (match) return match;
  }
  return full.find((track) => track.default) ?? full[0]!;
}
