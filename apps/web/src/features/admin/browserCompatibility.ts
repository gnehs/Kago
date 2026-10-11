export type BrowserCompatibilityStatus = 'passed' | 'failed' | 'unsupported' | 'unavailable';
export type BrowserCompatibilityEvidence = 'reported' | 'tested';
export type BrowserCompatibilityOperation = 'encode' | 'decode' | 'playback';

export type BrowserCompatibilityCheck = {
  id: string;
  label: string;
  codec: string;
  operation: BrowserCompatibilityOperation;
  status: BrowserCompatibilityStatus;
  detail: string;
  hardware: boolean | null;
  evidence?: BrowserCompatibilityEvidence;
  smooth?: boolean | null;
  powerEfficient?: boolean | null;
  width?: number;
  height?: number;
};

export type BrowserCompatibilityReport = {
  checkedAt: string;
  secureContext: boolean;
  checks: BrowserCompatibilityCheck[];
};

export type BrowserCompatibilityProgress = (completed: number, total: number) => void;

type CodecDefinition = {
  id: string;
  label: string;
  codec: string;
};
type VideoPlaybackProfile = CodecDefinition & { contentType: string };
type VideoCodecDefinition = CodecDefinition & {
  playback1080p: VideoPlaybackProfile;
  playback4k: VideoPlaybackProfile;
};
type AudioCodecDefinition = CodecDefinition & { contentType: string };

type BrowserHost = Omit<typeof globalThis,
  'isSecureContext' | 'navigator' | 'document' | 'VideoEncoder' | 'VideoDecoder' | 'VideoFrame' | 'EncodedVideoChunk'
> & {
  isSecureContext?: boolean;
  navigator?: Navigator & { mediaCapabilities?: MediaCapabilities };
  document?: Document;
  VideoEncoder?: typeof VideoEncoder;
  VideoDecoder?: typeof VideoDecoder;
  VideoFrame?: typeof VideoFrame;
  EncodedVideoChunk?: typeof EncodedVideoChunk;
};

