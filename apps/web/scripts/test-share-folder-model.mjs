import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crumbs, endsLink, failureOf, firstDirection, folderTotals, guessType, isFolderShare, layoutFor, locationSearch, neighbours, parseLocation, shareEndpoint, toggleSort, viewerKind } from '../src/lib/shareFolderModel.ts';

const file = (name, type = 'image/jpeg', patch = {}) => ({ name, path: `/${name}`, kind: 'file', size: 100, mtime: 1, type, previewable: type.startsWith('image/') || type === 'application/pdf', ...patch });
const folder = (name) => ({ name, path: `/${name}`, kind: 'folder', size: 0, mtime: 1, type: '', previewable: false });

test('a folder to look through is a folder link that is not a drop box', () => {
  assert.equal(isFolderShare({ kind: 'folder', mode: 'download' }), true);
  assert.equal(isFolderShare({ kind: 'folder', mode: 'view_only' }), true);
  assert.equal(isFolderShare({ kind: 'folder', mode: 'upload_only' }), false);
  assert.equal(isFolderShare({ kind: 'file', mode: 'download' }), false);
  assert.equal(isFolderShare({ mode: 'download' }), false);
});

test('the address holds the folder and the open file, and nothing for the shared folder itself', () => {
  assert.deepEqual(parseLocation(''), { path: '/', open: null });
  assert.deepEqual(parseLocation('?path=/Trip/Day%201&open=IMG_1.jpg'), { path: '/Trip/Day 1', open: 'IMG_1.jpg' });
  assert.equal(locationSearch({ path: '/', open: null }), '');
  assert.equal(locationSearch({ path: '/Trip/Day 1', open: 'IMG 1.jpg' }), '?path=/Trip/Day+1&open=IMG+1.jpg');
  const there = { path: '/a b/c&d', open: 'x#y.png' };
  assert.deepEqual(parseLocation(locationSearch(there)), there);
});

test('a path that leaves the shared folder, or a name that is a path, is not taken for a location', () => {
  assert.deepEqual(parseLocation('?path=/a/../..'), { path: '/', open: null });
  assert.deepEqual(parseLocation('?path=../etc&open=../x'), { path: '/', open: null });
  assert.deepEqual(parseLocation('?open='), { path: '/', open: null });
  assert.deepEqual(parseLocation('?path=//a///b/./'), { path: '/a/b', open: null });
});

test('the breadcrumbs start at the share and go no higher', () => {
  assert.deepEqual(crumbs('Trip photos', '/'), [{ label: 'Trip photos', path: '/' }]);
  assert.deepEqual(crumbs('Trip photos', '/Day 1/Beach'), [{ label: 'Trip photos', path: '/' }, { label: 'Day 1', path: '/Day 1' }, { label: 'Beach', path: '/Day 1/Beach' }]);
});

test('a folder that is mostly pictures and films is a grid, any other a list', () => {
  assert.equal(layoutFor([]), 'list');
  assert.equal(layoutFor([folder('a'), folder('b')]), 'list');
  assert.equal(layoutFor([file('a.jpg'), file('b.jpg'), file('c.mp4', 'video/mp4'), file('d.pdf', 'application/pdf')]), 'grid');
  assert.equal(layoutFor([file('a.jpg'), file('b.pdf', 'application/pdf'), file('c.zip', 'application/zip')]), 'list');
  assert.equal(layoutFor([folder('x'), file('a.jpg'), file('b.jpg')]), 'grid');
});

test('sorting a column that is in use turns it round; another starts the way the file browser starts it', () => {
  assert.equal(firstDirection('name'), 'asc');
  assert.equal(firstDirection('mtime'), 'desc');
  assert.equal(firstDirection('size'), 'desc');
  assert.deepEqual(toggleSort({ by: 'name', direction: 'asc' }, 'name'), { by: 'name', direction: 'desc' });
  assert.deepEqual(toggleSort({ by: 'name', direction: 'desc' }, 'size'), { by: 'size', direction: 'desc' });
  assert.deepEqual(toggleSort({ by: 'size', direction: 'desc' }, 'type'), { by: 'type', direction: 'asc' });
});

