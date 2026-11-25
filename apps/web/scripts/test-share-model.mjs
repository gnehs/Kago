import assert from 'node:assert/strict';
import { test } from 'node:test';
import { groupShares, parseDownloadLimit, parseShareMode, resolveExpiry, shareEnd, shareExpiry, shareFigure, shareName, shareProblem, shareState, spanOf } from '../src/lib/shareModel.ts';

const NOW = 1_800_000_000;
const HOUR = 3600;
const DAY = 86400;
let serial = 0;
const share = (patch = {}) => ({
  id: `s${++serial}`, root_id: 'r1', path: '/Docs/a.pdf', permission_json: '{"mode":"download"}', expires_at: null, max_downloads: null,
  download_count: 0, has_password: false, created_by: 'u1', disabled: 0, created_at: NOW - serial, updated_at: NOW, token: 't', creator: { id: 'u1', email: 'a@b.c', display_name: '', avatar_at: null }, ...patch
});

test('a link works until it is disabled, runs out of time or reaches its limit, in that order of precedence', () => {
  assert.equal(shareState(share(), NOW), 'active');
  assert.equal(shareState(share({ disabled: 1, expires_at: NOW - 1 }), NOW), 'disabled');
  assert.equal(shareState(share({ expires_at: NOW - 1, max_downloads: 1, download_count: 1 }), NOW), 'expired');
  assert.equal(shareState(share({ expires_at: NOW }), NOW), 'active');
  assert.equal(shareState(share({ max_downloads: 3, download_count: 2 }), NOW), 'active');
  assert.equal(shareState(share({ max_downloads: 3, download_count: 3 }), NOW), 'limit');
});

test('the mode is read from the permission, and an unreadable one is the default', () => {
  assert.equal(parseShareMode('{"mode":"upload_only"}'), 'upload_only');
  assert.equal(parseShareMode('{"mode":"view_only"}'), 'view_only');
  assert.equal(parseShareMode('nonsense'), 'download');
});

test('a span is counted in the unit it reads best in, never as zero', () => {
  assert.deepEqual(spanOf(20), { unit: 'minute', amount: 1 });
  assert.deepEqual(spanOf(59 * 60), { unit: 'minute', amount: 59 });
  assert.deepEqual(spanOf(HOUR), { unit: 'hour', amount: 1 });
  assert.deepEqual(spanOf(DAY - 1), { unit: 'hour', amount: 23 });
  assert.deepEqual(spanOf(7 * DAY), { unit: 'day', amount: 7 });
  assert.deepEqual(spanOf(-5 * DAY), { unit: 'day', amount: 5 });
});

test('an expiry under a day away is soon; one that has passed counts back from now', () => {
  assert.deepEqual(shareExpiry(share(), NOW), { kind: 'never' });
  assert.deepEqual(shareExpiry(share({ expires_at: NOW + HOUR }), NOW), { kind: 'in', span: { unit: 'hour', amount: 1 }, soon: true });
  assert.deepEqual(shareExpiry(share({ expires_at: NOW + DAY }), NOW), { kind: 'in', span: { unit: 'day', amount: 1 }, soon: false });
  assert.deepEqual(shareExpiry(share({ expires_at: NOW - 5 * DAY }), NOW), { kind: 'ago', span: { unit: 'day', amount: 5 } });
});

test('a dead link gives the reason it is dead, a live one none', () => {
  assert.equal(shareEnd(share(), NOW), null);
  assert.deepEqual(shareEnd(share({ disabled: 1 }), NOW), { state: 'disabled' });
  assert.deepEqual(shareEnd(share({ expires_at: NOW - 5 * DAY }), NOW), { state: 'expired', span: { unit: 'day', amount: 5 } });
  assert.deepEqual(shareEnd(share({ max_downloads: 3, download_count: 3 }), NOW), { state: 'limit', used: 3, max: 3 });
});

test('the download figure shows a limit, or a count once there is one, and nothing for a drop box', () => {
  assert.deepEqual(shareFigure(share({ max_downloads: 10, download_count: 4 })), { kind: 'limit', used: 4, max: 10 });
  assert.deepEqual(shareFigure(share({ download_count: 12 })), { kind: 'count', count: 12 });
  assert.equal(shareFigure(share()), null);
  assert.equal(shareFigure(share({ permission_json: '{"mode":"upload_only"}', download_count: 5 })), null);
});

