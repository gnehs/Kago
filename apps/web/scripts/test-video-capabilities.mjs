import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canDirectPlay, canPlayHdrStream } from '../src/features/files/videoCapabilities.ts';

function media({
  codec = 'h264',
  profile = 'High',
  level = 41,
  bitDepth = 8,
  pixelFormat = 'yuv420p',
  container = 'mp4',
  audio = [],
} = {}) {
  return {
    video: { codec, profile, level, bitDepth, pixelFormat },
    container,
    audio,
  };
}

test('H.264 profile and level are both represented in the probed codec string', () => {
  const cases = [
    ['Constrained Baseline', 31, 'avc1.42c01f'],
    ['Baseline', 32, 'avc1.420020'],
    ['Main', 40, 'avc1.4d0028'],
    ['High', 41, 'avc1.640029'],
  ];

  for (const [profile, level, expected] of cases) {
    let requestedType = '';
    const canPlay = canDirectPlay(media({ profile, level }), (type) => {
      requestedType = type;
      return 'probably';
    });
    assert.equal(canPlay, true);
    assert.equal(requestedType, `video/mp4; codecs="${expected}"`);
  }
});

test('H.264 capability can differ by actual level', () => {
  const supportsLevel40 = (type) => type.includes('avc1.640028') ? 'probably' : '';
  assert.equal(canDirectPlay(media({ level: 40 }), supportsLevel40), true);
  assert.equal(canDirectPlay(media({ level: 41 }), supportsLevel40), false);
});

test('unknown H.264 profiles and invalid levels conservatively use server playback', () => {
  let probes = 0;
  const canPlay = () => {
    probes += 1;
    return 'probably';
  };

  assert.equal(canDirectPlay(media({ profile: '' }), canPlay), false);
  assert.equal(canDirectPlay(media({ profile: 'High 10' }), canPlay), false);
  assert.equal(canDirectPlay(media({ profile: 'High 4:2:2', bitDepth: 8 }), canPlay), false);
  assert.equal(canDirectPlay(media({ level: -99 }), canPlay), false);
  assert.equal(probes, 0);
});

test('HEVC Main uses its reported profile and level', () => {
  const types = [];
  assert.equal(canDirectPlay(media({ codec: 'hevc', profile: 'Main', level: 120, bitDepth: 8 }), (type) => {
    types.push(type);
    return 'probably';
  }), true);

  assert.deepEqual(types, [
    'video/mp4; codecs="hvc1.1.6.L120"',
    'video/mp4; codecs="hvc1.1.6.L120"',
  ]);
});

test('HEVC Main 10 probes Main 10 at its real level', () => {
  const types = [];
  assert.equal(canDirectPlay(media({ codec: 'hevc', profile: 'Main 10', level: 153, bitDepth: 10 }), (type) => {
    types.push(type);
    return 'probably';
  }), true);

  assert.deepEqual(types, [
    'video/mp4; codecs="hvc1.2.4.L153"',
    'video/mp4; codecs="hvc1.2.4.L153"',
  ]);
});

test('HEVC Main 10 is never inferred from an 8-bit Main probe', () => {
  const types = [];
  const supportsOnlyMain8 = (type) => {
    types.push(type);
    return type.includes('hvc1.1.6') ? 'probably' : '';
  };

  assert.equal(canDirectPlay(media({ codec: 'hevc', profile: 'Main 10', level: 153, bitDepth: 10 }), supportsOnlyMain8), false);
  assert.deepEqual(types, ['video/mp4; codecs="hvc1.2.4.L153"']);
});

test('HEVC capability depends on the actual level reported by ffprobe', () => {
  const types = [];
  const supportsLevel120Only = (type) => {
    types.push(type);
    return type.includes('.L120') ? 'probably' : '';
  };

  assert.equal(canDirectPlay(media({ codec: 'hevc', profile: 'Main', level: 120, bitDepth: 8 }), supportsLevel120Only), true);
  assert.equal(canDirectPlay(media({ codec: 'hevc', profile: 'Main', level: 153, bitDepth: 8 }), supportsLevel120Only), false);
  assert.deepEqual(types, [
    'video/mp4; codecs="hvc1.1.6.L120"',
    'video/mp4; codecs="hvc1.1.6.L120"',
    'video/mp4; codecs="hvc1.1.6.L153"',
  ]);
});

test('missing HEVC bit depth, profile, or level is rejected without a generic probe', () => {
  let probes = 0;
  const canPlay = () => {
    probes += 1;
    return 'probably';
  };

  assert.equal(canDirectPlay(media({ codec: 'hevc', profile: 'Main 10', level: 153, bitDepth: 0 }), canPlay), false);
  assert.equal(canDirectPlay(media({ codec: 'hevc', profile: '', level: 153, bitDepth: 10 }), canPlay), false);
  assert.equal(canDirectPlay(media({ codec: 'hevc', profile: 'Main', level: 151, bitDepth: 8 }), canPlay), false);
  assert.equal(probes, 0);
});

test('existing direct-play container, audio, bit-depth, and chroma guards still apply', () => {
  const supported = () => 'probably';
  const unsupportedAudio = [{ codec: 'truehd' }];

  assert.equal(canDirectPlay(media({ container: 'matroska', audio: unsupportedAudio }), supported), false);
  assert.equal(canDirectPlay(media({ audio: [{ codec: 'unknown' }] }), supported), false);
  for (const pixelFormat of ['yuv422p', 'yuv444p', 'rgb24', 'gbrp', 'gray8']) {
    assert.equal(canDirectPlay(media({ pixelFormat }), supported), false, `${pixelFormat} should require transcoding`);
  }
  assert.equal(canDirectPlay(media({ bitDepth: 12 }), supported), false);
  assert.equal(canDirectPlay(media({ codec: 'vp9', profile: '', level: 0, bitDepth: 10, container: 'matroska', audio: [{ codec: 'opus' }] }), supported), true);
});

test('canPlayHdrStream checks the exact Main 10 HDR type through Media Source Extensions', (t) => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'MediaSource');
  const calls = [];
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value: { isTypeSupported: (type) => { calls.push(type); return true; } },
  });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'MediaSource', previous);
    else delete globalThis.MediaSource;
  });

  assert.equal(canPlayHdrStream(), true);
  assert.deepEqual(calls, ['video/mp4; codecs="hvc1.2.4.L153.B0"']);
});
