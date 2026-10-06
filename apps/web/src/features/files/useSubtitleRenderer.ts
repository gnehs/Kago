import { useEffect, type RefObject } from "react";
import { cjkFontFamily, cjkFontsFor, cjkFontUrl, decodeSubtitle, srtToAss } from "@/lib/subtitles";
import type { SubtitleTrack } from "@/types/kago";

/** Served as-is by the build; see `libassAssets` in vite.config.ts. */
const LIBASS = `${location.origin}/libass`;

/**
 * Draws a subtitle file over the video with libass, the renderer ASS was written for, so styled
 * and positioned subtitles look as their authors meant. SubRip is rewritten as ASS on the way in.
 * The renderer follows the element, not its source, so it survives a change of quality.
 */
export function useSubtitleRenderer(videoRef: RefObject<HTMLVideoElement | null>, track: SubtitleTrack | null, attachedFonts: string[], aspect: number, onError: () => void) {
  const url = track?.url ?? null;
  // Attached fonts belong to the video's own subtitles; a file beside it was not written with them in mind.
  const ownFonts = track?.embedded ? attachedFonts.join("\n") : "";
  const format = track?.format ?? "ass";
  const language = track?.language ?? "";
  // Only a converted SubRip file is laid out for the picture's shape.
  const shape = format === "srt" ? aspect : 0;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || url === null) return;
    let cancelled = false;
    let renderer: { dispose: () => void } | null = null;
    const fail = () => {
      if (!cancelled) onError();
    };

    void (async () => {
      const [response, { default: SubtitlesOctopus }] = await Promise.all([fetch(url), import("@jellyfin/libass-wasm")]);
      if (!response.ok) throw new Error(`Subtitle request failed: ${response.status}`);
      const text = decodeSubtitle(await response.arrayBuffer(), language);
      if (cancelled) return;
      // Sidecar subtitles name fonts they do not carry, and libass has no system fonts to turn to.
      const [main, ...others] = cjkFontsFor(text, language);
      renderer = new SubtitlesOctopus({
        video,
        subContent: format === "srt" ? srtToAss(text, shape, cjkFontFamily(main!)) : text,
        workerUrl: `${LIBASS}/subtitles-octopus-worker.js`,
        fallbackFont: cjkFontUrl(main!),
        fonts: [`${LIBASS}/default.woff2`, ...others.map(cjkFontUrl), ...(ownFonts ? ownFonts.split("\n").map((font) => new URL(font, location.href).href) : [])],
        onError: fail
      });
    })().catch(fail);

    return () => {
      cancelled = true;
      renderer?.dispose();
    };
    // `onError` only reports; a new callback identity must not rebuild the renderer.
  }, [videoRef, url, ownFonts, format, language, shape]);
}
