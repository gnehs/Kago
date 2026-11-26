import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertProblem, foldersOverlap, startingFolder } from '../src/lib/convertModel.ts';

const folder = (rootSlug, path = '/') => ({ rootSlug, path });
const ok = { name: 'Phone clips', input: folder('media', '/Inbox'), destination: folder('backups', '/Clips'), destinationReadonly: false, extensions: 3, settingsValid: true };

test('a complete draft has no problem', () => {
  assert.equal(convertProblem(ok), null);
});

test('the first thing wrong is the one named, in the order a form is filled in', () => {
  assert.equal(convertProblem({ ...ok, name: '  ', input: null, extensions: 0 }), 'no-name');
  assert.equal(convertProblem({ ...ok, input: null, destination: null }), 'no-input');
  assert.equal(convertProblem({ ...ok, destination: null }), 'no-destination');
  assert.equal(convertProblem({ ...ok, destinationReadonly: true, extensions: 0 }), 'destination-readonly');
  assert.equal(convertProblem({ ...ok, extensions: 0, settingsValid: false }), 'no-extensions');
  assert.equal(convertProblem({ ...ok, settingsValid: false }), 'bad-settings');
});

test('a folder and one inside it overlap, in either order, and only within one location', () => {
  assert.equal(foldersOverlap(folder('media', '/A'), folder('media', '/A')), true);
  assert.equal(foldersOverlap(folder('media', '/A'), folder('media', '/A/B')), true);
  assert.equal(foldersOverlap(folder('media', '/A/B'), folder('media', '/A')), true);
  assert.equal(foldersOverlap(folder('media', '/'), folder('media', '/A')), true);
  assert.equal(foldersOverlap(folder('media', '/A'), folder('media', '/AB')), false);
  assert.equal(foldersOverlap(folder('media', '/A'), folder('backups', '/A')), false);
  assert.equal(convertProblem({ ...ok, input: folder('media', '/Clips'), destination: folder('media', '/Clips/Out') }), 'overlap');
});

test('a folder to put things in never starts in a location that is read-only', () => {
  const roots = [{ slug: 'archive', readonly: 1 }, { slug: 'media', readonly: 0 }];
  assert.deepEqual(startingFolder(null, roots, true), folder('media'));
  assert.deepEqual(startingFolder(null, roots), folder('archive'));
  assert.deepEqual(startingFolder(folder('archive', '/X'), roots, true), folder('archive', '/X'));
  assert.deepEqual(startingFolder(null, [{ slug: 'archive', readonly: 1 }], true), folder(''));
});
