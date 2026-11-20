import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error;
      return next(`${specifier}.ts`, context);
    }
  },
});
const { companionNames } = await import('../src/features/plugins/companions.ts');
const { parseHostMessage, parsePluginMessage } = await import('../../../packages/plugin-sdk/src/protocol.ts');

const PAIR = [{ replace: '_00_', with: '_10_' }, { replace: '_10_', with: '_00_' }];

test('either file of a pair names the other', () => {
  assert.deepEqual(companionNames('VID_20240414_135511_00_202.insv', PAIR), ['VID_20240414_135511_10_202.insv']);
  assert.deepEqual(companionNames('VID_20240414_135511_10_202.insv', PAIR), ['VID_20240414_135511_00_202.insv']);
});

test('a name without the piece names nothing, and only the first piece is swapped', () => {
  assert.deepEqual(companionNames('CAM_20260922093618_0009_D.OSV', PAIR), []);
  assert.deepEqual(companionNames('a_00_b_00_.insv', PAIR), ['a_10_b_00_.insv']);
});

test('no rule names the file itself, a folder above, or the same file twice', () => {
  assert.deepEqual(companionNames('x_00_.insv', [{ replace: '_00_', with: '_00_' }]), []);
  assert.deepEqual(companionNames('ab', [{ replace: 'ab', with: '..' }, { replace: 'ab', with: '.' }, { replace: 'a', with: 'c/' }]), []);
  assert.deepEqual(companionNames('ab', [{ replace: 'a', with: 'c' }, { replace: 'a', with: 'c' }]), ['cb']);
});

const theme = { mode: 'dark', tokens: {} };
const file = { name: 'a.insv', size: 10, type: 'application/octet-stream', mtime: 1 };
const init = (extra) => ({ kind: 'init', api: 1, file, locale: 'en', theme, focused: true, ...extra });

test('a read names a companion by a small index, or the opened file by none', () => {
  assert.deepEqual(parsePluginMessage({ kind: 'read', id: 1, start: 0, end: 4 }), { kind: 'read', id: 1, start: 0, end: 4 });
  assert.deepEqual(parsePluginMessage({ kind: 'read', id: 1, start: 0, end: 4, file: 0 }), { kind: 'read', id: 1, start: 0, end: 4 });
  assert.deepEqual(parsePluginMessage({ kind: 'read', id: 1, start: 0, end: 4, file: 2 }), { kind: 'read', id: 1, start: 0, end: 4, file: 2 });
  for (const bad of [-1, 1.5, 9, '1', 'b.insv', null]) assert.equal(parsePluginMessage({ kind: 'read', id: 1, start: 0, end: 4, file: bad }), null, String(bad));
});

test('init carries the companions found, and a host that sends none sends an empty list', () => {
  assert.deepEqual(parseHostMessage(init({})).companions, []);
  assert.deepEqual(parseHostMessage(init({ companions: [file] })).companions, [file]);
  assert.equal(parseHostMessage(init({ companions: [{ name: 'b' }] })), null);
  assert.equal(parseHostMessage(init({ companions: Array(9).fill(file) })), null);
  assert.equal(parseHostMessage(init({ companions: 'b.insv' })), null);
});