test('what a folder holds is counted, and its size told only when it is all known', () => {
  assert.deepEqual(folderTotals([file('a.jpg'), file('b.jpg')], 2), { count: 2, bytes: 200 });
  assert.deepEqual(folderTotals([file('a.jpg')], 500), { count: 500, bytes: null });
  assert.deepEqual(folderTotals([folder('d'), file('a.jpg')], 2), { count: 2, bytes: null });
  assert.deepEqual(folderTotals([], 0), { count: 0, bytes: 0 });
});

test('the viewer draws what the server will send inline, and a name alone is guessed only as far as that', () => {
  assert.equal(viewerKind('image/webp'), 'image');
  assert.equal(viewerKind('video/mp4'), 'video');
  assert.equal(viewerKind('audio/flac'), 'audio');
  assert.equal(viewerKind('application/pdf'), 'pdf');
  assert.equal(viewerKind('text/plain'), 'text');
  assert.equal(viewerKind('text/html'), null);
  assert.equal(viewerKind('application/zip'), null);
  assert.equal(guessType('Holiday.JPG'), 'image/jpeg');
  assert.equal(guessType('notes.txt'), 'text/plain');
  assert.equal(guessType('page.html'), '');
  assert.equal(guessType('.png'), '');
  assert.equal(guessType('README'), '');
});

test('the viewer steps through the files that can be looked at, skipping the rest, and stops at either end', () => {
  const items = [folder('d'), file('a.jpg'), file('b.zip', 'application/zip'), file('c.jpg'), file('d.jpg')];
  assert.deepEqual(neighbours(items, 'a.jpg').previous, null);
  assert.equal(neighbours(items, 'a.jpg').next.name, 'c.jpg');
  const middle = neighbours(items, 'c.jpg');
  assert.equal(middle.previous.name, 'a.jpg');
  assert.equal(middle.next.name, 'd.jpg');
  assert.equal(middle.position, 2);
  assert.equal(middle.count, 3);
  assert.equal(neighbours(items, 'd.jpg').next, null);
});

test('a file that has not been read yet has no neighbours and no place', () => {
  assert.deepEqual(neighbours([file('a.jpg')], 'z.jpg'), { position: null, count: 1, previous: null, next: null });
  assert.equal(neighbours([file('é.jpg')], 'é.jpg'.normalize('NFC')).position, 1);
});

test('every error a link can give is told to the visitor as one of a few things', () => {
  assert.equal(failureOf('SHARE_EXPIRED'), 'expired');
  assert.equal(failureOf('SHARE_LIMIT_REACHED'), 'limit');
  assert.equal(failureOf('SHARE_PASSWORD_REQUIRED'), 'password');
  assert.equal(failureOf('SHARE_OWNER_ACCESS_REVOKED'), 'revoked');
  assert.equal(failureOf('SHARE_TARGET_NOT_FOLDER'), 'changed');
  assert.equal(failureOf('PATH_NOT_FOUND'), 'missing');
  assert.equal(failureOf('SHARE_ZIP_TOO_LARGE'), 'too-large');
  assert.equal(failureOf('SHARE_ZIP_BUSY'), 'busy');
  assert.equal(failureOf('PREVIEW_UNSUPPORTED'), 'unsupported');
  assert.equal(failureOf('SHARE_DOWNLOAD_FORBIDDEN'), 'forbidden');
  assert.equal(failureOf('NETWORK'), 'other');
  assert.equal(failureOf(undefined), 'other');
});

test('what ends a link for good is told apart from what only stops one request', () => {
  for (const failure of ['gone', 'expired', 'limit', 'revoked', 'changed']) assert.equal(endsLink(failure), true, failure);
  for (const failure of ['missing', 'too-large', 'busy', 'unsupported', 'password', 'other']) assert.equal(endsLink(failure), false, failure);
});

test('the address of what is asked for carries the path as it is', () => {
  assert.equal(shareEndpoint('tok', 'zip'), '/s/tok/zip');
  assert.equal(shareEndpoint('tok', 'zip', { path: '/Day 1' }), '/s/tok/zip?path=/Day+1');
  assert.equal(shareEndpoint('tok', 'list', { path: '/', offset: 200, limit: 200, sortBy: 'mtime', direction: 'desc' }), '/s/tok/list?path=/&offset=200&limit=200&sortBy=mtime&direction=desc');
  assert.equal(shareEndpoint('tok', 'thumbnail', { path: '/a&b.jpg', size: 'small', v: 5 }), '/s/tok/thumbnail?path=/a%26b.jpg&size=small&v=5');
});
