import { AudioLines, Captions, CaptionsOff, Download, Info, ListVideo, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { api, downloadUrl, previewUrl, thumbnailUrl } from "@/api/client";
import { useFileList, useMediaInfo, useStoryboard, useSubtitles } from "@/api/hooks";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuCheckItem, KagoMenuHeading, KagoMenuNote, KagoMenuSeparator } from "@/components/kago/menu";
import { KagoWindow } from "@/components/kago/window";
import { isVideoType } from "@/lib/format";
import { baseName, parentPath, triggerDownload } from "@/lib/paths";
import { getSubtitlePref, getVideoHdr, getVideoHdrLift, getVideoPlaylistOpen, getVideoQuality, setSubtitlePref, setVideoHdr, setVideoHdrLift, setVideoPlaylistOpen, setVideoQuality, type VideoQualityPref } from "@/lib/prefs";
import { languageLabel, pickSubtitle, subtitleLabel } from "@/lib/subtitles";
import { toast } from "@/stores/toast";
import { useWorkspaceStore, type PreviewWindow } from "@/stores/workspace";
import type { FileItem, SubtitleTrack } from "@/types/kago";
import { FileIcon } from "@/components/kago/file-icon";
import { useSubtitleRenderer } from "./useSubtitleRenderer";
import { videoInfoGroups, type VideoInfoGroup } from "./videoInfo";
import { PLAYER_CONTROL_CLASS, VideoPlayer } from "./VideoPlayer";
import { t } from "@/lib/i18n";
import { watchDirectPlayback } from "./directPlayback";
import { INITIAL_RECOVERY, recoverPlayback, trackPlaybackPosition } from "./playbackRecovery";
import { canDirectPlay, canPlayHdrStream } from "./videoCapabilities";
import { createSeekPrewarmer } from "./seekPrewarm";
import { readyStoryboard, storyboardSheets, timelinePicture } from "./storyboard";
import { VideoPlaylist } from "./VideoPlaylist";

