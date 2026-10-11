import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INITIAL_RECOVERY,
  recoverPlayback,
  trackPlaybackPosition,
} from '../src/features/files/playbackRecovery.ts';

class FakeVideo extends EventTarget {
  currentTime = 0;
  readyState = 2;
  error = null;
  ended = false;
  paused = true;
  #listeners = new Map();

  constructor({ currentTime = 0, readyState = 2, error = null, ended = false, paused = true } = {}) {
    super();
    Object.assign(this, { currentTime, readyState, error, ended, paused });
  }

  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options);
    if (listener) {
      const listeners = this.#listeners.get(type) ?? new Set();
      listeners.add(listener);
      this.#listeners.set(type, listeners);
    }
  }

  removeEventListener(type, listener, options) {
    super.removeEventListener(type, listener, options);
    this.#listeners.get(type)?.delete(listener);
  }

  listenerCount(type) {
    return this.#listeners.get(type)?.size ?? 0;
  }

  emit(type) {
    this.dispatchEvent(new Event(type));
  }
}

test('direct playback failure forces transcoding to SDR', () => {
  assert.deepEqual(
    recoverPlayback(INITIAL_RECOVERY, 'direct', 'media', true),
    { forceTranscode: true, forceSdr: true, retries: 0 },
  );
});

test('an HDR media failure switches to transcoded SDR', () => {
  assert.deepEqual(
    recoverPlayback(INITIAL_RECOVERY, 'hdr', 'media', true),
    { forceTranscode: true, forceSdr: true, retries: 0 },
  );
});

test('network recovery is limited to two retries', () => {
  const first = recoverPlayback(INITIAL_RECOVERY, 'sdr', 'network', true);
  assert.deepEqual(first, { forceTranscode: false, forceSdr: false, retries: 1 });

  const second = recoverPlayback(first, 'sdr', 'network', true);
  assert.deepEqual(second, { forceTranscode: false, forceSdr: false, retries: 2 });
  assert.equal(recoverPlayback(second, 'sdr', 'network', true), null);
});

test('recovery returns null when transcoding is unavailable', () => {
  assert.equal(recoverPlayback(INITIAL_RECOVERY, 'direct', 'media', false), null);
  assert.equal(recoverPlayback(INITIAL_RECOVERY, 'sdr', 'network', false), null);
});

test('a stale direct error after forcing transcode does not start another recovery', () => {
  const forced = recoverPlayback(INITIAL_RECOVERY, 'direct', 'media', true);
  assert.equal(forced.retries, 0);
  assert.equal(recoverPlayback(forced, 'direct', 'media', true), null);
  assert.equal(forced.retries, 0);
});

test('an error that resets a playing element preserves its last position and play intent', () => {
  const video = new FakeVideo();
  const tracker = trackPlaybackPosition(video, { time: 0, playing: true });

  video.currentTime = 48;
  video.emit('timeupdate');
  video.error = { code: 3 };
  video.paused = true;
  video.readyState = 0;
  video.currentTime = 0;
  video.emit('error');
  video.emit('pause');
  tracker.fail();

  assert.deepEqual(tracker.capture(), { time: 48, playing: true });
});

test('a play request remains active when the error arrives before the play event', () => {
  const video = new FakeVideo({ currentTime: 0, readyState: 0 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: false });

  tracker.request(true);
  video.error = { code: 3 };
  video.paused = true;
  video.emit('error');
  video.emit('pause');
  tracker.fail();
  assert.deepEqual(tracker.capture(), { time: 123, playing: true });

  const savedPosition = tracker.dispose();
  const nextVideo = new FakeVideo({ currentTime: 0, readyState: 0 });
  const nextTracker = trackPlaybackPosition(nextVideo, savedPosition);
  nextVideo.emit('timeupdate');
  nextVideo.readyState = 2;
  nextVideo.currentTime = 123;
  nextVideo.emit('seeked');
  nextVideo.paused = false;
  nextVideo.emit('play');
  nextVideo.emit('playing');
  nextVideo.currentTime = 124;
  nextVideo.emit('timeupdate');
  assert.deepEqual(nextTracker.capture(), { time: 124, playing: true });
});