const VIDEO_CODECS: VideoCodecDefinition[] = [
  {
    id: 'h264', label: 'H.264', codec: 'avc1.42001E',
    playback1080p: { id: 'h264', label: 'H.264', codec: 'avc1.640029', contentType: 'video/mp4; codecs="avc1.640029"' },
    playback4k: { id: 'h264', label: 'H.264', codec: 'avc1.640033', contentType: 'video/mp4; codecs="avc1.640033"' },
  },
  {
    id: 'hevc', label: 'HEVC', codec: 'hvc1.1.6.L93.B0',
    playback1080p: { id: 'hevc', label: 'HEVC', codec: 'hvc1.1.6.L120.B0', contentType: 'video/mp4; codecs="hvc1.1.6.L120.B0"' },
    playback4k: { id: 'hevc', label: 'HEVC Main 10', codec: 'hvc1.2.4.L153.B0', contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"' },
  },
  {
    id: 'vp8', label: 'VP8', codec: 'vp8',
    playback1080p: { id: 'vp8', label: 'VP8', codec: 'vp8', contentType: 'video/webm; codecs="vp8"' },
    playback4k: { id: 'vp8', label: 'VP8', codec: 'vp8', contentType: 'video/webm; codecs="vp8"' },
  },
  {
    id: 'vp9', label: 'VP9', codec: 'vp09.00.10.08',
    playback1080p: { id: 'vp9', label: 'VP9', codec: 'vp09.00.40.08.00', contentType: 'video/webm; codecs="vp09.00.40.08.00"' },
    playback4k: { id: 'vp9', label: 'VP9', codec: 'vp09.00.51.08.00', contentType: 'video/webm; codecs="vp09.00.51.08.00"' },
  },
  {
    id: 'av1', label: 'AV1', codec: 'av01.0.04M.08',
    playback1080p: { id: 'av1', label: 'AV1', codec: 'av01.0.08M.08', contentType: 'video/mp4; codecs="av01.0.08M.08"' },
    playback4k: { id: 'av1', label: 'AV1', codec: 'av01.0.12M.08', contentType: 'video/mp4; codecs="av01.0.12M.08"' },
  },
];

const AUDIO_CODECS: AudioCodecDefinition[] = [
  { id: 'aac', label: 'AAC', codec: 'mp4a.40.2', contentType: 'audio/mp4; codecs="mp4a.40.2"' },
  { id: 'opus', label: 'Opus', codec: 'opus', contentType: 'audio/webm; codecs="opus"' },
  { id: 'vorbis', label: 'Vorbis', codec: 'vorbis', contentType: 'audio/webm; codecs="vorbis"' },
];

const TEST_WIDTH = 64;
const TEST_HEIGHT = 64;
const CODEC_TIMEOUT_MS = 4_000;
const CAPABILITY_TIMEOUT_MS = 2_000;
const PLAYBACK_TIMEOUT_MS = 2_000;
const TOTAL_CHECKS = VIDEO_CODECS.length * 4 + AUDIO_CODECS.length;

type SupportResult = {
  supported: boolean | null;
  timedOut: boolean;
  checked: boolean;
};
type CodecSupport = { supported?: boolean };

type EncodedOutput = {
  type: EncodedVideoChunkType;
  timestamp: number;
  duration?: number;
  data: Uint8Array;
  decoderConfig?: VideoDecoderConfig;
};

type EncodeResult = {
  kind: 'passed' | 'failed' | 'unavailable';
  detail: string;
  outputs: EncodedOutput[];
};

type OperationResult = Pick<BrowserCompatibilityCheck, 'status' | 'detail' | 'evidence'>;

class OperationTimeoutError extends Error {
  constructor() {
    super('Browser compatibility check timed out.');
    this.name = 'TimeoutError';
  }
}

function abortError(): Error {
  if (typeof DOMException !== 'undefined') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

function withDeadline<T>(work: () => Promise<T>, signal: AbortSignal | undefined, timeoutMs: number): Promise<T> {
  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: (value: never) => void, value: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value as never);
    };
    const onAbort = () => finish(reject, abortError());
    const timer = setTimeout(() => finish(reject, new OperationTimeoutError()), timeoutMs);

    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      Promise.resolve(work()).then(
        (value) => finish(resolve, value),
        (error: unknown) => finish(reject, error),
      );
    } catch (error) {
      finish(reject, error);
    }
  });
}

function host(): BrowserHost {
  return globalThis as unknown as BrowserHost;
}

function reportSupport(supported: boolean | null, checked: boolean, timedOut = false): SupportResult {
  return { supported, checked, timedOut };
}

async function queryCodecSupport(
  probe: (() => Promise<CodecSupport>) | undefined,
  signal?: AbortSignal,
): Promise<SupportResult> {
  if (!probe) return reportSupport(null, false);

  try {
    const result = await withDeadline(probe, signal, CAPABILITY_TIMEOUT_MS);
    return typeof result?.supported === 'boolean'
      ? reportSupport(result.supported, true)
      : reportSupport(null, true);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return reportSupport(null, true, isTimeoutError(error));
  }
}

function makeCanvasSource(browser: BrowserHost): HTMLCanvasElement | null {
  if (typeof browser.document?.createElement !== 'function') return null;

  try {
    const canvas = browser.document.createElement('canvas') as HTMLCanvasElement;
    canvas.width = TEST_WIDTH;
    canvas.height = TEST_HEIGHT;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.fillStyle = '#275dad';
    context.fillRect(0, 0, TEST_WIDTH, TEST_HEIGHT);
    context.fillStyle = '#e6a23c';
    context.fillRect(8, 8, TEST_WIDTH - 16, TEST_HEIGHT - 16);
    return canvas;
  } catch {
    return null;
  }
}

function copyDecoderConfig(config: VideoDecoderConfig | undefined): VideoDecoderConfig | undefined {
  return config ? { ...config } : undefined;
}

