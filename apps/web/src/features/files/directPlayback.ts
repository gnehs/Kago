const BLIND_SECONDS = 1.5;

/** Source replacement can emit an abort or an empty error; neither means decoding failed. */
export function isMediaFailure(error: MediaError | null): boolean {
  return error !== null && [2, 3, 4].includes(error.code);
}

/** Watch actual playback, including failures for which the browser never emits an error. */
export function watchDirectPlayback(video: HTMLVideoElement, onFailure: () => void): () => void {
  const document = video.ownerDocument;
  const frames = () => {
    const quality = video.getVideoPlaybackQuality?.();
    // totalVideoFrames includes dropped frames, which do not prove a picture was displayed.
    return quality ? Math.max(0, quality.totalVideoFrames - quality.droppedVideoFrames) : undefined;
  };
  let stopped = false;
  let lastTime = video.currentTime;
  let lastFrames = frames();
  let blindSeconds = 0;

  const reset = () => {
    lastTime = video.currentTime;
    lastFrames = frames();
    blindSeconds = 0;
  };
  const fail = () => {
    if (stopped) return;
    stop();
    onFailure();
  };
  const check = () => {
    if (stopped) return;
    // Buffering alone is not a decoder failure. Only inspect active, visible playback.
    if (document.hidden || video.ended || video.paused || video.seeking) return reset();
    const count = frames();
    if (video.currentTime !== lastTime) {
      blindSeconds += Math.max(0, video.currentTime - lastTime);
      lastTime = video.currentTime;
    }
    if (count !== lastFrames) {
      lastFrames = count;
      blindSeconds = 0;
    }
    if (count === 0 && blindSeconds >= BLIND_SECONDS) fail();
  };
  const onMetadata = () => {
    if (video.videoWidth === 0 || video.videoHeight === 0) fail();
  };
  const onError = () => {
    if (isMediaFailure(video.error)) fail();
  };
  const resetEvents = ["play", "pause", "seeking", "seeked"] as const;
  const timer = globalThis.setInterval(check, 1000);
  function stop() {
    stopped = true;
    globalThis.clearInterval(timer);
    video.removeEventListener("error", onError);
    video.removeEventListener("loadedmetadata", onMetadata);
    video.removeEventListener("timeupdate", check);
    for (const event of resetEvents) video.removeEventListener(event, reset);
    document.removeEventListener("visibilitychange", reset);
  }
  video.addEventListener("error", onError);
  video.addEventListener("loadedmetadata", onMetadata);
  video.addEventListener("timeupdate", check);
  for (const event of resetEvents) video.addEventListener(event, reset);
  document.addEventListener("visibilitychange", reset);
  return stop;
}