test('a user pause records a stopped intent instead of resuming playback', () => {
  const video = new FakeVideo({ currentTime: 64, paused: false });
  const tracker = trackPlaybackPosition(video, { time: 64, playing: true });

  tracker.request(false);
  video.paused = true;
  video.emit('pause');
  tracker.fail();

  assert.deepEqual(tracker.capture(), { time: 64, playing: false });
});

test('the initial pending seek position survives zero from a newly loading element', () => {
  const video = new FakeVideo({ currentTime: 0, readyState: 0 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: true });

  video.emit('timeupdate');
  video.readyState = 2;
  video.emit('timeupdate');
  assert.deepEqual(tracker.capture(), { time: 123, playing: true });
});

test('a seek while loading wins over stale timeupdate and playing events', () => {
  const video = new FakeVideo({ currentTime: 0, readyState: 0 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: false });

  tracker.seek(60);
  assert.deepEqual(tracker.capture(), { time: 60, playing: false });
  video.readyState = 2;
  video.currentTime = 123;
  video.emit('timeupdate');
  video.emit('playing');
  assert.deepEqual(tracker.capture(), { time: 60, playing: true });
});

test('the latest explicit seek wins, including a seek to zero', () => {
  const video = new FakeVideo({ currentTime: 123 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: true });

  tracker.seek(60);
  tracker.seek(90);
  tracker.seek(0);
  video.emit('timeupdate');
  assert.deepEqual(tracker.capture(), { time: 0, playing: true });

  video.currentTime = 0;
  video.emit('seeked');
  video.currentTime = 1;
  video.emit('timeupdate');
  assert.deepEqual(tracker.capture(), { time: 1, playing: true });
});

test('a pending seek to the current position resolves without a seeked event', () => {
  const video = new FakeVideo({ currentTime: 123 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: true });

  tracker.seek(123);
  video.emit('timeupdate');
  video.currentTime = 124;
  video.emit('timeupdate');
  assert.deepEqual(tracker.capture(), { time: 124, playing: true });
});

test('a seek to zero during loading resolves from a matching timeupdate without seeked', () => {
  const video = new FakeVideo({ currentTime: 0, readyState: 0 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: true });

  tracker.seek(0);
  video.readyState = 2;
  video.emit('timeupdate');
  assert.deepEqual(tracker.capture(), { time: 0, playing: true });
  video.currentTime = 1;
  video.emit('timeupdate');
  assert.deepEqual(tracker.capture(), { time: 1, playing: true });
});

test('dispose preserves an explicit seek target before seeked fires', () => {
  const video = new FakeVideo({ currentTime: 0, readyState: 0 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: true });

  tracker.seek(60);
  assert.deepEqual(tracker.capture(), { time: 60, playing: true });
  assert.deepEqual(tracker.dispose(), { time: 60, playing: true });
  for (const event of ['timeupdate', 'seeked', 'play', 'pause', 'playing', 'ended']) {
    assert.equal(video.listenerCount(event), 0);
  }
});

test('a seeked event near the target clears the pending seek and later time updates advance', () => {
  const video = new FakeVideo({ currentTime: 123 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: true });

  tracker.seek(60);
  video.currentTime = 60.2;
  video.emit('seeked');
  video.currentTime = 61;
  video.emit('timeupdate');
  assert.deepEqual(tracker.capture(), { time: 61, playing: true });
});

test('a seeked event away from the target leaves the pending seek in place', () => {
  const video = new FakeVideo({ currentTime: 123 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: true });

  tracker.seek(60);
  video.currentTime = 75;
  video.emit('seeked');
  video.currentTime = 76;
  video.emit('timeupdate');
  assert.deepEqual(tracker.capture(), { time: 60, playing: true });

  video.currentTime = 60.1;
  video.emit('seeked');
  video.currentTime = 61;
  video.emit('timeupdate');
  assert.deepEqual(tracker.capture(), { time: 61, playing: true });
});

