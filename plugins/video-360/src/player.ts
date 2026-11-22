import { MAX_READ_BYTES } from "@kago/plugin-sdk";
import type { Track } from "./mp4";
import { sampleReader, type FileReader, type SampleFetch, type Span } from "./reads";

export type StreamSource = { file: number; track: Track };

/** How far past the playhead samples are fetched, in seconds of the recording. */
const READ_AHEAD = 2;
/** How much of the recording one batch of reads covers. */
const BATCH = 0.5;
/** Batches being fetched at once, so the next is on its way while one is decoded. */
const BATCHES_AT_ONCE = 3;
/** Reads asked of Kago at once: what it makes at a time for a frame. */
export const READS_AT_ONCE = 3;
/** Bytes between two samples that are read through rather than skipped with a second read. */
export const MAX_GAP = 512 * 1024;
/** Decoded frames held per stream. A hardware decoder has only so many, and stops when they are all held. */
const MAX_FRAMES = 6;
/** Frames a stream has decoded ahead before a stalled playhead moves again. */
const RESUME_FRAMES = 3;
/** How far ahead audio is handed to Web Audio. */
const AUDIO_AHEAD = 0.5;
/** A seek that has shown nothing after this long gives way to the next one asked for. */
const SEEK_PATIENCE = 1000;

type Pending = { index: number; data: Uint8Array };

type Stream = StreamSource & {
  config: VideoDecoderConfig;
  decoder: VideoDecoder;
  /** Samples fetched and not yet handed to the decoder. */
  pending: Pending[];
  /** Decoded and not yet shown, in the order they are shown. */
  frames: VideoFrame[];
  /** The next sample to fetch. */
  cursor: number;
  flushed: boolean;
  /** When the frame on screen is shown, in seconds. */
  shown: number;
};

type AudioPart = { time: number; buffer: AudioBuffer; source: AudioBufferSourceNode | null };

type Audio = StreamSource & { config: AudioDecoderConfig; decoder: AudioDecoder; cursor: number; parts: AudioPart[] };

export type PlayerStats = { decoded: number; presented: number; dropped: number };

/** What the viewer's controls drive: the lenses decoded here, or a panorama the server stitched. */
export interface Playback {
  readonly duration: number;
  /** How playback is keeping up, for the end-to-end check to read. */
  readonly stats: object;
  readonly playing: boolean;
  /** Playing, but waiting on what to show. */
  readonly waiting: boolean;
  time(): number;
  play(): void;
  pause(): void;
  seek(time: number): void;
  setMuted(muted: boolean): void;
  /** Lets sound play. It may only start inside a user's gesture in the frame. */
  resumeAudio(): void;
  /** Called once per animation frame. */
  tick(): void;
  destroy(): void;
}

/**
 * Where the playhead is. It runs off the audio hardware's clock once Web Audio may play, so sound and picture keep
 * together however long the recording, and off the page's own clock until then.
 */
class Clock {
  private base = 0;
  private anchor = 0;
  running = false;

  constructor(private source: () => number) {}

  time() {
    return this.running ? this.base + this.source() - this.anchor : this.base;
  }
  start() {
    if (this.running) return;
    this.anchor = this.source();
    this.running = true;
  }
  stop() {
    this.base = this.time();
    this.running = false;
  }
  set(time: number) {
    this.base = time;
    this.anchor = this.source();
  }
  setSource(source: () => number) {
    const time = this.time();
    this.source = source;
    this.set(time);
  }
}

