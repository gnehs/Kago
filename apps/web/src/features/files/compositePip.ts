const FRAME_MS = 1000 / 30;
const MAX_HEIGHT = 720;

/**
 * Picture-in-picture for a video with something drawn over it. The browser's own floats nothing but the video's
 * frames, so the picture and the overlay are painted together onto a canvas, and a second video playing that
 * canvas is the one sent floating. The sound stays with the real video, which carries on in the page.
 *
 * Resolves with a function that ends it once the floating window is up; rejects where the browser will not do this.
 */
export async function startCompositePip(video: HTMLVideoElement, overlay: () => HTMLCanvasElement | null, onEnd: () => void): Promise<() => void> {
  const scale = Math.min(1, MAX_HEIGHT / video.videoHeight);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(video.videoWidth * scale);
  canvas.height = Math.round(video.videoHeight * scale);
  const context = canvas.getContext("2d", { alpha: false });
  if (!context || canvas.width === 0 || canvas.height === 0) throw new Error("Nothing to draw");
  const draw = () => {
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const layer = overlay();
    if (layer && layer.width > 0 && layer.height > 0) context.drawImage(layer, 0, 0, canvas.width, canvas.height);
  };
  draw();

  const stream = canvas.captureStream(30);
  const proxy = document.createElement("video");
  proxy.muted = true;
  proxy.playsInline = true;
  proxy.srcObject = stream;
  // A floating window is mostly watched with the page hidden, where timers and animation frames all but stop. A worker's do not.
  const tickerUrl = URL.createObjectURL(new Blob([`setInterval(() => postMessage(0), ${FRAME_MS})`], { type: "text/javascript" }));
  const ticker = new Worker(tickerUrl);
  ticker.onmessage = draw;

  // The floating window's play button works the proxy; the real video follows, and leads when it is the page that pauses.
  const follow = () => (proxy.paused ? video.pause() : void video.play().catch(() => {}));
  const lead = () => (video.paused ? proxy.pause() : void proxy.play().catch(() => {}));
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    ticker.terminate();
    URL.revokeObjectURL(tickerUrl);
    proxy.removeEventListener("play", follow);
    proxy.removeEventListener("pause", follow);
    video.removeEventListener("play", lead);
    video.removeEventListener("pause", lead);
    if (document.pictureInPictureElement === proxy) void document.exitPictureInPicture().catch(() => {});
    for (const track of stream.getTracks()) track.stop();
    proxy.srcObject = null;
    onEnd();
  };

  try {
    await proxy.play();
    if (proxy.readyState === 0) await new Promise((resolve) => proxy.addEventListener("loadedmetadata", resolve, { once: true }));
    await proxy.requestPictureInPicture();
  } catch (error) {
    end();
    throw error;
  }
  if (video.paused) proxy.pause();
  proxy.addEventListener("leavepictureinpicture", end, { once: true });
  proxy.addEventListener("play", follow);
  proxy.addEventListener("pause", follow);
  video.addEventListener("play", lead);
  video.addEventListener("pause", lead);
  return end;
}
