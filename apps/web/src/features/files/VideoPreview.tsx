import { AudioLines, Captions, CaptionsOff, Check, Download } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, downloadUrl, previewUrl } from "@/api/client";
import { useFileList, useMediaInfo, useSubtitles } from "@/api/hooks";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { isVideoType } from "@/lib/format";
import { parentPath, triggerDownload } from "@/lib/paths";
import { getSubtitlePref, getVideoHdr, getVideoHdrLift, getVideoQuality, setSubtitlePref, setVideoHdr, setVideoHdrLift, setVideoQuality, type VideoQualityPref } from "@/lib/prefs";
import { languageLabel, pickSubtitle, subtitleLabel } from "@/lib/subtitles";
import { toast } from "@/stores/toast";
import { useWorkspaceStore, type PreviewWindow } from "@/stores/workspace";
import type { FileItem, MediaInfo, SubtitleTrack } from "@/types/kago";
import { FileIcon } from "./FileIcon";
import { useSubtitleRenderer } from "./useSubtitleRenderer";
import { PLAYER_CONTROL_CLASS, VideoPlayer } from "./VideoPlayer";
import { t } from "@/lib/i18n";

const BITRATE_HINT: Record<number, string> = { 2160: "16 Mbps", 1440: "10 Mbps", 1080: "6 Mbps", 720: "3 Mbps", 480: "1.5 Mbps", 360: "0.8 Mbps" };
const ENCODER_LABEL: Record<string, string> = { nvenc: "NVIDIA GPU", vaapi: "Intel / AMD GPU", "vaapi-cqp": "Intel / AMD GPU", videotoolbox: "Apple GPU", software: "CPU" };
const SUBTITLE_FORMAT_LABEL: Record<SubtitleTrack["format"], string> = { ass: "ASS", srt: "SRT", pgs: "PGS", vobsub: "VobSub", dvb: "DVB", picture: "" };
const MAX_RECOVERIES = 2;
// Numbered episodes sort as numbers, the way the file list shows them.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * A video preview. The original file is played as-is when the browser can decode it; otherwise,
 * or when a lower quality is picked, the server transcodes it to HLS on the fly. The window takes
 * the picture's proportions and keeps them while it is resized. Subtitle files named after the
 * video are found and shown on their own. An HDR picture stays HDR on a screen that shows it and
 * is tone-mapped to SDR on one that does not.
 */
