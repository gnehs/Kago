const DWELL_MS = 250;
const BUCKET_SECONDS = 6;

export type SeekPrewarmSend = (
  time: number | null,
  revision: number,
  signal: AbortSignal,
) => Promise<unknown>;

/** Debounce timeline hovers and cancel server-side prewarming when the pointer leaves. */
export function createSeekPrewarmer(send: SeekPrewarmSend) {
  let disposed = false;
  let dwellTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let hoveredBucket: number | null = null;
  let latestSeconds = 0;
  let revision = 0;
  let sentDuringHover = false;
  let targetController: AbortController | null = null;

  const clearDwell = () => {
    if (dwellTimer !== null) {
      globalThis.clearTimeout(dwellTimer);
      dwellTimer = null;
    }
  };

  const dispatch = (time: number | null, controller: AbortController): boolean => {
    const nextRevision = revision + 1;
    try {
      const result = send(time, nextRevision, controller.signal);
      revision = nextRevision;
      void Promise.resolve(result).catch(() => {});
      return true;
    } catch {
      return false;
    }
  };

  const schedule = (bucket: number) => {
    dwellTimer = globalThis.setTimeout(() => {
      dwellTimer = null;
      if (disposed || hoveredBucket !== bucket) return;

      const controller = new AbortController();
      targetController = controller;
      if (!dispatch(latestSeconds, controller)) {
        targetController = null;
        controller.abort();
        return;
      }
      sentDuringHover = true;
    }, DWELL_MS);
  };

  const leave = () => {
    clearDwell();
    hoveredBucket = null;
    latestSeconds = 0;
    targetController?.abort();
    targetController = null;
    const shouldCancel = sentDuringHover;
    sentDuringHover = false;

    if (shouldCancel) dispatch(null, new AbortController());
  };

  return {
    hover(seconds: number | null) {
      if (disposed) return;
      if (seconds === null) {
        leave();
        return;
      }
      if (!Number.isFinite(seconds) || seconds < 0) return;

      const bucket = Math.floor(seconds / BUCKET_SECONDS);
      latestSeconds = seconds;
      if (bucket === hoveredBucket) {
        if (dwellTimer !== null) {
          clearDwell();
          schedule(bucket);
        }
        return;
      }

      hoveredBucket = bucket;
      clearDwell();
      targetController?.abort();
      targetController = null;
      schedule(bucket);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      leave();
    },
  };
}
