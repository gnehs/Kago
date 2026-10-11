import assert from 'node:assert/strict';
import { test } from 'node:test';
import { watchDirectPlayback } from '../src/features/files/directPlayback.ts';

class FakeDocument extends EventTarget {
  hidden = false;
}

class FakeVideo extends EventTarget {
  ownerDocument = new FakeDocument();
  currentTime = 0;
  readyState = 2;
  videoWidth = 1920;
  videoHeight = 1080;
  paused = false;
  ended = false;
  seeking = false;
  error = null;
  quality;

  constructor({
    currentTime = 0,
    readyState = 2,
    videoWidth = 1920,
    videoHeight = 1080,
    paused = false,
    ended = false,
    seeking = false,
    error = null,
    quality,
    hasPlaybackQuality = true,
  } = {}) {
    super();
    Object.assign(this, {
      currentTime,
      readyState,
      videoWidth,
      videoHeight,
      paused,
      ended,
      seeking,
      error,
      quality,
    });
    if (hasPlaybackQuality) {
      this.getVideoPlaybackQuality = () => this.quality;
    }
  }
}

function withClock(t) {
  t.mock.timers.enable({ apis: ['setInterval'] });

  return {
    advance(milliseconds) {
      t.mock.timers.tick(milliseconds);
    },
    step(seconds, beforeTick = () => {}) {
      for (let second = 0; second < seconds; second += 1) {
        beforeTick(second);
        t.mock.timers.tick(1000);
      }
    },
  };
}

function countFailure() {
  let failures = 0;
  return {
    onFailure: () => { failures += 1; },
    failures: () => failures,
  };
}

test('metadata at readyState 1 without a presented picture does not time out', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ readyState: 1, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  watchDirectPlayback(video, failure.onFailure);

  video.dispatchEvent(new Event('loadedmetadata'));
  assert.equal(failure.failures(), 0);
  clock.advance(65_000);
  assert.equal(failure.failures(), 0);
});

test('a stalled video with no timeupdate event does not time out', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  watchDirectPlayback(video, failure.onFailure);

  clock.advance(65_000);
  assert.equal(failure.failures(), 0);
});

for (const [name, quality] of [
  ['zero decoded frames', { totalVideoFrames: 0, droppedVideoFrames: 0 }],
  ['all decoded frames dropped', { totalVideoFrames: 90, droppedVideoFrames: 90 }],
]) {
  test(`audio time advancing with ${name} triggers fallback`, (t) => {
    const clock = withClock(t);
    const video = new FakeVideo({ quality });
    const failure = countFailure();
    watchDirectPlayback(video, failure.onFailure);

    clock.step(2, () => {
      video.currentTime += 0.5;
      video.dispatchEvent(new Event('timeupdate'));
    });
    assert.equal(failure.failures(), 0);
    video.currentTime += 0.5;
    video.dispatchEvent(new Event('timeupdate'));
    assert.equal(failure.failures(), 1);
  });
}

test('playback that rendered frames and then froze does not time out', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  watchDirectPlayback(video, failure.onFailure);

  clock.step(3, (second) => {
    video.currentTime += 1;
    video.quality = { totalVideoFrames: second + 1, droppedVideoFrames: 0 };
    video.dispatchEvent(new Event('timeupdate'));
  });
  clock.advance(65_000);
  assert.equal(failure.failures(), 0);
});

test('continuous playback keeps the direct player active', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  watchDirectPlayback(video, failure.onFailure);

  clock.step(30, (second) => {
    video.currentTime += 1;
    video.quality = { totalVideoFrames: second + 1, droppedVideoFrames: 0 };
    video.dispatchEvent(new Event('timeupdate'));
  });
  assert.equal(failure.failures(), 0);
});

test('paused playback does not time out', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ paused: true, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  watchDirectPlayback(video, failure.onFailure);

  clock.advance(65_000);
  assert.equal(failure.failures(), 0);
  video.paused = false;
  video.dispatchEvent(new Event('play'));
  clock.step(5, (second) => {
    video.currentTime += 1;
    video.quality = { totalVideoFrames: second + 1, droppedVideoFrames: 0 };
    video.dispatchEvent(new Event('timeupdate'));
  });
  assert.equal(failure.failures(), 0);
});

