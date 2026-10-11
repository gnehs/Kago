import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runBrowserCompatibility } from '../src/features/admin/browserCompatibility.ts';

const GLOBALS = [
  'isSecureContext',
  'navigator',
  'document',
  'VideoEncoder',
  'VideoDecoder',
  'VideoFrame',
  'EncodedVideoChunk',
];

function installBrowser(t, overrides = {}) {
  const previous = new Map(GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const defaults = {
    isSecureContext: true,
    navigator: { mediaCapabilities: { decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }) } },
    document: {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({ fillStyle: '', fillRect() {} }),
      }),
    },
    VideoEncoder: undefined,
    VideoDecoder: undefined,
    VideoFrame: class {
      constructor() { counters.videoFramesCreated += 1; }
      close() { counters.videoFramesClosed += 1; }
    },
    EncodedVideoChunk: class {
      constructor(init) { Object.assign(this, init); }
    },
  };

  for (const [name, value] of Object.entries({ ...defaults, ...overrides })) {
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }

  t.after(() => {
    for (const name of GLOBALS) {
      const descriptor = previous.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
}

let counters;

function makeCodecBrowser({
  encoderSupported = () => true,
  decoderSupported = () => true,
  encoderConfigureError = false,
  decoderConfigureError = false,
  decoderError = false,
  output = true,
  encoderHangs = false,
} = {}) {
  counters = {
    encoderQueries: 0,
    decoderQueries: 0,
    encodersCreated: 0,
    decodersCreated: 0,
    encodersClosed: 0,
    decodersClosed: 0,
    videoFramesCreated: 0,
    videoFramesClosed: 0,
    decodedFramesClosed: 0,
    encodedConfigs: [],
    decoderConfigs: [],
    encoderCapabilityConfigs: [],
    decoderCapabilityConfigs: [],
    playbackConfigs: [],
  };

  class FakeChunk {
    type = 'key';
    timestamp = 0;
    byteLength = 4;
    copyTo(destination) { destination.set([0x01, 0x02, 0x03, 0x04]); }
  }

  class FakeEncoder {
    static async isConfigSupported(config) {
      counters.encoderQueries += 1;
      counters.encoderCapabilityConfigs.push(config);
      return { supported: encoderSupported(config.codec), config };
    }

    constructor(init) {
      counters.encodersCreated += 1;
      this.output = init.output;
      this.error = init.error;
      this.state = 'unconfigured';
    }

    configure(config) {
      counters.encodedConfigs.push(config);
      if (encoderConfigureError) throw new Error('mock encoder configure failure');
      this.state = 'configured';
    }

    encode() {
      if (output) {
        this.output(new FakeChunk(), {
          decoderConfig: { codec: 'avc1.42001E', codedWidth: 64, codedHeight: 64 },
        });
      }
    }

    flush() {
      return encoderHangs ? new Promise(() => {}) : Promise.resolve();
    }

    close() {
      this.state = 'closed';
      counters.encodersClosed += 1;
    }
  }

  class FakeDecoder {
    static async isConfigSupported(config) {
      counters.decoderQueries += 1;
      counters.decoderCapabilityConfigs.push(config);
      return { supported: decoderSupported(config.codec), config };
    }

    constructor(init) {
      counters.decodersCreated += 1;
      this.output = init.output;
      this.error = init.error;
      this.state = 'unconfigured';
    }

    configure(config) {
      counters.decoderConfigs.push(config);
      if (decoderConfigureError) throw new Error('mock decoder configure failure');
      this.state = 'configured';
    }

    decode() {
      if (decoderError) throw new Error('mock decoder decode failure');
      this.output({ close: () => { counters.decodedFramesClosed += 1; } });
    }

    flush() { return Promise.resolve(); }

    close() {
      this.state = 'closed';
      counters.decodersClosed += 1;
    }
  }

  return {
    VideoEncoder: FakeEncoder,
    VideoDecoder: FakeDecoder,
    VideoFrame: class {
      constructor() { counters.videoFramesCreated += 1; }
      close() { counters.videoFramesClosed += 1; }
    },
    EncodedVideoChunk: class {
      constructor(init) { Object.assign(this, init); }
    },
    navigator: {
      mediaCapabilities: {
        decodingInfo: async (configuration) => {
          counters.playbackConfigs.push(configuration);
          return { supported: true, smooth: true, powerEfficient: true };
        },
      },
    },
  };
}

function resultFor(report, id) {
  const result = report.checks.find((check) => check.id === id);
  assert.ok(result, `expected report check ${id}`);
  return result;
}

test('missing browser APIs are reported as unavailable without throwing', async (t) => {
  installBrowser(t, { navigator: {}, VideoEncoder: undefined, VideoDecoder: undefined });

  const report = await runBrowserCompatibility();

  assert.equal(report.secureContext, true);
  assert.equal(report.checks.length, 23);
  assert.ok(report.checks.every((check) => check.status === 'unavailable'));
  assert.ok(report.checks.every((check) => check.hardware === null));
});

test('an insecure context disables WebCodecs checks but keeps playback queries independent', async (t) => {
  const browser = makeCodecBrowser();
  installBrowser(t, { ...browser, isSecureContext: false });

  const report = await runBrowserCompatibility();

  assert.equal(report.secureContext, false);
  assert.equal(counters.encoderQueries, 0);
  assert.equal(counters.decoderQueries, 0);
  assert.ok(report.checks.filter((check) => check.operation !== 'playback')
    .every((check) => check.status === 'unavailable' && check.detail === 'browser.insecureContext'));
  assert.ok(report.checks.filter((check) => check.operation === 'playback')
    .every((check) => check.status === 'passed' && check.evidence === 'reported'));
});

test('decoder capability is queried and retained when the encoder API is absent', async (t) => {
  const browser = makeCodecBrowser({ decoderSupported: (codec) => codec === 'avc1.42001E' });
  installBrowser(t, { ...browser, VideoEncoder: undefined });

  const report = await runBrowserCompatibility();
  const decode = resultFor(report, 'webcodecs-h264-decode');

  assert.equal(counters.decoderQueries, 5);
  assert.equal(decode.status, 'passed');
  assert.equal(decode.evidence, 'reported');
  assert.equal(decode.detail, 'browser.webCodecsDecodeReportedOnly');
});

test('a synthetic encode/decode pass closes codec objects and every video frame', async (t) => {
  const browser = makeCodecBrowser({
    encoderSupported: (codec) => codec === 'avc1.42001E',
    decoderSupported: (codec) => codec === 'avc1.42001E',
  });
  installBrowser(t, browser);
  const progress = [];

  const report = await runBrowserCompatibility(undefined, (completed, total) => progress.push([completed, total]));

  assert.equal(resultFor(report, 'webcodecs-h264-encode').status, 'passed');
  assert.equal(resultFor(report, 'webcodecs-h264-encode').evidence, 'tested');
  assert.equal(resultFor(report, 'webcodecs-h264-decode').status, 'passed');
  assert.equal(resultFor(report, 'webcodecs-h264-decode').evidence, 'tested');
  assert.equal(counters.encodersCreated, 1);
  assert.equal(counters.decodersCreated, 1);
  assert.equal(counters.encodersClosed, 1);
  assert.equal(counters.decodersClosed, 1);
  assert.equal(counters.videoFramesCreated, 1);
  assert.equal(counters.videoFramesClosed, 1);
  assert.equal(counters.decodedFramesClosed, 1);
  assert.deepEqual(progress.at(-1), [23, 23]);
  assert.ok(counters.encoderCapabilityConfigs.every((config) => config.hardwareAcceleration === 'no-preference'));
  assert.ok(counters.decoderCapabilityConfigs.every((config) => config.hardwareAcceleration === 'no-preference'));
  assert.ok(counters.encodedConfigs.every((config) => config.hardwareAcceleration === 'no-preference'));
  assert.ok(counters.decoderConfigs.every((config) => config.hardwareAcceleration === 'no-preference'));
  assert.ok(report.checks.every((check) => check.hardware === null));

  const playback1080p = resultFor(report, 'playback-h264-1920x1080');
  const playback4k = resultFor(report, 'playback-h264-3840x2160');
  assert.equal(playback1080p.codec, 'avc1.640029');
  assert.equal(playback4k.codec, 'avc1.640033');
  assert.equal(playback4k.powerEfficient, true);
  assert.equal(playback4k.evidence, 'reported');
  assert.equal(playback4k.label, 'H.264 4K · 30 fps');
  assert.equal(resultFor(report, 'webcodecs-vp8-encode').status, 'unsupported');
  assert.equal(resultFor(report, 'webcodecs-vp8-decode').status, 'unsupported');
  assert.equal(resultFor(report, 'playback-hevc-3840x2160').label, 'HEVC Main 10 4K · 30 fps');
  assert.equal(resultFor(report, 'playback-audio-aac').label, 'AAC');
});

test('configuration failures are failed tests while decoder reports remain independent', async (t) => {
  const browser = makeCodecBrowser({
    encoderSupported: (codec) => codec === 'avc1.42001E',
    decoderSupported: (codec) => codec === 'avc1.42001E',
    encoderConfigureError: true,
  });
  installBrowser(t, browser);

  const report = await runBrowserCompatibility();

  const encode = resultFor(report, 'webcodecs-h264-encode');
  const decode = resultFor(report, 'webcodecs-h264-decode');
  assert.equal(encode.status, 'failed');
  assert.equal(encode.evidence, 'tested');
  assert.equal(encode.detail, 'browser.webCodecsEncodeTestFailed');
  assert.equal(decode.status, 'passed');
  assert.equal(decode.evidence, 'reported');
  assert.equal(counters.encoderQueries, 5);
  assert.equal(counters.decoderQueries, 5);
  assert.equal(counters.encodersClosed, 1);
});

test('decoder failures are reflected after successful encoding and resources are closed', async (t) => {
  const browser = makeCodecBrowser({
    encoderSupported: (codec) => codec === 'avc1.42001E',
    decoderSupported: (codec) => codec === 'avc1.42001E',
    decoderConfigureError: true,
  });
  installBrowser(t, browser);

  const report = await runBrowserCompatibility();

  assert.equal(resultFor(report, 'webcodecs-h264-encode').status, 'passed');
  assert.equal(resultFor(report, 'webcodecs-h264-decode').status, 'failed');
  assert.equal(resultFor(report, 'webcodecs-h264-decode').detail, 'browser.webCodecsDecodeTestFailed');
  assert.equal(counters.encodersClosed, 1);
  assert.equal(counters.decodersClosed, 1);
});

test('a resolved encoder flush with no encoded bytes is a failed test', async (t) => {
  const browser = makeCodecBrowser({
    encoderSupported: (codec) => codec === 'avc1.42001E',
    decoderSupported: (codec) => codec === 'avc1.42001E',
    output: false,
  });
  installBrowser(t, browser);

  const report = await runBrowserCompatibility();

  assert.equal(resultFor(report, 'webcodecs-h264-encode').status, 'failed');
  assert.equal(resultFor(report, 'webcodecs-h264-encode').detail, 'browser.webCodecsEncodeNoOutput');
  assert.equal(resultFor(report, 'webcodecs-h264-decode').status, 'passed');
  assert.equal(resultFor(report, 'webcodecs-h264-decode').evidence, 'reported');
});

test('codec flush timeout is bounded and closes the encoder', async (t) => {
  const browser = makeCodecBrowser({
    encoderSupported: (codec) => codec === 'avc1.42001E',
    decoderSupported: (codec) => codec === 'avc1.42001E',
    encoderHangs: true,
  });
  installBrowser(t, browser);

  const report = await runBrowserCompatibility();

  assert.equal(resultFor(report, 'webcodecs-h264-encode').status, 'failed');
  assert.equal(resultFor(report, 'webcodecs-h264-encode').detail, 'browser.webCodecsEncodeTimedOut');
  assert.equal(resultFor(report, 'webcodecs-h264-decode').status, 'passed');
  assert.equal(resultFor(report, 'webcodecs-h264-decode').evidence, 'tested');
  assert.equal(counters.encodersClosed, 1);
  assert.equal(counters.decodersClosed, 1);
});

test('abort rejects promptly and still closes an active encoder', async (t) => {
  const browser = makeCodecBrowser({
    encoderSupported: (codec) => codec === 'avc1.42001E',
    decoderSupported: (codec) => codec === 'avc1.42001E',
    encoderHangs: true,
  });
  installBrowser(t, browser);
  const controller = new AbortController();
  const pending = runBrowserCompatibility(controller.signal);
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(counters.encodersClosed, 1);
});

test('an already-aborted request exits before probing APIs', async (t) => {
  const browser = makeCodecBrowser();
  installBrowser(t, browser);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(runBrowserCompatibility(controller.signal), { name: 'AbortError' });
  assert.equal(counters.encoderQueries, 0);
});
