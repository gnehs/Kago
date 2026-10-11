import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupServerChecks } from '../src/features/admin/serverCompatibility.ts';

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
