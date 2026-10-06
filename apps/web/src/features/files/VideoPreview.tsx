import { AudioLines, Captions, CaptionsOff, Check, Download } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, downloadUrl, previewUrl } from "@/api/client";
import { useMediaInfo, useSubtitles } from "@/api/hooks";
import { KagoIconButton } from "@/components/kago/icon-button";
import { KagoDropdownMenu, KagoMenuItem, KagoMenuSeparator } from "@/components/kago/menu";
import { KagoWindow } from "@/features/windows/KagoWindow";
import { triggerDownload } from "@/lib/paths";
import { getSubtitlePref, getVideoQuality, setSubtitlePref, setVideoQuality, type VideoQualityPref } from "@/lib/prefs";
import { languageLabel, pickSubtitle, subtitleLabel } from "@/lib/subtitles";
import { toast } from "@/stores/toast";
import { useWorkspaceStore, type PreviewWindow } from "@/stores/workspace";
import type { MediaInfo, SubtitleTrack } from "@/types/kago";
import { FileIcon } from "./FileIcon";
import { useSubtitleRenderer } from "./useSubtitleRenderer";
import { PLAYER_CONTROL_CLASS, VideoPlayer } from "./VideoPlayer";

const BITRATE_HINT: Record<number, string> = { 2160: "16 Mbps", 1440: "10 Mbps", 1080: "6 Mbps", 720: "3 Mbps", 480: "1.5 Mbps", 360: "0.8 Mbps" };
const ENCODER_LABEL: Record<string, string> = { nvenc: "NVIDIA GPU", vaapi: "Intel / AMD GPU", "vaapi-cqp": "Intel / AMD GPU", videotoolbox: "Apple GPU", software: "CPU" };
const MAX_RECOVERIES = 2;

/**
 * A video preview. The original file is played as-is when the browser can decode it; otherwise,
 * or when a lower quality is picked, the server transcodes it to HLS on the fly. The window takes
 * the picture's proportions and keeps them while it is resized. Subtitle files named after the
 * video are found and shown on their own.
 */