const BITRATE_HINT: Record<number, string> = { 2160: "16 Mbps", 1440: "10 Mbps", 1080: "6 Mbps", 720: "3 Mbps", 480: "1.5 Mbps", 360: "0.8 Mbps" };
const ENCODER_LABEL: Record<string, string> = { nvenc: "NVIDIA GPU", vaapi: "Intel / AMD GPU", "vaapi-cqp": "Intel / AMD GPU", videotoolbox: "Apple GPU", software: "CPU" };
const SUBTITLE_FORMAT_LABEL: Record<SubtitleTrack["format"], string> = { ass: "ASS", srt: "SRT", pgs: "PGS", vobsub: "VobSub", dvb: "DVB", picture: "" };
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
  const board = readyStoryboard(useStoryboard(rootSlug, path, Boolean(info.data?.video)).data);
  const sheets = useMemo(() => (board ? storyboardSheets(board, rootSlug, path) : []), [board, rootSlug, path]);
  // Fetched ahead of the pointer, so the first picture asked for is already there.
  useEffect(() => {
    for (const url of sheets) new Image().src = url;
  }, [sheets]);
  const folder = useFileList(rootSlug, parentPath(path), Boolean(onNavigate));
  const videos = useMemo(() => (folder.data?.items ?? []).filter((item) => item.kind === "file" && isVideoType(item.type)).sort((a, b) => collator.compare(a.name, b.name)), [folder.data]);
  const position = videos.findIndex((item) => item.path === path);
  const neighbour = (item: FileItem | undefined) => (item && onNavigate ? { label: item.name, go: () => onNavigate(item) } : null);
  const mediaKey = `${rootSlug}\0${path}`;
  const latestMedia = useRef(mediaKey);
  latestMedia.current = mediaKey;
  const videoRef = useRef<HTMLVideoElement>(null);
  const playbackError = useRef(() => {});
  const playbackRequest = useRef<(playing: boolean) => void>(() => {});
  const seekRequest = useRef<(seconds: number) => void>(() => {});
  const seekPreview = useRef<(seconds: number | null) => void>(() => {});
  // Carries the playhead across a change of source.
  const resume = useRef({ time: 0, playing: false });
  const [recovery, setRecovery] = useState(INITIAL_RECOVERY);
  const [picked, setPicked] = useState<VideoQualityPref | null>(null);
  const [audioIndex, setAudioIndex] = useState(0);
  const [status, setStatus] = useState<"idle" | "preparing" | "error">("idle");
  const [panel, setPanel] = useState<"playlist" | "info" | null>(() => getVideoPlaylistOpen() ? "playlist" : null);
  const playlistId = useId();
  const playlistButton = useRef<HTMLButtonElement>(null);
  const playlistOpen = panel === "playlist" && Boolean(onNavigate);
  const toggleInfo = () => setPanel((current) => current === "info" ? null : "info");
  const showPlaylist = (open: boolean) => {
    setVideoPlaylistOpen(open);
    setPanel(open ? "playlist" : null);
  };
  const closePlaylist = () => {
    showPlaylist(false);
    playlistButton.current?.focus({ preventScroll: true });
  };
  const subtitleList = useSubtitles(rootSlug, path).data;
  const subtitles = subtitleList?.tracks ?? [];
  // A subtitle's id, or `off`; null until a choice is made in this window.
  const [subtitlePick, setSubtitlePick] = useState<string | null>(null);
  // The player stays mounted from one video to the next, so fullscreen survives; what was chosen for the last one does not carry over.
  const [shownMedia, setShownMedia] = useState(mediaKey);
  if (shownMedia !== mediaKey) {
    setShownMedia(mediaKey);
    setPicked(null);
    setAudioIndex(0);
    setRecovery(INITIAL_RECOVERY);
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
  const canDirect = useMemo(() => !media || !media.transcode || media.qualities.length === 0 || canDirectPlay(media), [media]);
  const screenHdr = useHdrScreen();
  const [hdrWanted, setHdrWanted] = useState(getVideoHdr);
  // Turned off by hand, HDR is handled as on a screen that cannot show it.
  const hdrScreen = screenHdr && hdrWanted;
  const sourceHdr = media?.video?.hdr ?? null;
  // On a screen without HDR the server's tone mapping is used rather than whatever the browser makes of the file,
  // unless the original was asked for by hand in this window.
  const tonemapped = sourceHdr !== null && !hdrScreen && Boolean(media?.tonemap) && picked !== "direct";
  const directOk = qualities.length === 0 || (canDirect && !recovery.forceTranscode && audioIndex === 0 && burned === null && !tonemapped);
  const height = resolveHeight(qualities, picked, directOk);
  // Only a transcode has the choice; the original file is whatever it is, and the browser maps it to the screen.
  const hdr = !recovery.forceSdr && height !== null && sourceHdr !== null && Boolean(media?.hdrOutput) && hdrScreen && canPlayHdrStream();
  const [liftWanted, setLiftWanted] = useState(getVideoHdrLift);
  // A browser shows HDR10 a stop darker than players that follow Apple's convention; the server makes up the difference.
  const lift = hdr && sourceHdr === "pq" && liftWanted;
  const ready = !info.isPending;
  const reportAspect = useRef(onAspect);
  reportAspect.current = onAspect;
  // ffprobe knows the shape before the first frame arrives, which a transcode can keep waiting.
  const probedAspect = media?.video && media.video.height > 0 ? media.video.width / media.video.height : 0;
  // The original file is only watched for trouble where there is something to fall back on, and a picture to miss.
  const guarded = qualities.length > 0 && Boolean(media?.video);

  useEffect(() => {
    if (probedAspect > 0) reportAspect.current?.(probedAspect);
  }, [probedAspect]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !ready) return;
    let cancelled = false;
    let sessionId: string | null = null;
    let teardown = () => {};
    let sourceFailed = false;
    let prewarmer: ReturnType<typeof createSeekPrewarmer> | undefined;
    let previewAt: number | null = null;
    const active = () => !cancelled && latestMedia.current === mediaKey;
    seekPreview.current = (seconds) => {
      if (!active() || sourceFailed || video.ownerDocument.hidden) return;
      previewAt = seconds;
      prewarmer?.hover(seconds);
    };
    const cancelPreview = () => {
      if (video.ownerDocument.hidden) {
        previewAt = null;
        prewarmer?.hover(null);
      }
    };
    video.ownerDocument.addEventListener("visibilitychange", cancelPreview);
    const position = trackPlaybackPosition(video, resume.current);
    playbackRequest.current = position.request;
    let seekLoadingStream = (_seconds: number) => {};
    seekRequest.current = (seconds) => {
      position.seek(seconds);
      if (video.readyState === 0) seekLoadingStream(seconds);
    };
    const fail = (failure: "media" | "network") => {
      if (!active() || sourceFailed) return;
      sourceFailed = true;
      prewarmer?.dispose();
      position.fail();
      const source = height === null ? "direct" : hdr ? "hdr" : "sdr";
      const next = recoverPlayback(recovery, source, failure, guarded);
      if (!next) return setStatus("error");
      if (source === "direct") toast(t("The browser can’t play this file directly, so it is being transcoded"));
      setRecovery(next);
    };
    // Native media errors and hls.js fatal errors share the same bounded recovery path.
    playbackError.current = () => fail(video.error?.code === 2 ? "network" : "media");
    const play = () => {
      if (!active() || sourceFailed || !position.capture().playing) return;
      void video.play().catch((error: unknown) => {
        if (active() && error instanceof DOMException && error.name === "NotSupportedError") fail("media");
      });
    };
    const restore = () => {
      if (!active() || sourceFailed) return;
      const startAt = position.capture().time;
      if (startAt !== video.currentTime) video.currentTime = startAt;
      play();
    };

    if (height === null) {
      setStatus("idle");
      if (guarded) teardown = watchDirectPlayback(video, () => fail("media"));
      video.addEventListener("loadedmetadata", restore, { once: true });
      video.src = previewUrl(rootSlug, path);
    } else {
      setStatus("preparing");
      void (async () => {
        const session = await api<{ id: string; playlistUrl: string }>("/api/media/sessions", {
          method: "POST",
          body: JSON.stringify({ rootSlug, path, height, audioIndex, subtitleIndex: burned, subtitlePath: burnedFile, hdr, lift })
        });
        if (!active()) return closeSession(session.id);
        sessionId = session.id;
        prewarmer = createSeekPrewarmer((time, revision, signal) => api(`/api/media/sessions/${encodeURIComponent(session.id)}/prewarm`, {
          method: "POST",
          body: JSON.stringify({ time, revision }),
          signal,
          keepalive: time === null
        }));
        prewarmer.hover(previewAt);
        const { default: Hls } = await import("hls.js");
        if (!active()) return;
        if (!Hls.isSupported()) {
          // Safari without Media Source Extensions plays HLS itself.
          video.addEventListener("loadedmetadata", restore, { once: true });
          video.src = session.playlistUrl;
          return;
        }
        const hls = new Hls({
          // The user can seek while the session or manifest is being prepared.
          autoStartLoad: false,
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
        let manifestReady = false;
        seekLoadingStream = (seconds) => {
          if (manifestReady && active() && !sourceFailed) hls.startLoad(seconds);
        };
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) fail(data.type === Hls.ErrorTypes.NETWORK_ERROR ? "network" : "media");
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (!active() || sourceFailed) return;
          manifestReady = true;
          hls.startLoad(position.capture().time);
          play();
        });
        video.addEventListener("loadedmetadata", restore, { once: true });
        hls.loadSource(session.playlistUrl);
        hls.attachMedia(video);
      })().catch(() => {
        if (active()) setStatus("error");
      });
    }

    return () => {
      cancelled = true;
      playbackError.current = () => {};
      playbackRequest.current = () => {};
      seekRequest.current = () => {};
      seekPreview.current = () => {};
      prewarmer?.dispose();
      video.ownerDocument.removeEventListener("visibilitychange", cancelPreview);
      video.removeEventListener("loadedmetadata", restore);
      const stoppedAt = position.dispose();
      // Another rendition picks up where this one stopped; another video starts from the top, playing.
      resume.current = latestMedia.current !== mediaKey ? { time: 0, playing: true } : stoppedAt;
      teardown();
      video.removeAttribute("src");
      video.load();
      if (sessionId) closeSession(sessionId);
    };
  }, [ready, rootSlug, path, mediaKey, height, audioIndex, burned, burnedFile, hdr, lift, recovery, guarded]);

  useSubtitleRenderer(videoRef, textSubtitle, subtitleList?.fonts ?? [], aspect ?? probedAspect, () => {
    toast(t("Couldn’t load this subtitle"), "error");
    setSubtitlePick("off");
  });

  const resetRetries = () => setRecovery((current) => current.retries === 0 ? current : { ...current, retries: 0 });

  const pickTrack = (track: SubtitleTrack | null) => {
    resetRetries();
    // Remembered by language, so the next video opens with the same kind of track.
    setSubtitlePref(track ? track.language : "off");
    setSubtitlePick(track ? track.id : "off");
  };

  const pick = (quality: VideoQualityPref) => {
    resetRetries();
    setVideoQuality(quality);
    setPicked(quality);
    if (quality === "direct") setAudioIndex(0);
  };

  // The folder stands in for an album: it is what tells one episode 3 from another.
  const nowPlaying = useMemo(() => ({ title: baseName(path), album: baseName(parentPath(path)), artwork: thumbnailUrl(rootSlug, path) }), [rootSlug, path]);

  const output =
    height === null
      ? t("Original file")
      : t("Transcoded to {quality} by {encoder}", { quality: `${height}p${hdr ? " HDR" : ""}`, encoder: ENCODER_LABEL[media?.encoder ?? ""] ?? "CPU" });
  const infoGroups: VideoInfoGroup[] = media
    ? [...videoInfoGroups(media, subtitles.filter((track) => !track.embedded)), ...(qualities.length > 0 ? [{ title: t("Playback"), rows: [{ label: t("Output"), value: output }, ...(height !== null ? [{ label: t("Bitrate limit"), value: BITRATE_HINT[height] ?? "" }] : [])] }] : [])]
    : [];

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
            {canDirect && !recovery.forceTranscode ? (
              <KagoMenuCheckItem checked={height === null} hint={t("No transcoding")} onClick={() => pick("direct")}>{t("Original file")}</KagoMenuCheckItem>
            ) : null}
            {qualities.map((quality) => (
              <KagoMenuCheckItem key={quality} checked={height === quality} hint={BITRATE_HINT[quality]} onClick={() => pick(quality)}>
                {quality}p
              </KagoMenuCheckItem>
            ))}
            <KagoMenuSeparator />
            <KagoMenuNote>{t("Transcoding: {encoder}", { encoder: ENCODER_LABEL[media?.encoder ?? ""] ?? "CPU" })}</KagoMenuNote>
            {sourceHdr && screenHdr && media?.tonemap ? (
              <KagoMenuCheckItem
                checked={hdrWanted}
                onClick={() => {
                  resetRetries();
                  setVideoHdr(!hdrWanted);
                  setHdrWanted(!hdrWanted);
                }}
              >
                {t("HDR output")}
              </KagoMenuCheckItem>
            ) : null}
            {hdr && sourceHdr === "pq" ? (
              <KagoMenuCheckItem
                checked={liftWanted}
                onClick={() => {
                  resetRetries();
                  setVideoHdrLift(!liftWanted);
                  setLiftWanted(!liftWanted);
                }}
              >
                {t("Brighten HDR")}
              </KagoMenuCheckItem>
            ) : null}
            {sourceHdr ? <KagoMenuNote className="pt-0">{hdrNote(height === null, hdr, screenHdr, hdrWanted, Boolean(media?.tonemap))}</KagoMenuNote> : null}
          </>
        }
      >
        {height === null ? t("Original") : `${height}p`}
        {hdr || (height === null && sourceHdr && screenHdr) ? " HDR" : ""}
      </KagoDropdownMenu>
    ) : null;

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
                  <KagoMenuHeading>{t("Subtitles")}</KagoMenuHeading>
                  <KagoMenuCheckItem checked={subtitle === null} onClick={() => pickTrack(null)}>{t("Off")}</KagoMenuCheckItem>
                  {subtitles.map((track) => (
                    <KagoMenuCheckItem key={track.id} checked={subtitle?.id === track.id} hint={track.embedded ? t("Embedded {format}", { format: SUBTITLE_FORMAT_LABEL[track.format] || t("image subtitles") }) : SUBTITLE_FORMAT_LABEL[track.format]} onClick={() => pickTrack(track)}>
                      {subtitleLabel(track)}
                    </KagoMenuCheckItem>
                  ))}
                </>
              ) : null}
              {subtitleList && subtitleList.unsupported > 0 ? <KagoMenuNote>{t("{count} more subtitle can’t be shown | {count} more subtitles can’t be shown",{ count: subtitleList.unsupported })}</KagoMenuNote> : null}
              {audioTracks.length > 1 ? (
                <>
                  {subtitles.length > 0 ? <KagoMenuSeparator /> : null}
                  <KagoMenuHeading>{t("Audio tracks")}</KagoMenuHeading>
                  {audioTracks.map((track, index) => (
                    <KagoMenuCheckItem
                      key={index}
                      checked={(height === null ? 0 : audioIndex) === index}
                      hint={[track.codec.toUpperCase(), track.channels > 0 ? `${track.channels}ch` : ""].filter(Boolean).join(" ")}
                      onClick={() => {
                        resetRetries();
                        setAudioIndex(index);
                      }}
                    >
                      {[languageLabel(track.language), track.title].filter(Boolean).join(" · ") || t("Audio track {number}", { number: index + 1 })}
                    </KagoMenuCheckItem>
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
      {onNavigate ? (
        <KagoIconButton
          ref={playlistButton}
          label={t("Playlist")}
          className={`size-7 ${PLAYER_CONTROL_CLASS}`}
          active={playlistOpen}
          aria-expanded={playlistOpen}
          aria-controls={playlistOpen ? playlistId : undefined}
          onClick={() => showPlaylist(!playlistOpen)}
        >
          <ListVideo />
        </KagoIconButton>
      ) : null}
      {infoGroups.length > 0 ? (
        <KagoIconButton label={t("Video info (⌘I)")} className={`size-7 ${PLAYER_CONTROL_CLASS}`} active={panel === "info"} onClick={toggleInfo}>
          <Info />
        </KagoIconButton>
      ) : null}
    </>
  );

  return (
      <VideoPlayer
        videoRef={videoRef}
        mediaKey={mediaKey}
        nowPlaying={nowPlaying}
        previous={videos.length > 1 && position !== -1 ? neighbour(videos[position - 1]) : undefined}
        next={videos.length > 1 && position !== -1 ? neighbour(videos[position + 1]) : undefined}
        fallbackDuration={media?.duration}
        hdr={hdr || (height === null && sourceHdr !== null && screenHdr)}
        notice={status === "preparing" ? t("Transcoding…") : status === "error" ? t("Couldn’t play this video") : null}
        renderSettings={renderSettings}
        overlay={playlistOpen && onNavigate ? (
          <VideoPlaylist
            id={playlistId}
            videos={videos}
            currentPath={path}
            loading={!folder.isError && (folder.isPending || folder.data?.partial === true)}
            error={folder.isError}
            onSelect={(item) => { if (item.path !== path) onNavigate(item); }}
            returnFocus={() => videoRef.current?.parentElement?.focus({ preventScroll: true })}
            onClose={closePlaylist}
          />
        ) : panel === "info" && infoGroups.length > 0 ? <VideoInfoPanel groups={infoGroups} onClose={() => setPanel(null)} /> : null}
        onInfo={infoGroups.length > 0 ? toggleInfo : undefined}
        onAspect={onAspect}
        onLoadedData={() => setStatus((current) => current === "error" ? current : "idle")}
        onPlaybackRequest={(playing) => playbackRequest.current(playing)}
        onSeekRequest={(seconds) => seekRequest.current(seconds)}
        onSeekPreview={(seconds) => seekPreview.current(seconds)}
        seekPicture={board ? (seconds) => timelinePicture(board, sheets, seconds) : undefined}
        onError={() => playbackError.current()}
      />
  );
}

/** What is known about the video, on a sheet of glass over the picture so it follows the player into fullscreen. */
function VideoInfoPanel({ groups, onClose }: { groups: VideoInfoGroup[]; onClose: () => void }) {
  return (
    <aside className="kago-player-glass absolute top-2 right-2 flex max-h-[calc(100%-6rem)] w-72 max-w-[calc(100%-1rem)] flex-col rounded-lg text-xs" aria-label={t("Video info")}>
      <header className="flex shrink-0 items-center py-1 pr-1 pl-3">
        <strong className="flex-1 font-semibold">{t("Video info")}</strong>
        <KagoIconButton label={t("Close")} className={`size-6 ${PLAYER_CONTROL_CLASS}`} onClick={onClose}><X /></KagoIconButton>
      </header>
      <div className="min-h-0 flex-1 scroll-fade overflow-y-auto px-3 pb-3 select-text">
        {groups.map((group) => (
          <section key={group.title} className="mt-3 first:mt-0">
            <h3 className="m-0 mb-1 font-medium text-white/60">{group.title}</h3>
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
              {group.rows.map((row, index) => (
                <div key={index} className="contents">
                  <dt className="text-white/60 tabular-nums">{row.label}</dt>
                  <dd className="m-0 min-w-0 break-words">{row.value}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </aside>
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

function closeSession(id: string) {
  void api(`/api/media/sessions/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
}