async function encodeSyntheticFrame(
  browser: BrowserHost,
  codec: VideoCodecDefinition,
  support: SupportResult,
  signal?: AbortSignal,
): Promise<EncodeResult> {
  if (support.supported === false) {
    return { kind: 'unavailable', detail: 'browser.webCodecsEncodeUnsupported', outputs: [] };
  }

  const canvas = makeCanvasSource(browser);
  const Frame = browser.VideoFrame;
  const Encoder = browser.VideoEncoder;
  if (!canvas || typeof Frame !== 'function' || typeof Encoder !== 'function') {
    return {
      kind: 'unavailable',
      detail: !canvas
        ? 'browser.videoTestSourceUnavailable'
        : 'browser.webCodecsEncoderUnavailable',
      outputs: [],
    };
  }

  const config: VideoEncoderConfig = {
    codec: codec.codec,
    width: TEST_WIDTH,
    height: TEST_HEIGHT,
    bitrate: 250_000,
    framerate: 30,
    latencyMode: 'realtime',
    // Keep software-only browser implementations eligible; this preference does not identify the selected processor.
    hardwareAcceleration: 'no-preference',
  };
  const outputs: EncodedOutput[] = [];
  let callbackError: unknown;
  let flushCompleted = false;
  let rejectCodecError: (error: unknown) => void = () => undefined;
  const codecError = new Promise<never>((_resolve, reject) => { rejectCodecError = reject; });
  // Keep an error callback from becoming an unhandled rejection before flush() is raced against it.
  void codecError.catch(() => undefined);
  let encoder: VideoEncoder | undefined;
  let frame: VideoFrame | undefined;

  try {
    await withDeadline(async () => {
      frame = new Frame(canvas, { timestamp: 0 });
      encoder = new Encoder({
        output: (chunk, metadata) => {
          try {
            if (!Number.isFinite(chunk.byteLength) || chunk.byteLength <= 0) return;
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            outputs.push({
              type: chunk.type,
              timestamp: chunk.timestamp,
              ...(chunk.duration == null ? {} : { duration: chunk.duration }),
              data,
              decoderConfig: copyDecoderConfig(metadata?.decoderConfig),
            });
          } catch (error) {
            callbackError = error;
            rejectCodecError(error);
          }
        },
        error: (error) => {
          callbackError = error;
          rejectCodecError(error);
        },
      });
      encoder.configure(config);
      encoder.encode(frame, { keyFrame: true });
      await Promise.race([encoder.flush(), codecError]);
      flushCompleted = true;
      if (callbackError) throw callbackError;
      if (outputs.length === 0) throw new Error('Encoder produced no output.');
    }, signal, CODEC_TIMEOUT_MS);
    return { kind: 'passed', detail: 'browser.webCodecsEncodeTestPassed', outputs };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isTimeoutError(error)) {
      return { kind: 'failed', detail: 'browser.webCodecsEncodeTimedOut', outputs };
    }
    return {
      kind: 'failed',
      detail: outputs.length === 0 && flushCompleted
        ? 'browser.webCodecsEncodeNoOutput'
        : 'browser.webCodecsEncodeTestFailed',
      outputs,
    };
  } finally {
    try { frame?.close(); } catch { /* The frame may already have been reclaimed by the browser. */ }
    try { if (encoder?.state !== 'closed') encoder?.close(); } catch { /* Release resources even after a codec error. */ }
  }
}

