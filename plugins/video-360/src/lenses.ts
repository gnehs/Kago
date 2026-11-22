import { MAX_READ_BYTES } from "@kago/plugin-sdk";
import { lensMime } from "./backends";
import { initSegment, mediaSegment, timing, type Timing } from "./fmp4";
import { AHEAD, BEHIND, correction, cutFragments, fragmentAt, nextBatch, type Fragment } from "./lanes";
import { bufferedEnd, MAX_GAP, READS_AT_ONCE, settle, Signal, type Playback, type StreamSource } from "./player";
import { sampleReader, type FileReader, type SampleFetch, type Span } from "./reads";

/** Batches of fragments being fetched at once, so the next is on its way while one is appended. */
const BATCHES_AT_ONCE = 2;
/** A seek still on its way after this long gives way to the next one asked for. */
const SEEK_PATIENCE = 1000;
/** Drifts kept for the end-to-end check to read. */
const DRIFTS_KEPT = 2000;

export type LensVideoStats = {
  mode: "lens-videos";
  presented: number;
  decoded: number;
  dropped: number;
  /** Milliseconds from opening until every lens video had shown a frame. */
  firstFrame: number | null;
  /** The latest drifts of the second lens video off the first, in seconds, one a frame. */
  drifts: number[];
  maxDrift: number;
  jumps: number;
  stalls: number;
  quotaEvictions: number;
};

/** A track played: a lens's video, or the sound, which plays in the first lens's video. */
type Lane = {
  source: StreamSource;
  /** The video, of those the player has, that plays it. */
  video: number;
  buffer: SourceBuffer;
  fragments: Fragment[];
  timing: Timing;
  /** The next fragment to fetch. */
  cursor: number;
  sequence: number;
  /** SourceBuffer changes, one after another: a SourceBuffer takes one at a time. */
  changes: Promise<unknown>;
};

/** Fragments fetched together: for each lane, the fragments picked and each one's samples' bytes. */
type Batch = { fragment: number; samples: Uint8Array[] }[][];

/**
 * Plays each lens's stream in a video of its own, through Media Source, and hands their frames over to be stitched.
 * The streams' samples are written out again as fragmented MP4 as they are read, so the browser's own decoder does
 * the work even where WebCodecs are not to be had. The first lens's video plays the sound and keeps the time; the
 * others follow it.
 */
export class LensVideosPlayer implements Playback {
  readonly stats: LensVideoStats = { mode: "lens-videos", presented: 0, decoded: 0, dropped: 0, firstFrame: null, drifts: [], maxDrift: 0, jumps: 0, stalls: 0, quotaEvictions: 0 };
  playing = false;
  waiting = false;
  private readonly videos: HTMLVideoElement[] = [];
  private readonly sources: MediaSource[] = [];
  private readonly lanes: Lane[] = [];
  private readonly fetch: SampleFetch;
  private readonly wake = new Signal();
  private readonly opened = performance.now();
  private readonly shown = new Set<number>();
  /** Where a seek that fetches afresh is going, until every video can show the picture there. */
  private target: number | null = null;
  private seekStarted = 0;
  private nextSeek: number | null = null;
  private generation = 0;
  private running = false;
  private muted = false;
  private gestured = false;
  private destroyed = false;

  private constructor(
    readonly duration: number,
    read: FileReader,
    private readonly present: (stream: number, video: HTMLVideoElement) => void,
    private readonly fail: () => void
  ) {
    this.fetch = sampleReader(read, MAX_READ_BYTES, MAX_GAP, READS_AT_ONCE);
  }

  /** Sets up a video for each stream, the sound in the first, and resolves once they have their init segments. */
  static async open(streams: StreamSource[], audio: StreamSource | null, read: FileReader, container: HTMLElement, present: (stream: number, video: HTMLVideoElement) => void, fail: () => void) {
    const player = new LensVideosPlayer(Math.min(...streams.map((stream) => stream.track.duration)), read, present, fail);
    await Promise.all(streams.map(() => player.addVideo(container)));
    const tracks = streams.map((source, video) => ({ source, video }));
    if (audio) tracks.push({ source: audio, video: 0 });
    // A MediaSource has every SourceBuffer it will have before anything is appended to any.
    for (const { source, video } of tracks) {
      const buffer = player.sources[video]!.addSourceBuffer(lensMime(source.track));
      player.lanes.push({ source, video, buffer, fragments: cutFragments(source.track.samples), timing: timing(source.track), cursor: 0, sequence: 0, changes: Promise.resolve() });
    }
    await Promise.all(player.lanes.map((lane) => player.change(lane, () => append(lane.buffer, initSegment(lane.source.track)))));
    return player;
  }

