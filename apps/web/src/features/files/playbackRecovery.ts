export type PlaybackRecovery = {
  /** Never return to the original file after it has failed for this item. */
  forceTranscode: boolean;
  /** Use the server's H.264/AAC output after a decoder failure, including a failed HDR stream. */
  forceSdr: boolean;
  retries: number;
};

export const INITIAL_RECOVERY: PlaybackRecovery = { forceTranscode: false, forceSdr: false, retries: 0 };
const MAX_RETRIES = 2;

/** A different output gets one chance, then session restarts are bounded until the user makes a new choice. */
export function recoverPlayback(
  current: PlaybackRecovery,
  source: "direct" | "hdr" | "sdr",
  failure: "media" | "network",
  canTranscode: boolean
): PlaybackRecovery | null {
  if (!canTranscode) return null;
  if (source === "direct" || (source === "hdr" && failure === "media")) {
    // An old source's duplicate error must not start another session.
    if (current.forceTranscode && current.forceSdr) return null;
    return { ...current, forceTranscode: true, forceSdr: true };
  }
  if (current.retries >= MAX_RETRIES) return null;
  return { ...current, retries: current.retries + 1 };
}

export type PlaybackPosition = { time: number; playing: boolean };

/** Preserve intent and the last usable position even if an error resets or pauses the media element. */
export function trackPlaybackPosition(video: HTMLVideoElement, initial: PlaybackPosition) {
  let time = initial.time;
  let playing = initial.playing;
  let restoring = initial.time > 0;
  let pendingSeek: number | null = null;
  let failed: PlaybackPosition | null = null;

  const recordTime = () => {
    if (failed || video.readyState === 0 || !Number.isFinite(video.currentTime)) return;
    if (pendingSeek !== null) {
      // A seek to the current position (notably zero during load) may not emit seeked.
      if (video.seeking || Math.abs(video.currentTime - pendingSeek) > 0.25) return;
      pendingSeek = null;
    }
    // Loading another rendition starts the element at zero before the native seek or HLS startPosition takes effect.
    if ((restoring || video.error) && video.currentTime === 0) return;
    time = video.currentTime;
    restoring = false;
  };
  const onPlay = () => { if (!failed) playing = true; };
  const onPause = () => {
    if (!failed && !video.error && video.readyState > 0) playing = false;
  };
  const onPlaying = () => {
    // Once replacement is scheduled, late events from this source must not change the saved position.
    if (failed) return;
    playing = true;
    recordTime();
  };
  const onSeeked = () => {
    if (pendingSeek !== null) {
      if (video.readyState === 0 || Math.abs(video.currentTime - pendingSeek) > 0.25) return;
      pendingSeek = null;
    }
    restoring = false;
    recordTime();
  };
  const onEnded = () => { playing = false; };
  video.addEventListener("timeupdate", recordTime);
  video.addEventListener("seeked", onSeeked);
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.addEventListener("playing", onPlaying);
  video.addEventListener("ended", onEnded);

  const capture = (): PlaybackPosition => {
    recordTime();
    return failed ? { ...failed } : { time, playing: playing && !video.ended };
  };
  return {
    seek(seconds: number) {
      if (!Number.isFinite(seconds) || seconds < 0) return;
      time = seconds;
      pendingSeek = seconds;
      if (failed) failed.time = seconds;
    },
    request(shouldPlay: boolean) {
      playing = shouldPlay;
      if (failed) failed.playing = shouldPlay;
    },
    capture,
    fail() {
      failed ??= capture();
    },
    dispose(): PlaybackPosition {
      const position = capture();
      video.removeEventListener("timeupdate", recordTime);
      video.removeEventListener("seeked", onSeeked);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("ended", onEnded);
      return position;
    }
  };
}