async function decodeSyntheticOutput(
  browser: BrowserHost,
  codec: VideoCodecDefinition,
  outputs: EncodedOutput[],
  signal?: AbortSignal,
): Promise<OperationResult> {
  const Decoder = browser.VideoDecoder;
  const Chunk = browser.EncodedVideoChunk;
  if (!outputs.length || typeof Decoder !== 'function' || typeof Chunk !== 'function') {
    return {
      status: 'unavailable',
      detail: 'browser.webCodecsDecodeTestUnavailable',
      evidence: 'reported',
    };
  }

  let decodedFrames = 0;
  let callbackError: unknown;
  let flushCompleted = false;
  let rejectCodecError: (error: unknown) => void = () => undefined;
  const codecError = new Promise<never>((_resolve, reject) => { rejectCodecError = reject; });
  void codecError.catch(() => undefined);
  let decoder: VideoDecoder | undefined;

  try {
    await withDeadline(async () => {
      decoder = new Decoder({
        output: (frame) => {
          decodedFrames += 1;
          try { (frame as { close?: () => void })?.close?.(); } catch { /* Ignore already-closed output frames. */ }
        },
        error: (error) => {
          callbackError = error;
          rejectCodecError(error);
        },
      });
      const decoderConfig = copyDecoderConfig(outputs.find((output) => output.decoderConfig)?.decoderConfig) ?? {
        codec: codec.codec,
        codedWidth: TEST_WIDTH,
        codedHeight: TEST_HEIGHT,
      };
      decoder.configure({ ...decoderConfig, hardwareAcceleration: 'no-preference' });

      for (const output of outputs) {
        const chunk = new Chunk({
          type: output.type,
          timestamp: output.timestamp,
          ...(output.duration === undefined ? {} : { duration: output.duration }),
          data: output.data,
        });
        decoder.decode(chunk);
      }
      await Promise.race([decoder.flush(), codecError]);
      flushCompleted = true;
      if (callbackError) throw callbackError;
      if (decodedFrames === 0) throw new Error('Decoder produced no output.');
    }, signal, CODEC_TIMEOUT_MS);
    return {
      status: 'passed',
      detail: 'browser.webCodecsDecodeTestPassed',
      evidence: 'tested',
    };
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isTimeoutError(error)) {
      return {
        status: 'failed',
        detail: 'browser.webCodecsDecodeTimedOut',
        evidence: 'tested',
      };
    }
    return {
      status: 'failed',
      detail: decodedFrames === 0 && flushCompleted
        ? 'browser.webCodecsDecodeNoOutput'
        : 'browser.webCodecsDecodeTestFailed',
      evidence: 'tested',
    };
  } finally {
    try { if (decoder?.state !== 'closed') decoder?.close(); } catch { /* Release resources after a failed decode. */ }
  }
}

function reportedCodecResult(support: SupportResult, operation: 'encode' | 'decode'): OperationResult {
  const prefix = operation === 'encode' ? 'webCodecsEncode' : 'webCodecsDecode';
  if (support.supported === true) {
    return {
      status: 'passed',
      detail: operation === 'decode'
        ? 'browser.webCodecsDecodeReportedOnly'
        : 'browser.webCodecsEncodeReportedOnly',
      evidence: 'reported',
    };
  }
  if (support.supported === false) {
    return {
      status: 'unsupported',
      detail: `browser.${prefix}Unsupported`,
      evidence: 'reported',
    };
  }
  return {
    status: 'unavailable',
    detail: support.timedOut
      ? 'browser.codecCapabilityCheckTimedOut'
      : 'browser.codecCapabilityCheckUnavailable',
    evidence: 'reported',
  };
}

function check(
  codec: CodecDefinition,
  operation: BrowserCompatibilityOperation,
  result: OperationResult,
  label: string,
  id: string,
  dimensions?: { width: number; height: number },
): BrowserCompatibilityCheck {
  return {
    id,
    label,
    codec: codec.codec,
    operation,
    status: result.status,
    detail: result.detail,
    hardware: null,
    ...(result.evidence ? { evidence: result.evidence } : {}),
    ...(dimensions ?? {}),
  };
}

function secureContextUnavailable(codec: CodecDefinition, operation: 'encode' | 'decode'): BrowserCompatibilityCheck {
  return check(
    codec,
    operation,
    {
      status: 'unavailable',
      detail: 'browser.insecureContext',
      evidence: 'reported',
    },
    codec.label,
    `webcodecs-${codec.id}-${operation}`,
  );
}

