import type { Kago, PanoramaInfo } from "@kago/plugin-sdk";
import { fragmentTime, parseMovie, readMoov, type Track } from "./mp4";
import { bufferedEnd, settle, Signal, type Playback } from "./player";
import { keepFrom, nextSegment, placement, seekInto, type Run } from "./segments";

/** Times a segment is asked for again before playback gives up. The server waits most of a minute on each. */
const RETRIES = 3;

export type PanoramaStats = { mode: "panorama"; decoded: number; presented: number; dropped: number; firstFrame: number | null; stalls: number; stalled: number };

/** What an init segment holds: the type a SourceBuffer is made for, out of its tracks' codecs, and its video track. */
async function readInit(init: Uint8Array) {
  const moov = await readMoov(async (start, end) => init.subarray(start, end), init.byteLength);
  const tracks = moov ? parseMovie(moov).tracks : [];
  const codecs = tracks.flatMap((track) => (track.codec ? [track.codec] : []));
  const video = tracks.find((track) => track.kind === "video");
  return codecs.length && video ? { mime: `video/mp4; codecs="${codecs.join(",")}"`, video } : null;
}

/**
 * Plays a panorama Kago's server stitches, through Media Source: one SourceBuffer, the segments around the playhead
 * appended as one run, those long past removed. The server encodes as it is asked, so a segment can take a while;
 * the video then waits for it, as any video does on a slow network.
 */
export class PanoramaPlayer implements Playback {
  readonly duration: number;
  readonly stats: PanoramaStats = { mode: "panorama", decoded: 0, presented: 0, dropped: 0, firstFrame: null, stalls: 0, stalled: 0 };
  playing = false;
  private readonly video = document.createElement("video");
  private readonly source = new MediaSource();
  private buffer: SourceBuffer | null = null;
  private run: Run = { start: 0, next: 0 };
  /** Where a seek to a new run is going, until its first segment is in. */
  private target: number | null = null;
  /** The timestampOffset the last segment was placed with; null for a new run, which drops what was buffered. */
  private offset: number | null = null;
  private videoTrack: Track | null = null;
  private generation = 0;
  /** SourceBuffer changes, one after another: a SourceBuffer takes one at a time. */
  private changes: Promise<unknown> = Promise.resolve();
  private readonly wake = new Signal();
  private readonly opened = performance.now();
  private stalledSince: number | null = null;
  private muted = false;
  private gestured = false;
  private destroyed = false;

  private constructor(
    private readonly panorama: Kago["panorama"],
    private readonly info: PanoramaInfo,
    container: HTMLElement,
    private readonly present: (video: HTMLVideoElement) => void,
    private readonly fail: (reason: "unsupported" | "unreadable") => void
  ) {
    this.duration = info.duration;
    this.video.className = "panorama-source";
    this.video.playsInline = true;
    // A page may play sound only after a click in it; until then the picture plays without.
    this.video.muted = true;
    container.append(this.video);
  }

  /** Has the server start on the panorama, and resolves once the page can take its segments. */
  static async open(panorama: Kago["panorama"], container: HTMLElement, present: (video: HTMLVideoElement) => void, fail: (reason: "unsupported" | "unreadable") => void) {
    const player = new PanoramaPlayer(panorama, await panorama.open(), container, present, fail);
    await player.attach();
    return player;
  }