export function VideoPreviewWindow({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  return (
    <KagoWindow
      window={window}
      icon={<FileIcon item={item} />}
      titleExtra={<KagoIconButton label={t("Download")} className="size-6" onClick={() => triggerDownload(downloadUrl(rootSlug, item.path))}><Download /></KagoIconButton>}
    >
      <VideoPreview
        rootSlug={rootSlug}
        path={item.path}
        aspect={window.aspect}
        onAspect={(aspect) => useWorkspaceStore.getState().setPreviewAspect(window.id, aspect)}
        onNavigate={(target) => useWorkspaceStore.getState().setPreviewItem(window.id, target)}
      />
    </KagoWindow>
  );
}

/** The player and everything that feeds it, for whatever frame it is put in: a window, or a tab of its own. */
export function VideoPreview({
  rootSlug,
  path,
  aspect,
  onAspect,
  onNavigate
}: {
  rootSlug: string;
  path: string;
  aspect?: number;
  onAspect?: (aspect: number) => void;
  /** Puts another video of the same folder in this frame. Without it there is no stepping between videos. */
  onNavigate?: (item: FileItem) => void;
}) {
  const info = useMediaInfo(rootSlug, path);
  const folder = useFileList(rootSlug, parentPath(path), Boolean(onNavigate)).data;
  const videos = useMemo(() => (folder?.items ?? []).filter((item) => item.kind === "file" && isVideoType(item.type)).sort((a, b) => collator.compare(a.name, b.name)), [folder]);
  const position = videos.findIndex((item) => item.path === path);
  const neighbour = (item: FileItem | undefined) => (item && onNavigate ? { label: item.name, go: () => onNavigate(item) } : null);
  const latestPath = useRef(path);
  latestPath.current = path;
  const videoRef = useRef<HTMLVideoElement>(null);
  // Carries the playhead across a change of source.
  const resume = useRef({ time: 0, playing: false });
  const recoveries = useRef(0);
  const [picked, setPicked] = useState<VideoQualityPref | null>(null);
  const [audioIndex, setAudioIndex] = useState(0);
  const [directFailed, setDirectFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"idle" | "preparing" | "error">("idle");
  const subtitleList = useSubtitles(rootSlug, path).data;
  const subtitles = subtitleList?.tracks ?? [];
  // A subtitle's id, or `off`; null until a choice is made in this window.
  const [subtitlePick, setSubtitlePick] = useState<string | null>(null);
  // The player stays mounted from one video to the next, so fullscreen survives; what was chosen for the last one does not carry over.
  const [shownPath, setShownPath] = useState(path);
  if (shownPath !== path) {
    setShownPath(path);
    setPicked(null);
    setAudioIndex(0);
    setDirectFailed(false);
    setAttempt(0);
    setStatus("idle");
    setSubtitlePick(null);
  }
  const subtitle = subtitlePick === "off" ? null : (subtitles.find((track) => track.id === subtitlePick) ?? (subtitlePick === null ? pickSubtitle(subtitles, getSubtitlePref()) : null));

  // A picture subtitle is not drawn here: the server lays it over the frames it transcodes.
  const burned = subtitle?.stream ?? null;
  const burnedFile = burned === null ? null : (subtitle?.file ?? null);
  const textSubtitle = burned === null ? subtitle : null;

  const media = info.data;
  const qualities = media?.transcode ? media.qualities : [];
  // Another audio track can only be had by transcoding: a browser plays the first one of a file.
  const audioTracks = media?.transcode ? media.audio : [];
  const canDirect = !media || qualities.length === 0 || canDirectPlay(media);
  const screenHdr = useHdrScreen();
  const [hdrWanted, setHdrWanted] = useState(getVideoHdr);
  // Turned off by hand, HDR is handled as on a screen that cannot show it.
  const hdrScreen = screenHdr && hdrWanted;
  const sourceHdr = media?.video?.hdr ?? null;
  // On a screen without HDR the server's tone mapping is used rather than whatever the browser makes of the file,
  // unless the original was asked for by hand in this window.
  const tonemapped = sourceHdr !== null && !hdrScreen && Boolean(media?.tonemap) && picked !== "direct";
  const directOk = qualities.length === 0 || (canDirect && !directFailed && audioIndex === 0 && burned === null && !tonemapped);
  const height = resolveHeight(qualities, picked, directOk);
  // Only a transcode has the choice; the original file is whatever it is, and the browser maps it to the screen.
  const hdr = height !== null && sourceHdr !== null && Boolean(media?.hdrOutput) && hdrScreen && canPlayHdrStream();
  const [liftWanted, setLiftWanted] = useState(getVideoHdrLift);
  // A browser shows HDR10 a stop darker than players that follow Apple's convention; the server makes up the difference.
  const lift = hdr && sourceHdr === "pq" && liftWanted;
  const ready = !info.isPending;
  const reportAspect = useRef(onAspect);
  reportAspect.current = onAspect;
  // ffprobe knows the shape before the first frame arrives, which a transcode can keep waiting.
  const probedAspect = media?.video && media.video.height > 0 ? media.video.width / media.video.height : 0;

  useEffect(() => {
    if (probedAspect > 0) reportAspect.current?.(probedAspect);
  }, [probedAspect]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready) return;
    let cancelled = false;
    let sessionId: string | null = null;
    let teardown = () => {};
    const { time: startAt, playing } = resume.current;
    const restore = () => {
      if (startAt > 0) video.currentTime = startAt;
      if (playing) void video.play().catch(() => {});
    };

    if (height === null) {
      setStatus("idle");
      video.src = previewUrl(rootSlug, path);
      video.addEventListener("loadedmetadata", restore, { once: true });
    } else {
      setStatus("preparing");
      void (async () => {
        const session = await api<{ id: string; playlistUrl: string }>("/api/media/sessions", {
          method: "POST",
          body: JSON.stringify({ rootSlug, path, height, audioIndex, subtitleIndex: burned, subtitlePath: burnedFile, hdr, lift })
        });
        if (cancelled) return closeSession(session.id);
        sessionId = session.id;
        const { default: Hls } = await import("hls.js");
        if (cancelled) return;
        if (!Hls.isSupported()) {
          // Safari without Media Source Extensions plays HLS itself.
          video.src = session.playlistUrl;
          video.addEventListener("loadedmetadata", restore, { once: true });
          return;
        }
        const hls = new Hls({
          startPosition: startAt > 0 ? startAt : -1,
          // A segment is only sent once ffmpeg has finished it, which on a slow NAS can outlast the default 10 s.
          fragLoadPolicy: {
            default: {
              maxTimeToFirstByteMs: 60_000,
              maxLoadTimeMs: 120_000,
              timeoutRetry: { maxNumRetry: 2, retryDelayMs: 0, maxRetryDelayMs: 0 },
              errorRetry: { maxNumRetry: 3, retryDelayMs: 1000, maxRetryDelayMs: 8000 }
            }
          }
        });
        teardown = () => hls.destroy();
        let mediaRecovered = false;
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR && !mediaRecovered) {
            mediaRecovered = true;
            hls.recoverMediaError();
          } else if (recoveries.current < MAX_RECOVERIES) {
            // Most often the session expired while paused; a fresh one picks up where this left off.
            recoveries.current += 1;
            setAttempt((value) => value + 1);
          } else {
            setStatus("error");
          }
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (playing) void video.play().catch(() => {});
        });
        hls.loadSource(session.playlistUrl);
        hls.attachMedia(video);
      })().catch(() => {
        if (!cancelled) setStatus("error");
      });
    }

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", restore);
      // Another rendition picks up where this one stopped; another video starts from the top, playing.
      if (latestPath.current !== path) resume.current = { time: 0, playing: true };
      else resume.current = { time: video.readyState > 0 ? video.currentTime : startAt, playing: video.readyState > 0 ? !video.paused && !video.ended : playing };
      teardown();
      video.removeAttribute("src");
      video.load();
      if (sessionId) closeSession(sessionId);
    };
  }, [ready, rootSlug, path, height, audioIndex, burned, burnedFile, hdr, lift, attempt]);

  useSubtitleRenderer(videoRef, textSubtitle, subtitleList?.fonts ?? [], aspect ?? probedAspect, () => {
    toast(t("Couldn’t load this subtitle"), "error");
    setSubtitlePick("off");
  });

  const pickTrack = (track: SubtitleTrack | null) => {
    recoveries.current = 0;
    // Remembered by language, so the next video opens with the same kind of track.
    setSubtitlePref(track ? track.language : "off");
    setSubtitlePick(track ? track.id : "off");
  };

  const pick = (quality: VideoQualityPref) => {
    recoveries.current = 0;
    setVideoQuality(quality);
    setPicked(quality);
    if (quality === "direct") setAudioIndex(0);
  };

  const renderSettings = (slot: { container: HTMLElement | null; onOpenChange: (open: boolean) => void }) => (
    <>
      {subtitles.length > 0 || audioTracks.length > 1 ? (
        <KagoDropdownMenu
          label={t("Subtitles and audio")}
          side="top"
          className={`size-7! ${PLAYER_CONTROL_CLASS}`}
          container={slot.container}
          onOpenChange={slot.onOpenChange}
          menu={
            <>
              {subtitles.length > 0 ? (
                <>
                  <MenuHeading>{t("Subtitles")}</MenuHeading>
                  <CheckItem checked={subtitle === null} onClick={() => pickTrack(null)}>{t("Off")}</CheckItem>
                  {subtitles.map((track) => (
                    <CheckItem key={track.id} checked={subtitle?.id === track.id} hint={track.embedded ? t("Embedded {format}", { format: SUBTITLE_FORMAT_LABEL[track.format] || t("image subtitles") }) : SUBTITLE_FORMAT_LABEL[track.format]} onClick={() => pickTrack(track)}>
                      {subtitleLabel(track)}
                    </CheckItem>
                  ))}
                </>
              ) : null}
              {subtitleList && subtitleList.unsupported > 0 ? <div className="px-2 py-1 text-xs text-muted">{t("{count} more subtitle can’t be shown | {count} more subtitles can’t be shown",{ count: subtitleList.unsupported })}</div> : null}
              {audioTracks.length > 1 ? (
                <>
                  {subtitles.length > 0 ? <KagoMenuSeparator /> : null}
                  <MenuHeading>{t("Audio tracks")}</MenuHeading>
                  {audioTracks.map((track, index) => (
                    <CheckItem
                      key={index}
                      checked={(height === null ? 0 : audioIndex) === index}
                      hint={[track.codec.toUpperCase(), track.channels > 0 ? `${track.channels}ch` : ""].filter(Boolean).join(" ")}
                      onClick={() => {
                        recoveries.current = 0;
                        setAudioIndex(index);
                      }}
                    >
                      {[languageLabel(track.language), track.title].filter(Boolean).join(" · ") || t("Audio track {number}", { number: index + 1 })}
                    </CheckItem>
                  ))}
                </>
              ) : null}
            </>
          }
        >
          {subtitle ? <Captions /> : subtitles.length > 0 ? <CaptionsOff /> : <AudioLines />}
        </KagoDropdownMenu>
      ) : null}
      {qualityMenu(slot)}
    </>
  );

  const qualityMenu = (slot: { container: HTMLElement | null; onOpenChange: (open: boolean) => void }) =>
    qualities.length > 0 ? (
      <KagoDropdownMenu
        label={t("Quality")}
        side="top"
        className={`h-7! w-auto! px-2 text-xs font-medium tabular-nums ${PLAYER_CONTROL_CLASS}`}
        container={slot.container}
        onOpenChange={slot.onOpenChange}
        menu={
          <>
            {canDirect && !directFailed ? (
              <CheckItem checked={height === null} hint={t("No transcoding")} onClick={() => pick("direct")}>{t("Original file")}</CheckItem>
            ) : null}
            {qualities.map((quality) => (
              <CheckItem key={quality} checked={height === quality} hint={BITRATE_HINT[quality]} onClick={() => pick(quality)}>
                {quality}p
              </CheckItem>
            ))}
            <KagoMenuSeparator />
            <div className="px-2 py-1 text-xs text-muted">{t("Transcoding: {encoder}", { encoder: ENCODER_LABEL[media?.encoder ?? ""] ?? "CPU" })}</div>
            {sourceHdr && screenHdr && media?.tonemap ? (
              <CheckItem
                checked={hdrWanted}
                onClick={() => {
                  recoveries.current = 0;
                  setVideoHdr(!hdrWanted);
                  setHdrWanted(!hdrWanted);
                }}
              >
                {t("HDR output")}
              </CheckItem>
            ) : null}
            {hdr && sourceHdr === "pq" ? (
              <CheckItem
                checked={liftWanted}
                onClick={() => {
                  recoveries.current = 0;
                  setVideoHdrLift(!liftWanted);
                  setLiftWanted(!liftWanted);
                }}
              >
                {t("Brighten HDR")}
              </CheckItem>
            ) : null}
            {sourceHdr ? <div className="px-2 pb-1 text-xs text-muted">{hdrNote(height === null, hdr, screenHdr, hdrWanted, Boolean(media?.tonemap))}</div> : null}
          </>
        }
      >
        {height === null ? t("Original") : `${height}p`}
        {hdr || (height === null && sourceHdr && screenHdr) ? " HDR" : ""}
      </KagoDropdownMenu>
    ) : null;

  return (
      <VideoPlayer
        videoRef={videoRef}
        mediaKey={path}
        previous={videos.length > 1 && position !== -1 ? neighbour(videos[position - 1]) : undefined}
        next={videos.length > 1 && position !== -1 ? neighbour(videos[position + 1]) : undefined}
        fallbackDuration={media?.duration}
        notice={status === "preparing" ? t("Transcoding…") : status === "error" ? t("Couldn’t play this video") : null}
        renderSettings={renderSettings}
        onAspect={onAspect}
        onLoadedData={() => setStatus("idle")}
        onPlaying={() => {
          recoveries.current = 0;
        }}
        onError={() => {
          // Only the original file reports failures here; hls.js surfaces its own.
          if (height !== null || qualities.length === 0) return;
          toast(t("The browser can’t play this file directly, so it is being transcoded"));
          setDirectFailed(true);
        }}
      />
  );
}