async function checkVideoCodec(
  browser: BrowserHost,
  codec: VideoCodecDefinition,
  secureContext: boolean,
  signal?: AbortSignal,
): Promise<[BrowserCompatibilityCheck, BrowserCompatibilityCheck]> {
  if (!secureContext) return [secureContextUnavailable(codec, 'encode'), secureContextUnavailable(codec, 'decode')];

  const encodeConfig: VideoEncoderConfig = {
    codec: codec.codec,
    width: TEST_WIDTH,
    height: TEST_HEIGHT,
    bitrate: 250_000,
    framerate: 30,
    latencyMode: 'realtime',
    hardwareAcceleration: 'no-preference',
  };
  const decodeConfig: VideoDecoderConfig = {
    codec: codec.codec,
    codedWidth: TEST_WIDTH,
    codedHeight: TEST_HEIGHT,
    hardwareAcceleration: 'no-preference',
  };
  // These independent queries preserve decoder capability even when no encoder is available.
  const Encoder = browser.VideoEncoder;
  const Decoder = browser.VideoDecoder;
  const [encodeSupport, decodeSupport] = await Promise.all([
    queryCodecSupport(
      typeof Encoder?.isConfigSupported === 'function' ? () => Encoder.isConfigSupported(encodeConfig) : undefined,
      signal,
    ),
    queryCodecSupport(
      typeof Decoder?.isConfigSupported === 'function' ? () => Decoder.isConfigSupported(decodeConfig) : undefined,
      signal,
    ),
  ]);

  let encodeResult: OperationResult;
  let encodedOutputs: EncodedOutput[] = [];
  if (encodeSupport.supported === false) {
    encodeResult = reportedCodecResult(encodeSupport, 'encode');
  } else if (typeof browser.VideoEncoder !== 'function') {
    encodeResult = reportedCodecResult(encodeSupport, 'encode');
    if (encodeSupport.supported === null) {
      encodeResult = {
        status: 'unavailable',
        detail: 'browser.webCodecsEncoderUnavailable',
        evidence: 'reported',
      };
    }
  } else {
    const encoded = await encodeSyntheticFrame(browser, codec, encodeSupport, signal);
    encodedOutputs = encoded.outputs;
    encodeResult = encoded.kind === 'passed'
      ? { status: 'passed', detail: encoded.detail, evidence: 'tested' }
      : encoded.kind === 'failed'
        ? { status: 'failed', detail: encoded.detail, evidence: 'tested' }
        : encodeSupport.supported === true
          ? reportedCodecResult(encodeSupport, 'encode')
          : { status: 'unavailable', detail: encoded.detail, evidence: 'reported' };
  }

  let decodeResult: OperationResult;
  if (decodeSupport.supported === false) {
    decodeResult = reportedCodecResult(decodeSupport, 'decode');
  } else if (encodedOutputs.length > 0 && typeof browser.VideoDecoder === 'function') {
    decodeResult = await decodeSyntheticOutput(browser, codec, encodedOutputs, signal);
  } else {
    decodeResult = reportedCodecResult(decodeSupport, 'decode');
  }

  return [
    check(codec, 'encode', encodeResult, codec.label, `webcodecs-${codec.id}-encode`),
    check(codec, 'decode', decodeResult, codec.label, `webcodecs-${codec.id}-decode`),
  ];
}