  private async attach() {
    const { video, source } = this;
    const opened = settle(source, "sourceopen");
    video.src = URL.createObjectURL(source);
    await opened;
    URL.revokeObjectURL(video.src);
    source.duration = this.duration;
    video.addEventListener("timeupdate", () => this.wake.notify());
    video.addEventListener("waiting", () => {
      if (!this.playing || this.stalledSince !== null) return;
      this.stats.stalls++;
      this.stalledSince = performance.now();
    });
    video.addEventListener("playing", () => {
      if (this.stalledSince !== null) this.stats.stalled += performance.now() - this.stalledSince;
      this.stalledSince = null;
    });
    video.addEventListener("ended", () => (this.playing = false));
    video.addEventListener("error", () => this.fail("unreadable"));
    const frame = () => {
      if (this.destroyed) return;
      this.stats.presented++;
      this.stats.firstFrame ??= performance.now() - this.opened;
      this.present(video);
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
    this.jump(0, 0);
  }

  get waiting() {
    return this.target !== null || this.video.seeking || (this.playing && this.video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA);
  }

  buffered() {
    return bufferedEnd(this.video);
  }

  time() {
    return this.target ?? this.video.currentTime;
  }

  play() {
    if (this.time() >= this.duration - 0.25) this.seek(0);
    this.playing = true;
    // Refused only when a seek or a pause cuts it short, which is what was asked for.
    void this.video.play().catch(() => undefined);
  }

  pause() {
    this.playing = false;
    this.video.pause();
  }

  seek(time: number) {
    const target = Math.max(0, Math.min(time, this.duration - 0.1));
    const into = seekInto(this.run, target, this.info);
    if (into !== "run") return this.jump(into, target);
    if (this.target !== null) this.target = target;
    else this.video.currentTime = target;
    this.wake.notify();
  }

  setSound(volume: number, muted: boolean) {
    this.video.volume = volume;
    this.muted = muted;
    this.video.muted = muted || !this.gestured;
  }

  resumeAudio() {
    this.gestured = true;
    this.video.muted = this.muted;
  }

  tick() {
    const quality = this.video.getVideoPlaybackQuality();
    this.stats.decoded = quality.totalVideoFrames;
    this.stats.dropped = quality.droppedVideoFrames;
  }

  destroy() {
    this.destroyed = true;
    this.generation++;
    this.wake.notify();
    this.video.removeAttribute("src");
    this.video.load();
    this.video.remove();
  }

  /** Starts a new run at `segment`, dropping what is buffered once its first segment is in. */
  private jump(segment: number, target: number) {
    const generation = ++this.generation;
    this.target = target;
    this.run = { start: segment, next: segment };
    this.offset = null;
    // What is buffered elsewhere stops playing: the picture holds while the new run is encoded.
    this.video.currentTime = target;
    this.wake.notify();
    void this.pump(generation);
  }

  private async pump(generation: number) {
    const stale = () => generation !== this.generation || this.destroyed;
    let failures = 0;
    while (!stale()) {
      const index = nextSegment(this.run, this.time(), this.info);
      if (index === null) {
        if (this.run.next >= this.info.segmentCount) void this.change(async () => this.source.readyState === "open" && this.source.endOfStream());
        await this.wake.wait();
        continue;
      }
      let fetched: { media: Uint8Array; init: Uint8Array | null; offset: number };
      try {
        fetched = await this.fetch(index);
      } catch {
        if (stale()) return;
        if (++failures > RETRIES) return this.fail("unreadable");
        await new Promise((resolve) => setTimeout(resolve, failures * 1000));
        continue;
      }
      failures = 0;
      if (stale()) return;
      const { media, init, offset } = fetched;
      if (init && !this.buffer) {
        const found = await readInit(init);
        if (!found || !MediaSource.isTypeSupported(found.mime)) return this.fail("unsupported");
        this.buffer = this.source.addSourceBuffer(found.mime);
      }
      const fresh = this.offset === null;
      try {
        await this.change(async () => {
          if (stale()) return;
          if (fresh) {
            await this.remove(0, Infinity);
            if (this.source.readyState === "open") this.buffer!.abort();
          }
          if (init) await this.append(init);
          this.buffer!.timestampOffset = offset;
          await this.append(media);
        });
      } catch {
        if (!stale()) this.fail("unreadable");
        return;
      }
      if (stale()) return;
      this.offset = offset;
      this.run.next = index + 1;
      if (this.target !== null) {
        this.video.currentTime = this.target;
        this.target = null;
      }
      const keep = keepFrom(this.run, this.video.currentTime, this.info);
      if (keep > this.run.start) {
        this.run.start = keep;
        void this.change(() => this.remove(0, keep * this.info.segmentSeconds)).catch(() => undefined);
      }
    }
  }

  /**
   * A segment, where it goes, and the init segment of the encoder run it is from when that is a run the
   * SourceBuffer has not had yet. A run's init segment is whole once its first segment is.
   */
  private async fetch(index: number) {
    const media = await this.panorama.segment(index);
    let init = this.offset === null ? await this.panorama.segment("init") : null;
    if (!this.videoTrack) this.videoTrack = (await readInit(init!))?.video ?? null;
    const start = this.videoTrack ? fragmentTime(media, this.videoTrack) : null;
    const offset = placement(index, start ?? 0, this.offset, this.info);
    if (!init && offset !== this.offset) init = await this.panorama.segment("init");
    return { media, init, offset };
  }

  private change<T>(run: () => Promise<T>) {
    const next = this.changes.then(run);
    this.changes = next.catch(() => undefined);
    return next;
  }

  private async append(bytes: Uint8Array) {
    const buffer = this.buffer!;
    try {
      const done = settle(buffer, "updateend");
      buffer.appendBuffer(bytes as Uint8Array<ArrayBuffer>);
      await done;
    } catch (error) {
      // The browser keeps only so much; what is behind the playhead goes to make room, once.
      if (!(error instanceof DOMException && error.name === "QuotaExceededError") || this.video.currentTime < 2) throw error;
      await this.remove(0, this.video.currentTime - 1);
      const done = settle(buffer, "updateend");
      buffer.appendBuffer(bytes as Uint8Array<ArrayBuffer>);
      await done;
    }
  }

  private async remove(start: number, end: number) {
    const buffer = this.buffer;
    if (!buffer || buffer.buffered.length === 0) return;
    const done = settle(buffer, "updateend");
    buffer.remove(start, end);
    await done;
  }
}