function MenuHeading({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1 pb-0.5 text-xs text-muted">{children}</div>;
}

function CheckItem({ checked, hint, onClick, children }: { checked: boolean; hint?: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <KagoMenuItem icon={checked ? <Check /> : <span className="size-4" />} onClick={onClick}>
      <span className="flex-1">{children}</span>
      {hint ? <span className="pl-4 text-xs opacity-60">{hint}</span> : null}
    </KagoMenuItem>
  );
}

/** `null` plays the original file; a number is the height to transcode to. */
function resolveHeight(qualities: number[], picked: VideoQualityPref | null, directOk: boolean): number | null {
  if (qualities.length === 0) return null;
  const fallback = qualities.find((quality) => quality <= 1080) ?? qualities[qualities.length - 1]!;
  if (typeof picked === "number") return qualities.find((quality) => quality <= picked) ?? qualities[qualities.length - 1]!;
  if (picked === "direct") return directOk ? null : fallback;
  // No choice made in this window: follow the remembered one, but never upscale or re-encode a file that already fits it.
  const remembered = getVideoQuality();
  if (typeof remembered === "number" && remembered < qualities[0]!) return qualities.find((quality) => quality <= remembered) ?? qualities[qualities.length - 1]!;
  return directOk ? null : fallback;
}

/** What becomes of an HDR picture on its way to this screen. */
function hdrNote(direct: boolean, hdr: boolean, hdrScreen: boolean, wanted: boolean, tonemap: boolean): string {
  if (direct) return hdrScreen ? t("HDR: playing the original file") : t("HDR: converted to SDR by the browser");
  if (hdr) return t("HDR: supported by this screen, playing in HDR");
  if (!tonemap) return t("HDR: the server can’t convert to SDR, so colors will look washed out");
  if (hdrScreen && !wanted) return t("HDR: turned off, converted to SDR");
  return hdrScreen ? t("HDR: can’t be streamed in HDR, converted to SDR") : t("HDR: not supported by this screen, converted to SDR");
}

const HDR_SCREEN = "(dynamic-range: high)";

/** Whether the screen the page is on shows HDR. It changes when the window is dragged to another display, or the display's HDR mode is switched. */
function useHdrScreen(): boolean {
  const [hdr, setHdr] = useState(() => globalThis.matchMedia?.(HDR_SCREEN).matches ?? false);
  useEffect(() => {
    const query = globalThis.matchMedia?.(HDR_SCREEN);
    if (!query) return;
    const onChange = () => setHdr(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return hdr;
}

const HEVC_MAIN10 = "hvc1.2.4.L153.B0";

/** Whether this browser takes the server's HDR stream: 10-bit HEVC in fragmented MP4, through hls.js where there is Media Source and natively where there is not. */
function canPlayHdrStream(): boolean {
  const type = `video/mp4; codecs="${HEVC_MAIN10}"`;
  const source = (globalThis as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource ?? globalThis.MediaSource;
  return source ? source.isTypeSupported(type) : document.createElement("video").canPlayType(type) !== "";
}

function closeSession(id: string) {
  void api(`/api/media/sessions/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
}

const VIDEO_CODECS: Record<string, string> = { h264: "avc1.640028", hevc: "hvc1.1.6.L120.90", vp8: "vp8", vp9: "vp09.00.40.08", av1: "av01.0.08M.08" };
const AUDIO_CODECS: Record<string, string> = { aac: "mp4a.40.2", mp3: "mp3", opus: "opus", vorbis: "vorbis", flac: "flac", ac3: "ac-3", eac3: "ec-3" };

/** Whether this browser can play the file untouched, judged by container and codecs. A wrong yes is caught by the video's error event. */
function canDirectPlay(info: MediaInfo): boolean {
  if (!info.video) return true;
  const videoCodec = info.video.codec === "hevc" && info.video.bitDepth > 8 ? HEVC_MAIN10 : VIDEO_CODECS[info.video.codec];
  const audioCodec = info.audio[0] ? AUDIO_CODECS[info.audio[0].codec] : "";
  if (!videoCodec || audioCodec === undefined) return false;
  if (info.video.codec === "h264" && info.video.bitDepth > 8) return false;

  const container = info.container.split(",");
  let mime: string;
  if (container.includes("mp4") || container.includes("mov")) {
    mime = "video/mp4";
  } else if (container.includes("matroska") || container.includes("webm")) {
    // WebM is the one kind of Matroska browsers play. Anything else in an .mkv is transcoded, even where a browser
    // would take the codecs: playback of it is unreliable, and its extra audio tracks and subtitles are out of reach.
    if (!["vp8", "vp9", "av1"].includes(info.video.codec) || (info.audio[0] && !["opus", "vorbis"].includes(info.audio[0].codec))) return false;
    mime = "video/webm";
  } else {
    return false;
  }
  const codecs = [videoCodec, audioCodec].filter(Boolean).join(", ");
  return document.createElement("video").canPlayType(`${mime}; codecs="${codecs}"`) !== "";
}