  private async addVideo(container: HTMLElement) {
    const index = this.videos.length;
    const video = document.createElement("video");
    video.className = "panorama-source";
    video.playsInline = true;
    // A page may play sound only after a click in it; until then the picture plays without.
    video.muted = true;
    container.append(video);
    const source = new MediaSource();
    this.videos.push(video);
    this.sources.push(source);
    const opened = settle(source, "sourceopen");
    video.src = URL.createObjectURL(source);
    await opened;
    URL.revokeObjectURL(video.src);
    source.duration = this.duration;
    video.addEventListener("timeupdate", () => this.wake.notify());
    video.addEventListener("error", () => this.fail());
    if (index === 0) video.addEventListener("ended", () => (this.playing = false));
    const frame = () => {
      if (this.destroyed) return;
      if (index === 0) this.stats.presented++;
      this.shown.add(index);
      if (this.stats.firstFrame === null && this.shown.size === this.videos.length) this.stats.firstFrame = performance.now() - this.opened;
      this.present(index, video);
      video.requestVideoFrameCallback(frame);
    };
    video.requestVideoFrameCallback(frame);
  }

  private get master() {
    return this.videos[0]!;
  }

  buffered() {
    return bufferedEnd(this.master);
  }

  time() {
    return this.target ?? this.master.currentTime;
  }

  play() {
    if (this.time() >= this.duration - 0.25) this.seek(0);
    this.playing = true;
    this.tick();
  }

  pause() {
    this.playing = false;
    this.tick();
  }

  setSound(volume: number, muted: boolean) {
    this.master.volume = volume;
    this.muted = muted;
    this.master.muted = muted || !this.gestured;
  }

  resumeAudio() {
    this.gestured = true;
    this.master.muted = this.muted;
  }

  seek(time: number) {
    const target = Math.max(0, Math.min(time, this.duration - 0.1));
    if (this.target === null && this.videos.every((video) => holds(video, target))) {
      for (const video of this.videos) video.currentTime = target;
      this.wake.notify();
      return;
    }
    // A seek still on its way is let finish, so scrubbing shows frames rather than restarting forever.
    if (this.target !== null && performance.now() - this.seekStarted < SEEK_PATIENCE) {
      this.nextSeek = target;
      return;
    }
    const generation = ++this.generation;
    this.target = target;
    this.seekStarted = performance.now();
    this.nextSeek = null;
    for (const lane of this.lanes) {
      lane.cursor = fragmentAt(lane.fragments, target);
      void this.change(lane, async () => {
        if (lane.buffer.updating) lane.buffer.abort();
        await remove(lane.buffer, 0, Infinity);
      }).catch(() => undefined);
    }
    for (const video of this.videos) video.currentTime = target;
    this.wake.notify();
    void this.pump(generation).catch(() => {
      if (generation === this.generation && !this.destroyed) this.fail();
    });
  }

  /** Called once per animation frame: the videos play as one, all waiting while any has nothing to show yet. */
  tick() {
    const { master } = this;
    const quality = master.getVideoPlaybackQuality();
    this.stats.decoded = quality.totalVideoFrames;
    this.stats.dropped = quality.droppedVideoFrames;
    if (this.target !== null && this.videos.every((video) => !video.seeking && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA)) {
      this.target = null;
      if (this.nextSeek !== null) this.seek(this.nextSeek);
    }
    const ready = this.target === null && this.videos.every((video) => video.ended || (!video.seeking && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA));
    const run = this.playing && ready;
    if (this.running && !run && this.playing && this.target === null) this.stats.stalls++;
    this.running = run;
    this.waiting = this.playing && !run;
    for (const video of this.videos) {
      // Refused only when a seek or a pause cuts it short, which is what was asked for.
      if (run && video.paused && !video.ended) void video.play().catch(() => undefined);
      if (!run && !video.paused) video.pause();
    }
    if (!run) return;
    for (const video of this.videos.slice(1)) {
      const drift = video.currentTime - master.currentTime;
      this.stats.drifts.push(drift);
      if (this.stats.drifts.length > DRIFTS_KEPT) this.stats.drifts.shift();
      this.stats.maxDrift = Math.max(this.stats.maxDrift, Math.abs(drift));
      const fix = correction(drift);
      if ("jump" in fix) {
        this.stats.jumps++;
        video.currentTime = master.currentTime;
      } else if (video.playbackRate !== fix.rate) {
        video.playbackRate = fix.rate;
      }
    }
  }

  destroy() {
    this.destroyed = true;
    this.generation++;
    this.wake.notify();
    for (const video of this.videos) {
      video.removeAttribute("src");
      video.load();
      video.remove();
    }
  }