test('a link is named for its item, or for the location when the whole location is shared', () => {
  assert.equal(shareName({ path: '/Docs/a.pdf' }, 'Documents'), 'a.pdf');
  assert.equal(shareName({ path: '/' }, 'Documents'), 'Documents');
  assert.equal(shareName({ path: '/Café.txt' }, 'x'), 'Café.txt');
});

test('shares split into those that work and those that do not, newest first, and filter by name', () => {
  const names = { r1: 'Docs', r2: 'Photos' };
  const list = [
    share({ id: 'old-live', path: '/Report.pdf', created_at: 10 }),
    share({ id: 'new-live', path: '/IMG_1.jpg', root_id: 'r2', created_at: 30 }),
    share({ id: 'dead', path: '/Report old.pdf', expires_at: NOW - 1, created_at: 20 }),
    share({ id: 'whole', path: '/', root_id: 'r2', disabled: 1, created_at: 5 })
  ];
  const all = groupShares(list, (id) => names[id], '', NOW);
  assert.deepEqual(all.active.map((s) => s.id), ['new-live', 'old-live']);
  assert.deepEqual(all.dead.map((s) => s.id), ['dead', 'whole']);
  const found = groupShares(list, (id) => names[id], '  REPORT ', NOW);
  assert.deepEqual([found.active.map((s) => s.id), found.dead.map((s) => s.id)], [['old-live'], ['dead']]);
  assert.deepEqual(groupShares(list, (id) => names[id], 'photos', NOW).dead.map((s) => s.id), ['whole']);
  assert.deepEqual(groupShares([], () => '', '', NOW), { active: [], dead: [] });
});

test('a validity is a number of days from now, never, or a date that has to be ahead', () => {
  assert.deepEqual(resolveExpiry('7', null, NOW), { at: NOW + 7 * DAY });
  assert.deepEqual(resolveExpiry('never', null, NOW), { at: null });
  assert.deepEqual(resolveExpiry('custom', null, NOW), { problem: 'missing' });
  assert.deepEqual(resolveExpiry('custom', NOW - 1, NOW), { problem: 'past' });
  assert.deepEqual(resolveExpiry('custom', NOW + DAY, NOW), { at: NOW + DAY });
});

test('a download limit is a whole number of one or more', () => {
  assert.equal(parseDownloadLimit('10'), 10);
  for (const bad of ['', ' ', '0', '-1', '1.5', 'abc']) assert.equal(parseDownloadLimit(bad), null, bad);
});

test('the form says what stops it, one thing at a time', () => {
  const ok = { item: { kind: 'file' }, mode: 'download', password: null, limit: null, expiry: { at: null } };
  assert.equal(shareProblem(ok), null);
  assert.equal(shareProblem({ ...ok, item: null }), 'no-item');
  assert.equal(shareProblem({ ...ok, mode: 'upload_only' }), 'file-needs-folder');
  assert.equal(shareProblem({ ...ok, item: { kind: 'folder' } }), 'folder-needs-file');
  assert.equal(shareProblem({ ...ok, item: { kind: 'folder' }, mode: 'upload_only' }), null);
  assert.equal(shareProblem({ ...ok, item: { kind: 'folder', readonly: true }, mode: 'upload_only' }), 'readonly-drop-box');
  assert.equal(shareProblem({ ...ok, item: { kind: 'file', readonly: true } }), null);
  assert.equal(shareProblem({ ...ok, password: 'short' }), 'password-short');
  assert.equal(shareProblem({ ...ok, password: 'long enough' }), null);
  assert.equal(shareProblem({ ...ok, limit: '0' }), 'limit-invalid');
  assert.equal(shareProblem({ ...ok, expiry: { problem: 'missing' } }), 'expiry-missing');
  assert.equal(shareProblem({ ...ok, expiry: { problem: 'past' } }), 'expiry-past');
  assert.equal(shareProblem({ ...ok, item: null, password: 'x' }), 'no-item');
});