export function VideoPreviewWindow({ window }: { window: PreviewWindow }) {
  const { rootSlug, item } = window.preview;
  const info = useMediaInfo(rootSlug, item.path);
  const videoRef = useRef<HTMLVideoElement>(null);
  // Carries the playhead across a change of source.
  const resume = useRef({ time: 0, playing: false });
  const recoveries = useRef(0);
  const [picked, setPicked] = useState<VideoQualityPref | null>(null);
  const [audioIndex, setAudioIndex] = useState(0);
  const [directFailed, setDirectFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<"idle" | "preparing" | "error">("idle");
  const subtitleList = useSubtitles(rootSlug, item.path).data;
  const subtitles = subtitleList?.tracks ?? [];
  // A subtitle's id, or `off`; null until a choice is made in this window.
  const [subtitlePick, setSubtitlePick] = useState<string | null>(null);
  const subtitle = subtitlePick === "off" ? null : (subtitles.find((track) => track.id === subtitlePick) ?? (subtitlePick === null ? pickSubtitle(subtitles, getSubtitlePref()) : null));

  const media = info.data;
  const qualities = media?.transcode ? media.qualities : [];
  // Another audio track can only be had by transcoding: a browser plays the first one of a file.
  const audioTracks = media?.transcode ? media.audio : [];
  const canDirect = !media || qualities.length === 0 || canDirectPlay(media);
  const directOk = qualities.length === 0 || (canDirect && !directFailed && audioIndex === 0);
  const height = resolveHeight(qualities, picked, directOk);
  const ready = !info.isPending;
  const setAspect = (aspect: number) => useWorkspaceStore.getState().setPreviewAspect(window.id, aspect);
  // ffprobe knows the shape before the first frame arrives, which a transcode can keep waiting.
  const probedAspect = media?.video && media.video.height > 0 ? media.video.width / media.video.height : 0;

  useEffect(() => {
    if (probedAspect > 0) useWorkspaceStore.getState().setPreviewAspect(window.id, probedAspect);
  }, [window.id, probedAspect]);

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
      video.src = previewUrl(rootSlug, item.path);
      video.addEventListener("loadedmetadata", restore, { once: true });
    } else {
      setStatus("preparing");
      void (async () => {
        const session = await api<{ id: string; playlistUrl: string }>("/api/media/sessions", {
          method: "POST",
          body: JSON.stringify({ rootSlug, path: item.path, height, audioIndex })
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
      resume.current = { time: video.readyState > 0 ? video.currentTime : startAt, playing: video.readyState > 0 ? !video.paused && !video.ended : playing };
      teardown();
      video.removeAttribute("src");
      video.load();
      if (sessionId) closeSession(sessionId);
    };
  }, [ready, rootSlug, item.path, height, audioIndex, attempt]);

  useSubtitleRenderer(videoRef, subtitle, subtitleList?.fonts ?? [], window.aspect ?? probedAspect, () => {
    toast("無法載入這個字幕", "error");
    setSubtitlePick("off");
  });

  const pickTrack = (track: SubtitleTrack | null) => {
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
          label="字幕與音軌"
          side="top"
          className={`size-7! ${PLAYER_CONTROL_CLASS}`}
          container={slot.container}
          onOpenChange={slot.onOpenChange}
          menu={
            <>
              {subtitles.length > 0 ? (
                <>
                  <MenuHeading>字幕</MenuHeading>
                  <CheckItem checked={subtitle === null} onClick={() => pickTrack(null)}>關閉</CheckItem>
                  {subtitles.map((track) => (
                    <CheckItem key={track.id} checked={subtitle?.id === track.id} hint={track.embedded ? `內嵌 ${track.format.toUpperCase()}` : track.format.toUpperCase()} onClick={() => pickTrack(track)}>
                      {subtitleLabel(track)}
                    </CheckItem>
                  ))}
                </>
              ) : null}
              {subtitleList && subtitleList.unsupported > 0 ? <div className="px-2 py-1 text-xs text-muted">另有 {subtitleList.unsupported} 個圖形字幕無法顯示</div> : null}
              {audioTracks.length > 1 ? (
                <>
                  {subtitles.length > 0 ? <KagoMenuSeparator /> : null}
                  <MenuHeading>音軌</MenuHeading>
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
                      {[languageLabel(track.language), track.title].filter(Boolean).join(" · ") || `音軌 ${index + 1}`}
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
        label="畫質"
        side="top"
        className={`h-7! w-auto! px-2 text-xs font-medium tabular-nums ${PLAYER_CONTROL_CLASS}`}
        container={slot.container}
        onOpenChange={slot.onOpenChange}
        menu={
          <>
            {canDirect && !directFailed ? (
              <CheckItem checked={height === null} hint="不轉檔" onClick={() => pick("direct")}>原始檔案</CheckItem>
            ) : null}
            {qualities.map((quality) => (
              <CheckItem key={quality} checked={height === quality} hint={BITRATE_HINT[quality]} onClick={() => pick(quality)}>
                {quality}p
              </CheckItem>
            ))}
            <KagoMenuSeparator />
            <div className="px-2 py-1 text-xs text-muted">轉檔：{ENCODER_LABEL[media?.encoder ?? ""] ?? "CPU"}</div>
          </>
        }
      >
        {height === null ? "原始" : `${height}p`}
      </KagoDropdownMenu>
    ) : null;

  return (
    <KagoWindow
      window={window}
      icon={<FileIcon item={item} />}
      titleExtra={<KagoIconButton label="下載" className="size-6" onClick={() => triggerDownload(downloadUrl(rootSlug, item.path))}><Download /></KagoIconButton>}
    >
      <VideoPlayer
        videoRef={videoRef}
        fallbackDuration={media?.duration}
        notice={status === "preparing" ? "正在轉檔…" : status === "error" ? "無法播放這個影片" : null}
        renderSettings={renderSettings}
        onAspect={setAspect}
        onLoadedData={() => setStatus("idle")}
        onPlaying={() => {
          recoveries.current = 0;
        }}
        onError={() => {
          // Only the original file reports failures here; hls.js surfaces its own.
          if (height !== null || qualities.length === 0) return;
          toast("瀏覽器無法直接播放這個檔案，已改用轉檔");
          setDirectFailed(true);
        }}
      />
    </KagoWindow>
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

function closeSession(id: string) {
  void api(`/api/media/sessions/${encodeURIComponent(id)}`, { method: "DELETE", keepalive: true }).catch(() => {});
}

const VIDEO_CODECS: Record<string, string> = { h264: "avc1.640028", hevc: "hvc1.1.6.L120.90", vp8: "vp8", vp9: "vp09.00.40.08", av1: "av01.0.08M.08" };
const AUDIO_CODECS: Record<string, string> = { aac: "mp4a.40.2", mp3: "mp3", opus: "opus", vorbis: "vorbis", flac: "flac", ac3: "ac-3", eac3: "ec-3" };

/** Whether this browser can play the file untouched, judged by container and codecs. A wrong yes is caught by the video's error event. */
function canDirectPlay(info: MediaInfo): boolean {
  if (!info.video) return true;
  const videoCodec = VIDEO_CODECS[info.video.codec];
  const audioCodec = info.audio[0] ? AUDIO_CODECS[info.audio[0].codec] : "";
  if (!videoCodec || audioCodec === undefined) return false;
  if (info.video.codec === "h264" && info.video.bitDepth > 8) return false;

  const container = info.container.split(",");
  let mime: string;
  if (container.includes("mp4") || container.includes("mov")) {
    mime = "video/mp4";
  } else if (container.includes("matroska") || container.includes("webm")) {
    const webm = ["vp8", "vp9", "av1"].includes(info.video.codec) && (!info.audio[0] || ["opus", "vorbis"].includes(info.audio[0].codec));
    // Chromium also plays H.264/HEVC Matroska, though it will not say so for the container's own MIME type.
    if (!webm && !("chrome" in globalThis)) return false;
    mime = webm ? "video/webm" : "video/mp4";
  } else {
    return false;
  }
  const codecs = [videoCodec, audioCodec].filter(Boolean).join(", ");
  return document.createElement("video").canPlayType(`${mime}; codecs="${codecs}"`) !== "";
}
