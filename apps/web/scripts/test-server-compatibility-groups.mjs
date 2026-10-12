import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupServerChecks, summarizeServerChecks } from '../src/features/admin/serverCompatibility.ts';

const check = (deviceId, operation, status, overrides = {}) => ({
  id: `${deviceId}-h264-${operation}`,
  label: 'H.264', codec: 'H.264', operation, status,
  backend: 'VA-API', hardware: true, detail: 'compatibility.passed', durationMs: 1,
  deviceId, deviceLabel: 'Same GPU model', deviceScope: 'device', ...overrides
});

test('identical model names preserve separate results for GPUs with complementary capabilities', () => {
  const groups = groupServerChecks([
    check('vaapi-renderD128', 'encode', 'passed'),
    check('vaapi-renderD129', 'decode', 'passed'),
    check('vaapi-renderD128', 'decode', 'failed'),
    check('vaapi-renderD129', 'encode', 'failed')
  ]);
  assert.equal(groups.length, 2);
  for (const group of groups) assert.ok(group.checks.every(result => result.deviceId === group.device.deviceId));
  assert.deepEqual(groups[0].checks.map(result => [result.operation, result.status]), [['encode', 'passed'], ['decode', 'failed']]);
  assert.deepEqual(groups[1].checks.map(result => [result.operation, result.status]), [['decode', 'passed'], ['encode', 'failed']]);
  assert.notEqual(groups[0].key, groups[1].key);
});

test('both codecs on the same GPU stay in one device group', () => {
  const groups = groupServerChecks([
    check('cuda-0', 'encode', 'passed', { backend: 'NVIDIA NVENC / CUDA' }),
    check('cuda-0', 'decode', 'passed', { backend: 'NVIDIA NVENC / CUDA', codec: 'HEVC Main 10' })
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].checks.length, 2);
});

test('CPU and system-managed backends without a device ID remain distinct', () => {
  const groups = groupServerChecks([
    check(null, 'encode', 'passed', { backend: 'CPU', hardware: false, deviceScope: 'none', deviceLabel: null }),
    check(null, 'encode', 'passed', { backend: 'Apple VideoToolbox', deviceScope: 'system', deviceLabel: null }),
    check(null, 'encode', 'unavailable', { backend: 'VA-API', deviceScope: 'system', deviceLabel: null })
  ]);
  assert.equal(groups.length, 3);
  assert.equal(new Set(groups.map(group => group.key)).size, 3);
});

test('a summary names absent backends instead of listing them, and puts graphics hardware first', () => {
  const summary = summarizeServerChecks([
    check(null, 'encode', 'passed', { backend: 'CPU', hardware: false, deviceScope: 'none', deviceLabel: null }),
    check(null, 'encode', 'unsupported', { backend: 'VA-API', deviceScope: 'system', deviceLabel: null, detail: 'compatibility.encoderUnavailable' }),
    check(null, 'decode', 'unsupported', { backend: 'VA-API', deviceScope: 'system', deviceLabel: null, detail: 'compatibility.hardwareBackendUnavailable' }),
    check('cuda-0', 'encode', 'passed', { backend: 'NVIDIA NVENC / CUDA', deviceLabel: 'NVIDIA GPU 0' }),
    check('cuda-0', 'decode', 'failed', { backend: 'NVIDIA NVENC / CUDA', deviceLabel: 'NVIDIA GPU 0', detail: 'compatibility.decodeFailed' })
  ]);
  assert.deepEqual(summary.missing, ['VA-API']);
  assert.deepEqual(summary.devices.map(device => device.name), ['NVIDIA GPU 0', 'CPU']);
  assert.deepEqual(summary.devices[0].problems.map(problem => [problem.operation, problem.detail]), [['decode', 'compatibility.decodeFailed']]);
  assert.deepEqual(summary.hardware, ['NVIDIA GPU 0']);
  assert.equal(summary.software, true);
  assert.equal(summary.devices[0].checks.get('H.264 decode').status, 'failed');
});

test('a device whose tests ran and failed is still shown, and counts for nothing', () => {
  const summary = summarizeServerChecks([
    check('vaapi-renderD128', 'encode', 'failed', { detail: 'compatibility.hardwareTestFailed' }),
    check('vaapi-renderD128', 'decode', 'failed', { detail: 'compatibility.hardwareTestFailed' })
  ]);
  assert.equal(summary.devices.length, 1);
  assert.equal(summary.devices[0].problems.length, 2);
  assert.deepEqual(summary.hardware, []);
  assert.equal(summary.software, false);
});