export class Signal {
  private waiters: (() => void)[] = [];
  wait() {
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  notify() {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}

/** Resolves when `target` fires `success`, and rejects when it fires `error` first. */
export const settle = (target: EventTarget, success: string) =>
  new Promise<void>((resolve, reject) => {
    const done = (event: Event) => {
      target.removeEventListener(success, done);
      target.removeEventListener("error", done);
      if (event.type === success) resolve();
      else reject(new Error(`${success} failed`));
    };
    target.addEventListener(success, done);
    target.addEventListener("error", done);
  });

export const videoConfig = (track: Track): VideoDecoderConfig => ({
  codec: track.codec ?? "",
  codedWidth: track.width,
  codedHeight: track.height,
  ...(track.description ? { description: track.description } : {}),
  // The player pulls frames as their time comes, so a decoder that holds frames back only stalls it.
  optimizeForLatency: true
});

export const audioConfig = (track: Track): AudioDecoderConfig => ({
  codec: track.codec ?? "",
  sampleRate: track.sampleRate,
  numberOfChannels: track.channels,
  ...(track.description ? { description: track.description } : {})
});

/**
 * Plays the lenses' streams and the sound together: fetches their samples a little ahead of the playhead through
 * Kago, decodes each stream with WebCodecs, and hands over, as their time comes, frames of the same instant from every
 * stream at once. Each frame handed over is closed once `present` returns.
 */
export class Player implements Playback {
  readonly duration: number;
  readonly stats: PlayerStats = { decoded: 0, presented: 0, dropped: 0 };
  playing = false;
  /** Playing, but waiting on samples or a seek. */
  waiting = false;
  private readonly streams: Stream[];
  private readonly audio: Audio | null;
  private readonly context = new AudioContext();
  private readonly gain = this.context.createGain();
  private readonly clock = new Clock(() => performance.now() / 1000);
  private readonly wake = new Signal();
  private readonly frameDuration: number;
  private generation = 0;
  private fetchedUntil = 0;
  private discardBefore = 0;
  private seekTarget: number | null = null;
  private seekStarted = 0;
  private nextSeek: number | null = null;
  private readonly fetch: SampleFetch;
  private starved = false;
  private destroyed = false;

  constructor(
    sources: StreamSource[],
    audio: StreamSource | null,
    read: FileReader,
    private readonly present: (stream: number, frame: VideoFrame) => void,
    private readonly fail: (error: unknown) => void
  ) {
    this.fetch = sampleReader(read, MAX_READ_BYTES, MAX_GAP, READS_AT_ONCE);
    const first = sources[0]!.track;
    this.frameDuration = first.samples.durations[0] || 1 / 30;
    this.duration = Math.min(...sources.map((source) => source.track.duration));
    this.streams = sources.map((source, index) => {
      const config = videoConfig(source.track);
      const decoder = new VideoDecoder({ output: (frame) => this.receive(index, frame), error: (error) => this.fail(error) });
      decoder.configure(config);
      decoder.addEventListener("dequeue", () => this.feed());
      return { ...source, config, decoder, pending: [], frames: [], cursor: 0, flushed: false, shown: -Infinity };
    });
    this.audio = audio ? this.openAudio(audio) : null;
    this.gain.connect(this.context.destination);
    this.context.addEventListener("statechange", () => {
      if (this.context.state !== "running") return;
      // Web Audio is let play only after a click in the frame; from then on it keeps the time.
      this.stopAudio();
      this.clock.setSource(() => this.context.currentTime);
    });
  }

  private openAudio(source: StreamSource): Audio | null {
    const config = audioConfig(source.track);
    const audio: Audio = {
      ...source,
      config,
      cursor: 0,
      parts: [],
      decoder: new AudioDecoder({
        output: (data) => {
          const buffer = new AudioBuffer({ length: data.numberOfFrames, numberOfChannels: data.numberOfChannels, sampleRate: data.sampleRate });
          for (let channel = 0; channel < data.numberOfChannels; channel++) {
            const plane = new Float32Array(data.numberOfFrames);
            data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
            buffer.copyToChannel(plane, channel);
          }
          audio.parts.push({ time: data.timestamp / 1e6, buffer, source: null });
          data.close();
        },
        // Sound that cannot be decoded leaves the picture playing without it.
        error: () => undefined
      })
    };
    audio.decoder.configure(config);
    return audio;
  }

  /** Where the playhead is, in seconds; while seeking, where it is going. */
  time() {
    return this.seekTarget ?? this.clock.time();
  }

  play() {
    if (this.clock.time() >= this.duration - this.frameDuration) this.seek(0);
    this.playing = true;
    this.resumeAudio();
  }

  pause() {
    this.playing = false;
  }

  /** Lets Web Audio play. It may only start inside a user's gesture in the frame. */
  resumeAudio() {
    if (this.context.state === "suspended") void this.context.resume().catch(() => undefined);
  }

  setMuted(muted: boolean) {
    this.gain.gain.value = muted ? 0 : 1;
  }

  seek(time: number) {
    const target = Math.max(0, Math.min(time, this.duration - this.frameDuration));
    // A seek still on its way is let finish, so scrubbing shows frames rather than restarting forever.
    if (this.seekTarget !== null && performance.now() - this.seekStarted < SEEK_PATIENCE) {
      this.nextSeek = target;
      return;
    }
    const generation = ++this.generation;
    this.seekTarget = target;
    this.seekStarted = performance.now();
    this.nextSeek = null;
    this.discardBefore = target - this.frameDuration / 2;
    this.clock.stop();
    this.clock.set(target);
    for (const stream of this.streams) {
      stream.decoder.reset();
      stream.decoder.configure(stream.config);
      for (const frame of stream.frames) frame.close();
      stream.frames = [];
      stream.pending = [];
      stream.flushed = false;
      stream.cursor = syncBefore(stream.track, target);
      stream.shown = -Infinity;
    }
    if (this.audio) {
      this.stopAudio();
      this.audio.parts = [];
      this.audio.decoder.reset();
      this.audio.decoder.configure(this.audio.config);
      const { times, durations, count } = this.audio.track.samples;
      let cursor = 0;
      while (cursor < count && times[cursor]! + durations[cursor]! <= target) cursor++;
      this.audio.cursor = cursor;
    }
    this.fetchedUntil = Math.min(...this.streams.map((stream) => stream.track.samples.times[stream.cursor] ?? target));
    this.wake.notify();
    void this.pump(generation).catch((error) => {
      if (generation === this.generation && !this.destroyed) this.fail(error);
    });
  }

  /**
   * Moves the playhead on and hands over the frames whose time has come. Called once per animation frame. Frames
   * whose time passed before they could be shown are closed unseen.
   */
  tick() {
    let now = this.clock.time();
    if (this.clock.running && now >= this.duration) {
      this.playing = false;
      this.clock.stop();
      this.clock.set(this.duration);
      now = this.duration;
    }
    const due = (now + this.frameDuration / 2) * 1e6;
    const picks = this.streams.map((stream) => {
      let pick: VideoFrame | null = null;
      while (stream.frames[0] && stream.frames[0].timestamp <= due) {
        if (pick) {
          pick.close();
          this.stats.dropped++;
        }
        pick = stream.frames.shift()!;
      }
      return pick;
    });
    const latest = Math.max(...picks.map((pick) => pick?.timestamp ?? -Infinity));
    // Every stream shows the same instant: one ahead of the others waits for them.
    if (picks.every((pick) => pick && latest - pick.timestamp < (this.frameDuration / 2) * 1e6)) {
      picks.forEach((pick, index) => {
        this.present(index, pick!);
        pick!.close();
        this.streams[index]!.shown = pick!.timestamp / 1e6;
      });
      this.stats.presented++;
      this.wake.notify();
      this.feed();
      if (this.seekTarget !== null) {
        this.seekTarget = null;
        if (this.nextSeek !== null) this.seek(this.nextSeek);
      }
    } else {
      picks.forEach((pick, index) => pick && this.streams[index]!.frames.unshift(pick));
    }

    const done = (stream: Stream) => stream.cursor >= stream.track.samples.count && stream.pending.length === 0;
    if (this.clock.running && this.streams.some((stream) => stream.frames.length === 0 && !done(stream) && now >= stream.shown + this.frameDuration)) this.starved = true;
    if (this.starved && this.streams.every((stream) => stream.frames.length >= RESUME_FRAMES || done(stream))) this.starved = false;
    const run = this.playing && this.seekTarget === null && !this.starved;
    if (run && !this.clock.running) this.clock.start();
    if (!run && this.clock.running) {
      this.clock.stop();
      this.stopAudio();
    }
    this.waiting = this.playing && !run;
    this.scheduleAudio();
  }

  destroy() {
    this.destroyed = true;
    this.generation++;
    for (const stream of this.streams) {
      for (const frame of stream.frames) frame.close();
      if (stream.decoder.state !== "closed") stream.decoder.close();
    }
    if (this.audio && this.audio.decoder.state !== "closed") this.audio.decoder.close();
    void this.context.close();
    this.wake.notify();
  }

  private receive(index: number, frame: VideoFrame) {
    this.stats.decoded++;
    if (this.destroyed || frame.timestamp < this.discardBefore * 1e6) return frame.close();
    this.streams[index]!.frames.push(frame);
  }

  /** Hands fetched samples to each stream's decoder, as far as its frames are being used. */
  private feed() {
    for (const stream of this.streams) {
      if (stream.decoder.state !== "configured") continue;
      while (stream.pending.length && stream.decoder.decodeQueueSize < 2 && stream.frames.length < MAX_FRAMES) {
        const { index, data } = stream.pending.shift()!;
        const { samples } = stream.track;
        stream.decoder.decode(new EncodedVideoChunk({ type: samples.sync[index] ? "key" : "delta", timestamp: Math.round(samples.times[index]! * 1e6), duration: Math.round(samples.durations[index]! * 1e6), data }));
      }
      if (!stream.pending.length && stream.cursor >= stream.track.samples.count && !stream.flushed) {
        stream.flushed = true;
        // A decoder keeps its last frames until told there are no more.
        stream.decoder.flush().catch(() => undefined);
      }
    }
  }

  private async pump(generation: number) {
    const batches: Promise<{ picks: Pick[]; data: Uint8Array[] }>[] = [];
    while (generation === this.generation) {
      const horizon = this.time() + READ_AHEAD;
      while (batches.length < BATCHES_AT_ONCE && this.fetchedUntil < horizon && this.remaining()) {
        this.fetchedUntil += BATCH;
        const batch = this.fetchBatch(this.fetchedUntil);
        // A batch that fails is reported when its turn comes; one behind it is never waited on.
        batch.catch(() => undefined);
        batches.push(batch);
      }
      if (!batches.length) {
        await this.wake.wait();
        continue;
      }
      const batch = await batches.shift()!;
      if (generation !== this.generation) return;
      batch.picks.forEach((pick, index) => {
        const data = batch.data[index]!;
        if (pick.stream >= 0) this.streams[pick.stream]!.pending.push({ index: pick.index, data });
        else this.decodeAudio(pick.index, data);
      });
      this.feed();
    }
  }

  private remaining() {
    return this.streams.some((stream) => stream.cursor < stream.track.samples.count) || (this.audio !== null && this.audio.cursor < this.audio.track.samples.count);
  }

  /** Every sample, of every stream and the sound, shown before `until`, read in as few reads as they allow. */
  private async fetchBatch(until: number) {
    const picks: Pick[] = [];
    const take = (stream: number, source: StreamSource & { cursor: number }) => {
      const { times, count } = source.track.samples;
      while (source.cursor < count && times[source.cursor]! < until) picks.push({ stream, index: source.cursor++ });
    };
    this.streams.forEach((stream, index) => take(index, stream));
    if (this.audio) take(-1, this.audio);
    const spans: Span[] = picks.map(({ stream, index }) => {
      const source = stream >= 0 ? this.streams[stream]! : this.audio!;
      return { file: source.file, offset: source.track.samples.offsets[index]!, size: source.track.samples.sizes[index]! };
    });
    return { picks, data: await this.fetch(spans) };
  }

  private decodeAudio(index: number, data: Uint8Array) {
    const audio = this.audio!;
    if (audio.decoder.state !== "configured") return;
    const { times, durations } = audio.track.samples;
    audio.decoder.decode(new EncodedAudioChunk({ type: "key", timestamp: Math.round(times[index]! * 1e6), duration: Math.round(durations[index]! * 1e6), data }));
  }

  /** Hands Web Audio the sound of the next moments, each part to start when the playhead reaches it. */
  private scheduleAudio() {
    const audio = this.audio;
    if (!audio || !this.clock.running || this.context.state !== "running") return;
    const now = this.clock.time();
    const start = this.context.currentTime;
    audio.parts = audio.parts.filter((part) => {
      const end = part.time + part.buffer.duration;
      if (end <= now && !part.source) return false;
      if (part.source || part.time > now + AUDIO_AHEAD) return true;
      const source = this.context.createBufferSource();
      source.buffer = part.buffer;
      source.connect(this.gain);
      const delay = part.time - now;
      if (delay >= 0) source.start(start + delay);
      else source.start(start, -delay);
      source.onended = () => {
        audio.parts = audio.parts.filter((other) => other !== part);
      };
      part.source = source;
      return true;
    });
  }

  private stopAudio() {
    for (const part of this.audio?.parts ?? []) {
      if (!part.source) continue;
      part.source.onended = null;
      part.source.stop();
      part.source.disconnect();
      part.source = null;
    }
  }
}

type Pick = { stream: number; index: number };

/** The last sample at or before `time` that a decoder can start from. */
function syncBefore(track: Track, time: number) {
  const { times, sync, count } = track.samples;
  let found = 0;
  for (let index = 0; index < count && times[index]! <= time + 1e-6; index++) if (sync[index]) found = index;
  return found;
}