test('an explicit seek after failure updates the frozen snapshot', () => {
  const video = new FakeVideo({ currentTime: 123 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: true });
  tracker.fail();
  assert.deepEqual(tracker.capture(), { time: 123, playing: true });

  tracker.seek(60);
  assert.deepEqual(tracker.capture(), { time: 60, playing: true });
  video.readyState = 0;
  video.currentTime = 0;
  video.emit('timeupdate');
  tracker.fail();
  assert.deepEqual(tracker.capture(), { time: 60, playing: true });
});

test('a completed seek back to zero records zero as the new position', () => {
  const video = new FakeVideo({ currentTime: 123 });
  const tracker = trackPlaybackPosition(video, { time: 123, playing: true });

  video.emit('timeupdate');
  video.currentTime = 0;
  video.emit('seeked');

  assert.deepEqual(tracker.capture(), { time: 0, playing: true });
});

test('events after failure cannot overwrite the captured position', () => {
  const video = new FakeVideo();
  const tracker = trackPlaybackPosition(video, { time: 0, playing: true });

  video.currentTime = 57;
  video.emit('timeupdate');
  video.error = { code: 3 };
  video.readyState = 0;
  video.currentTime = 0;
  tracker.fail();
  video.emit('timeupdate');
  video.emit('seeked');
  video.emit('error');
  video.emit('pause');
  video.emit('ended');
  tracker.fail();
  video.error = null;
  video.readyState = 2;
  video.currentTime = 0;
  video.emit('play');
  video.emit('playing');
  video.emit('timeupdate');

  assert.deepEqual(tracker.capture(), { time: 57, playing: true });
});

test('requesting pause after failure updates the saved intent and prevents auto-resume', () => {
  const video = new FakeVideo({ currentTime: 64, paused: false });
  const tracker = trackPlaybackPosition(video, { time: 64, playing: true });

  video.error = { code: 3 };
  video.readyState = 0;
  video.currentTime = 0;
  video.emit('error');
  tracker.fail();
  assert.deepEqual(tracker.capture(), { time: 64, playing: true });

  tracker.request(false);
  video.error = null;
  video.readyState = 2;
  video.paused = false;
  video.emit('play');
  video.emit('playing');
  assert.deepEqual(tracker.capture(), { time: 64, playing: false });
});

test('disposing a source removes listeners and a new tracker follows resumed playback', () => {
  const firstVideo = new FakeVideo();
  const firstTracker = trackPlaybackPosition(firstVideo, { time: 10, playing: false });
  const trackedEvents = ['timeupdate', 'seeked', 'play', 'pause', 'playing', 'ended'];

  firstVideo.currentTime = 25;
  firstVideo.emit('timeupdate');
  const savedPosition = firstTracker.dispose();
  assert.deepEqual(savedPosition, { time: 25, playing: false });
  for (const event of trackedEvents) assert.equal(firstVideo.listenerCount(event), 0);

  firstVideo.currentTime = 99;
  firstVideo.emit('timeupdate');
  firstVideo.emit('playing');
  assert.deepEqual(savedPosition, { time: 25, playing: false });

  const nextVideo = new FakeVideo({ currentTime: 0, readyState: 0 });
  const nextTracker = trackPlaybackPosition(nextVideo, savedPosition);
  nextVideo.emit('timeupdate');
  nextVideo.readyState = 2;
  nextVideo.emit('timeupdate');
  assert.deepEqual(nextTracker.capture(), { time: 25, playing: false });

  nextVideo.currentTime = 25;
  nextVideo.emit('seeked');
  nextVideo.paused = false;
  nextVideo.emit('playing');
  nextVideo.currentTime = 28;
  nextVideo.emit('timeupdate');
  assert.deepEqual(nextTracker.capture(), { time: 28, playing: true });
});
