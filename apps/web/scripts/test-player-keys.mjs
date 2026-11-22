import assert from 'node:assert/strict';
import { test } from 'node:test';

const { playerKeyAction } = await import('../src/components/kago/player-keys.ts');

// Stands in for an element: `closest` answers for the selectors the player asks about.
const element = ({ button = false, menu = false } = {}) => ({
  closest: (selector) => (selector === 'button' && button) || (selector === '[role=menu]' && menu) ? {} : null,
});
const press = (key, patch = {}) => ({ key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, target: element(), ...patch });

const VIDEO = { buttonsKeepArrows: true, info: true, fullscreen: true, next: true, previous: true };
const AUDIO = { lyrics: true, next: true, previous: true };

test('the shared keys play, seek, change the volume and mute', () => {
  for (const options of [VIDEO, AUDIO]) {
    assert.deepEqual(playerKeyAction(press(' '), options), { kind: 'toggle' });
    assert.deepEqual(playerKeyAction(press('k'), options), { kind: 'toggle' });
    assert.deepEqual(playerKeyAction(press('K'), options), { kind: 'toggle' });
    assert.deepEqual(playerKeyAction(press('ArrowLeft'), options), { kind: 'seek', by: -5 });
    assert.deepEqual(playerKeyAction(press('ArrowRight'), options), { kind: 'seek', by: 5 });
    assert.deepEqual(playerKeyAction(press('ArrowUp'), options), { kind: 'volume', by: 0.1 });
    assert.deepEqual(playerKeyAction(press('ArrowDown'), options), { kind: 'volume', by: -0.1 });
    assert.deepEqual(playerKeyAction(press('m'), options), { kind: 'mute' });
    assert.equal(playerKeyAction(press('x'), options), null);
  }
});

test('next and previous need Shift and somewhere to go', () => {
  assert.deepEqual(playerKeyAction(press('N', { shiftKey: true }), VIDEO), { kind: 'next' });
  assert.deepEqual(playerKeyAction(press('P', { shiftKey: true }), VIDEO), { kind: 'previous' });
  assert.equal(playerKeyAction(press('n'), VIDEO), null);
  assert.equal(playerKeyAction(press('N', { shiftKey: true }), { ...VIDEO, next: false }), null);
  assert.equal(playerKeyAction(press('P', { shiftKey: true }), { ...VIDEO, previous: false }), null);
});

test('a key whose shortcut the player lacks is left to the page', () => {
  assert.deepEqual(playerKeyAction(press('f'), VIDEO), { kind: 'fullscreen' });
  assert.equal(playerKeyAction(press('f'), AUDIO), null);
  assert.deepEqual(playerKeyAction(press('l'), AUDIO), { kind: 'lyrics' });
  assert.equal(playerKeyAction(press('l'), { ...AUDIO, lyrics: false }), null);
  assert.equal(playerKeyAction(press('l'), VIDEO), null);
  assert.equal(playerKeyAction(press('i'), AUDIO), null);
});

test('info answers to I with or without ⌘, but not with Shift or ⌥, nor inside a menu', () => {
  assert.deepEqual(playerKeyAction(press('i'), VIDEO), { kind: 'info' });
  assert.deepEqual(playerKeyAction(press('i', { metaKey: true }), VIDEO), { kind: 'info' });
  assert.deepEqual(playerKeyAction(press('i', { ctrlKey: true }), VIDEO), { kind: 'info' });
  assert.equal(playerKeyAction(press('I', { shiftKey: true }), VIDEO), null);
  assert.equal(playerKeyAction(press('i', { altKey: true }), VIDEO), null);
  assert.equal(playerKeyAction(press('i', { target: element({ menu: true }) }), VIDEO), null);
  // A focused button does not keep I.
  assert.deepEqual(playerKeyAction(press('i', { target: element({ button: true }) }), VIDEO), { kind: 'info' });
});

test('modifier keys and open menus keep every other key away from the player', () => {
  for (const options of [VIDEO, AUDIO]) {
    for (const modifier of ['metaKey', 'ctrlKey', 'altKey']) assert.equal(playerKeyAction(press(' ', { [modifier]: true }), options), null);
    assert.equal(playerKeyAction(press(' ', { target: element({ menu: true }) }), options), null);
    assert.equal(playerKeyAction(press('Escape', { target: element({ menu: true }) }), options), null);
  }
});

test('Escape is reported, so the player can keep it from closing the window while fullscreen', () => {
  assert.deepEqual(playerKeyAction(press('Escape'), VIDEO), { kind: 'escape' });
  assert.deepEqual(playerKeyAction(press('Escape', { target: element({ button: true }) }), VIDEO), { kind: 'escape' });
});

test('a focused video button keeps Space, Enter and the up and down arrows', () => {
  const onButton = { target: element({ button: true }) };
  for (const key of [' ', 'Enter', 'ArrowUp', 'ArrowDown']) assert.equal(playerKeyAction(press(key, onButton), VIDEO), null);
  assert.deepEqual(playerKeyAction(press('ArrowLeft', onButton), VIDEO), { kind: 'seek', by: -5 });
  assert.deepEqual(playerKeyAction(press('m', onButton), VIDEO), { kind: 'mute' });
});

test('a focused music button keeps only Space and Enter', () => {
  const onButton = { target: element({ button: true }) };
  for (const key of [' ', 'Enter']) assert.equal(playerKeyAction(press(key, onButton), AUDIO), null);
  assert.deepEqual(playerKeyAction(press('ArrowUp', onButton), AUDIO), { kind: 'volume', by: 0.1 });
  assert.deepEqual(playerKeyAction(press('ArrowDown', onButton), AUDIO), { kind: 'volume', by: -0.1 });
});