  /** Fetches and appends fragments a little ahead of the playhead, and removes those well behind it. */
  private async pump(generation: number) {
    const stale = () => generation !== this.generation || this.destroyed;
    const batches: Promise<Batch>[] = [];
    while (!stale()) {
      for (let picks; batches.length < BATCHES_AT_ONCE && (picks = nextBatch(this.lanes, this.time() + AHEAD)); ) {
        picks.forEach((picked, index) => (this.lanes[index]!.cursor += picked.length));
        const batch = this.fetchBatch(picks);
        // A batch that fails is reported when its turn comes; one behind it is never waited on.
        batch.catch(() => undefined);
        batches.push(batch);
      }
      if (!batches.length) {
        if (this.lanes.every((lane) => lane.cursor >= lane.fragments.length)) await this.end(stale);
        await this.wake.wait();
        continue;
      }
      const batch = await batches.shift()!;
      if (stale()) return;
      await Promise.all(this.lanes.map((lane, index) => this.appendFragments(lane, batch[index]!, stale)));
    }
  }

  private async appendFragments(lane: Lane, fragments: Batch[number], stale: () => boolean) {
    for (const { fragment, samples } of fragments) {
      const { first, end } = lane.fragments[fragment]!;
      const segment = mediaSegment(lane.source.track, lane.timing, first, end, samples, ++lane.sequence);
      await this.change(lane, () => this.append(lane, segment, stale));
      if (stale()) return;
    }
    const behind = this.videos[lane.video]!.currentTime - BEHIND;
    const { buffered } = lane.buffer;
    if (behind > 0 && buffered.length && buffered.start(0) < behind - 1) await this.change(lane, () => remove(lane.buffer, 0, behind));
  }

  /** Every sample of the fragments picked, read in as few reads as they allow. */
  private async fetchBatch(picks: number[][]): Promise<Batch> {
    const spans: Span[] = [];
    const batch: Batch = picks.map((fragments, index) => {
      const lane = this.lanes[index]!;
      const { offsets, sizes } = lane.source.track.samples;
      return fragments.map((fragment) => {
        const { first, end } = lane.fragments[fragment]!;
        for (let sample = first; sample < end; sample++) spans.push({ file: lane.source.file, offset: offsets[sample]!, size: sizes[sample]! });
        return { fragment, samples: [] };
      });
    });
    const bytes = await this.fetch(spans);
    let at = 0;
    batch.forEach((fragments, index) => {
      for (const picked of fragments) {
        const { first, end } = this.lanes[index]!.fragments[picked.fragment]!;
        picked.samples = bytes.slice(at, at + end - first);
        at += end - first;
      }
    });
    return batch;
  }

  /** Appends a segment. The browser keeps only so much, so what is behind the playhead goes to make room. */
  private async append(lane: Lane, segment: Uint8Array, stale: () => boolean) {
    while (!stale()) {
      try {
        return await append(lane.buffer, segment);
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "QuotaExceededError")) throw error;
        this.stats.quotaEvictions++;
        const behind = this.videos[lane.video]!.currentTime - 0.5;
        const { buffered } = lane.buffer;
        if (behind > 0 && buffered.length && buffered.start(0) < behind) await remove(lane.buffer, 0, behind);
        // Nothing is behind to remove: the playhead has to move on first.
        else await this.wake.wait();
      }
    }
  }

  /** Tells each video its stream is whole, once every fragment is in, so it plays to the end. */
  private async end(stale: () => boolean) {
    await Promise.all(this.lanes.map((lane) => lane.changes));
    if (stale()) return;
    for (const source of this.sources) if (source.readyState === "open") source.endOfStream();
  }

  private change<T>(lane: Lane, run: () => Promise<T>) {
    const next = lane.changes.then(run);
    lane.changes = next.catch(() => undefined);
    return next;
  }
}

/** Whether a video has what it needs to play from `time` at once. */
function holds(video: HTMLVideoElement, time: number) {
  const { buffered } = video;
  for (let index = 0; index < buffered.length; index++) if (buffered.start(index) <= time && time < buffered.end(index) - 0.1) return true;
  return false;
}

async function append(buffer: SourceBuffer, bytes: Uint8Array) {
  const done = settle(buffer, "updateend");
  buffer.appendBuffer(bytes as Uint8Array<ArrayBuffer>);
  await done;
}

async function remove(buffer: SourceBuffer, start: number, end: number) {
  if (buffer.buffered.length === 0) return;
  const done = settle(buffer, "updateend");
  buffer.remove(start, end);
  await done;
}