test('ended playback does not trigger the blind-frame fallback', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ ended: true, readyState: 1, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  watchDirectPlayback(video, failure.onFailure);

  clock.advance(65_000);
  assert.equal(failure.failures(), 0);
});

test('time spent hidden does not accumulate toward the blind-frame fallback', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  video.ownerDocument.hidden = true;
  watchDirectPlayback(video, failure.onFailure);

  clock.advance(30_000);
  video.currentTime = 20;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(failure.failures(), 0);
  video.ownerDocument.hidden = false;
  video.ownerDocument.dispatchEvent(new Event('visibilitychange'));
  video.currentTime += 1;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(failure.failures(), 0);
  video.currentTime += 0.6;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(failure.failures(), 1);
});

test('time spent seeking does not accumulate toward the blind-frame fallback', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  watchDirectPlayback(video, failure.onFailure);

  video.seeking = true;
  video.dispatchEvent(new Event('seeking'));
  clock.advance(30_000);
  video.currentTime = 20;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(failure.failures(), 0);
  video.seeking = false;
  video.dispatchEvent(new Event('seeked'));
  video.currentTime += 1;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(failure.failures(), 0);
  video.currentTime += 0.6;
  video.dispatchEvent(new Event('timeupdate'));
  assert.equal(failure.failures(), 1);
});

test('cleanup removes the timer and listeners', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  const cleanup = watchDirectPlayback(video, failure.onFailure);
  cleanup();
  cleanup();

  video.dispatchEvent(new Event('error'));
  video.dispatchEvent(new Event('loadedmetadata'));
  video.dispatchEvent(new Event('timeupdate'));
  video.ownerDocument.dispatchEvent(new Event('visibilitychange'));
  clock.advance(30_000);
  assert.equal(failure.failures(), 0);
});

test('a native error reports failure immediately and only once', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ error: { code: 3 }, quality: { totalVideoFrames: 0, droppedVideoFrames: 0 } });
  const failure = countFailure();
  watchDirectPlayback(video, failure.onFailure);

  video.dispatchEvent(new Event('error'));
  assert.equal(failure.failures(), 1);
  video.dispatchEvent(new Event('error'));
  video.dispatchEvent(new Event('error'));
  clock.advance(65_000);
  assert.equal(failure.failures(), 1);
});

for (const [name, error] of [
  ['ABORTED (code 1)', { code: 1 }],
  ['an empty media error', null],
  ['an unknown media error (code 0)', { code: 0 }],
]) {
  test(`a native ${name} event does not trigger fallback`, (t) => {
    withClock(t);
    const video = new FakeVideo({ error });
    const failure = countFailure();
    const cleanup = watchDirectPlayback(video, failure.onFailure);

    video.dispatchEvent(new Event('error'));
    assert.equal(failure.failures(), 0);
    cleanup();
  });
}

for (const [name, code] of [
  ['MEDIA_ERR_DECODE', 3],
  ['MEDIA_ERR_NETWORK', 2],
  ['MEDIA_ERR_SRC_NOT_SUPPORTED', 4],
]) {
  test(`a native ${name} event triggers fallback immediately and only once`, (t) => {
    withClock(t);
    const video = new FakeVideo({ error: { code } });
    const failure = countFailure();
    watchDirectPlayback(video, failure.onFailure);

    video.dispatchEvent(new Event('error'));
    assert.equal(failure.failures(), 1);
    video.dispatchEvent(new Event('error'));
    assert.equal(failure.failures(), 1);
  });
}

test('without getVideoPlaybackQuality, currentTime alone does not trigger fallback', (t) => {
  const clock = withClock(t);
  const video = new FakeVideo({ hasPlaybackQuality: false });
  const failure = countFailure();
  watchDirectPlayback(video, failure.onFailure);
  assert.equal(video.getVideoPlaybackQuality, undefined);

  clock.step(65, () => {
    video.currentTime += 1;
    video.dispatchEvent(new Event('timeupdate'));
  });
  assert.equal(failure.failures(), 0);
});