async function queryPlayback(
  browser: BrowserHost,
  codec: CodecDefinition,
  id: string,
  label: string,
  configuration: MediaDecodingConfiguration,
  signal?: AbortSignal,
  dimensions?: { width: number; height: number },
): Promise<BrowserCompatibilityCheck> {
  const mediaCapabilities = browser.navigator?.mediaCapabilities;
  const decodingInfo = mediaCapabilities?.decodingInfo;
  const makeCheck = (result: OperationResult, mediaResult?: MediaCapabilitiesInfo) => ({
    ...check(codec, 'playback', result, label, id, dimensions),
    ...(mediaResult ? {
      smooth: typeof mediaResult.smooth === 'boolean' ? mediaResult.smooth : null,
      powerEfficient: typeof mediaResult.powerEfficient === 'boolean' ? mediaResult.powerEfficient : null,
    } : {}),
  });

  if (typeof decodingInfo !== 'function') {
    return makeCheck({
      status: 'unavailable',
      detail: 'browser.mediaCapabilitiesUnavailable',
      evidence: 'reported',
    });
  }

  try {
    const result = await withDeadline(
      () => decodingInfo.call(mediaCapabilities, configuration),
      signal,
      PLAYBACK_TIMEOUT_MS,
    );
    if (typeof result?.supported !== 'boolean') {
      return makeCheck({
        status: 'unavailable',
        detail: 'browser.mediaCapabilitiesQueryUnavailable',
        evidence: 'reported',
      });
    }
    return makeCheck({
      status: result.supported ? 'passed' : 'unsupported',
      detail: result.supported
        ? 'browser.mediaCapabilitiesPlaybackSupported'
        : 'browser.mediaCapabilitiesPlaybackUnsupported',
      evidence: 'reported',
    }, result);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return makeCheck({
      status: 'unavailable',
      detail: isTimeoutError(error)
        ? 'browser.mediaCapabilitiesQueryTimedOut'
        : 'browser.mediaCapabilitiesQueryFailed',
      evidence: 'reported',
    });
  }
}

async function checkPlayback(
  browser: BrowserHost,
  codec: VideoCodecDefinition,
  width: number,
  height: number,
  signal?: AbortSignal,
): Promise<BrowserCompatibilityCheck> {
  const profile = width === 3840 ? codec.playback4k : codec.playback1080p;
  const reportCodec = { ...codec, codec: profile.codec };
  const label = `${profile.label} ${width === 3840 ? '4K' : '1080p'} · 30 fps`;
  return queryPlayback(browser, reportCodec, `playback-${codec.id}-${width}x${height}`, label, {
    type: 'file',
    video: {
      contentType: profile.contentType,
      width,
      height,
      bitrate: width === 3840 ? 16_000_000 : 5_000_000,
      framerate: 30,
    },
  }, signal, { width, height });
}

async function checkAudioPlayback(
  browser: BrowserHost,
  codec: AudioCodecDefinition,
  signal?: AbortSignal,
): Promise<BrowserCompatibilityCheck> {
  return queryPlayback(browser, codec, `playback-audio-${codec.id}`, codec.label, {
    type: 'file',
    audio: {
      contentType: codec.contentType,
      channels: '2',
      bitrate: 128_000,
      samplerate: 48_000,
    },
  }, signal);
}

/**
 * Queries browser playback reports and performs a tiny synthetic WebCodecs encode/decode test.
 * Capability queries and actual round trips are reported separately; browser APIs do not prove GPU use.
 */
export async function runBrowserCompatibility(
  signal?: AbortSignal,
  onProgress?: BrowserCompatibilityProgress,
): Promise<BrowserCompatibilityReport> {
  throwIfAborted(signal);
  const browser = host();
  const secureContext = browser.isSecureContext === true;
  const checks: BrowserCompatibilityCheck[] = [];
  const add = (result: BrowserCompatibilityCheck) => {
    checks.push(result);
    onProgress?.(checks.length, TOTAL_CHECKS);
  };

  for (const codec of VIDEO_CODECS) {
    throwIfAborted(signal);
    const [encode, decode] = await checkVideoCodec(browser, codec, secureContext, signal);
    add(encode);
    add(decode);
    add(await checkPlayback(browser, codec, 1920, 1080, signal));
    add(await checkPlayback(browser, codec, 3840, 2160, signal));
  }

  for (const codec of AUDIO_CODECS) {
    throwIfAborted(signal);
    add(await checkAudioPlayback(browser, codec, signal));
  }

  return {
    checkedAt: new Date().toISOString(),
    secureContext,
    checks,
  };
}
