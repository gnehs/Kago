import assert from 'node:assert/strict';
import { test } from 'node:test';
import { actorOf, agentShort, agentText, ANY_DATE, arrangeDays, auditParams, cursorOf, describe, factsOf, foldersTail, isFiltered, parseUserAgent, placeOf, rangeSeconds, sentencedActions, timeSpan, viewFilter } from '../src/lib/auditModel.ts';
import { addDays, daysAgo, startOfDay } from '../src/lib/days.ts';

let serial = 0;
const row = (patch = {}) => ({
  id: `a${++serial}`, actor_type: 'user', actor_id: 'u1', actor_name: 'Mei-Ling Chen', actor_email: 'meiling@x.test', action: 'upload', category: 'file', signal: 'normal',
  root_id: 'r1', root_name: 'Documents', root_slug: 'documents', path: '/Contracts/NDA.docx', target_json: null, result: 'success', ip: '203.0.113.42', user_agent: null, created_at: 1_800_000_000, burst: null, ...patch
});
const target = (value) => JSON.stringify(value);
const names = (extra = {}) => ({
  users: new Map([['u2', 'Kenji Watanabe']]), groups: new Map([['g1', 'Media editors']]), roots: new Map([['r1', 'Documents'], ['r2', 'Photos']]), slugs: new Map([['photos', 'Photos']]), ...extra
});
const NOW = 1_800_000_000;

test('the view switch asks the server for what it names, and leaves out the noise except where noise is the point', () => {
  assert.deepEqual(viewFilter('important'), { important: true });
  assert.deepEqual(viewFilter('sign_in'), { category: 'sign_in' });
  assert.deepEqual(viewFilter('file'), { category: 'file', important: true });
  assert.deepEqual(viewFilter('problems'), { result: 'failure,denied', important: true });
  assert.deepEqual(viewFilter('all'), {});
  assert.deepEqual(viewFilter('task'), { category: 'task', important: true });
});

test('a page is asked for with the view, person, dates and search, and continues after the last row shown', () => {
  const scope = { view: 'file', actor: 'u1', dates: { kind: 'preset', preset: 'today' }, query: '  nda  ' };
  const params = auditParams(scope, NOW, '1799999000:a9', 100);
  assert.equal(params.get('limit'), '100');
  assert.equal(params.get('category'), 'file');
  assert.equal(params.get('important'), 'true');
  assert.equal(params.get('actor'), 'u1');
  assert.equal(params.get('from'), String(startOfDay(NOW)));
  assert.equal(params.get('q'), 'nda');
  assert.equal(params.get('before'), '1799999000:a9');
  const plain = auditParams({ view: 'all', actor: '', dates: ANY_DATE, query: '' }, NOW);
  assert.deepEqual([...plain.keys()], ['limit']);
  assert.equal(auditParams({ ...scope, query: 'x'.repeat(300) }, NOW).get('q').length, 100);
  assert.equal(cursorOf({ created_at: 17, id: 'abc' }), '17:abc');
  assert.equal(isFiltered({ view: 'all', actor: '', dates: ANY_DATE, query: ' ' }), false);
  assert.equal(isFiltered({ view: 'all', actor: 'system', dates: ANY_DATE, query: '' }), true);
});

test('date ranges are whole local days, the last one included', () => {
  assert.deepEqual(rangeSeconds(ANY_DATE, NOW), {});
  assert.deepEqual(rangeSeconds({ kind: 'preset', preset: 'yesterday' }, NOW), { from: addDays(NOW, -1), to: startOfDay(NOW) });
  assert.equal(rangeSeconds({ kind: 'preset', preset: 'week' }, NOW).from, addDays(NOW, -6));
  const custom = rangeSeconds({ kind: 'custom', from: '2026-11-02', to: '2026-11-03' }, NOW);
  assert.equal(custom.from, new Date(2026, 10, 2).getTime() / 1000);
  assert.equal(custom.to, new Date(2026, 10, 4).getTime() / 1000);
  assert.deepEqual(rangeSeconds({ kind: 'custom', from: '', to: 'nonsense' }, NOW), {});
  assert.deepEqual(Object.keys(rangeSeconds({ kind: 'custom', from: '2026-11-02', to: '' }, NOW)), ['from']);
});

test('rows are listed under the day they were written, and a day with nothing in it is not there', () => {
  const noon = startOfDay(NOW) + 12 * 3600;
  const rows = [row({ created_at: noon }), row({ created_at: noon - 3600 }), row({ created_at: addDays(noon, -1) }), row({ created_at: addDays(noon, -5) + 12 * 3600 }), row({ created_at: addDays(noon, -5) + 3600 })];
  const days = arrangeDays(rows, noon);
  assert.deepEqual(days.map((day) => [day.name, day.rows.length]), [['today', 2], ['yesterday', 1], ['date', 2]]);
  assert.equal(days[2].day, addDays(noon, -5));
  assert.equal(daysAgo(addDays(noon, -1), noon), 1);
  assert.deepEqual(arrangeDays([], noon), []);
  // Pages arrive one after another; the second page's first day is the first page's last.
  assert.equal(arrangeDays([...rows.slice(0, 2), ...rows.slice(1, 2)], noon).length, 1);
});

test('browsers are read for the common cases and left as they came otherwise', () => {
  const firefox = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
  assert.deepEqual(parseUserAgent(firefox), { browser: 'Firefox', version: '132', os: 'Windows', device: null });
  assert.equal(agentText('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15'), 'Safari 17 · macOS');
  assert.equal(agentText('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'), 'Chrome 131 · macOS');
  assert.equal(agentText('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.2903.51'), 'Edge 131 · Windows');
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  assert.equal(agentText(ipad), 'Safari 17 · iPadOS');
  assert.equal(agentShort(ipad), 'Safari · iPad');
  assert.equal(agentText('Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1'), 'Chrome 131 · iOS');
  assert.equal(agentText('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'), 'Chrome 131 · Android');
  assert.equal(agentText('curl/8.7.1'), 'curl 8');
  assert.equal(agentText('SomethingOdd 1.0 (custom)'), 'SomethingOdd 1.0 (custom)');
  assert.equal(agentShort('SomethingOdd 1.0 (custom)'), null);
  assert.equal(parseUserAgent(null), null);
  assert.equal(agentText('  '), null);
});

test('who did it: a person, a share link, the server, or a stranger', () => {
  assert.deepEqual(actorOf(row()), { kind: 'user', name: 'Mei-Ling Chen' });
  assert.deepEqual(actorOf(row({ actor_name: null })), { kind: 'user', name: 'meiling@x.test' });
  assert.deepEqual(actorOf(row({ actor_name: null, actor_email: null })), { kind: 'deleted_user' });
  assert.deepEqual(actorOf(row({ actor_type: 'share_link', actor_name: null, actor_email: null })), { kind: 'share_link' });
  assert.deepEqual(actorOf(row({ actor_type: 'system', actor_name: null, action: 'sync_job_skipped' })), { kind: 'system' });
  assert.deepEqual(actorOf(row({ actor_type: 'system', actor_name: null, action: 'login_failed' })), { kind: 'someone' });
  assert.deepEqual(actorOf(row({ actor_type: 'system', actor_name: null, action: 'request_denied' })), { kind: 'someone' });
});

test('every action has a sentence, and a sentence names only what it can be given', () => {
  // The type of the table is Record<AuditAction, …>, so the typecheck is what fails when the contract gains an action; this runs each there is.
  assert.ok(sentencedActions.length > 70);
  for (const action of sentencedActions) {
    const sentence = describe(row({ action }), names());
    assert.ok(sentence.id, action);
    assert.ok(Array.isArray(sentence.tail), action);
  }
  assert.equal(describe(row({ action: 'dropped_long_ago' }), names()).id, 'unknown');
  assert.deepEqual(describe(row({ action: 'dropped_long_ago' }), names()).tail, ['dropped_long_ago']);
});

test('a file action reads as what happened with where after it, and a run as the folders it covered', () => {
  const upload = describe(row(), names());
  assert.deepEqual([upload.id, upload.tail], ['upload', ['Documents/Contracts/NDA.docx']]);
  const burst = { id: 'b1', count: 212, first_at: 1, folders: [{ root_id: 'r2', path: '/Family' }], folders_truncated: false };
  const run = describe(row({ burst }), names());
  assert.deepEqual([run.id, run.tail], ['upload_many', ['Photos/Family']]);
  assert.deepEqual(foldersTail({ ...burst, folders: [{ root_id: 'r2', path: '/A' }, { root_id: 'r2', path: '/B' }, { root_id: null, path: '/C' }] }, names()), { folders: 3, more: false });
  assert.deepEqual(foldersTail({ ...burst, folders_truncated: true }, names()), { folders: 1, more: true });
  assert.equal(foldersTail({ ...burst, folders: [] }, names()), null);
  assert.equal(placeOf(row({ root_name: null, root_id: 'gone' }), names()), '/Contracts/NDA.docx'.slice(0));
  assert.equal(placeOf(row({ path: '/' }), names()), 'Documents');
  assert.equal(placeOf(row({ path: null, root_id: null, root_name: null }), names()), null);
});

test('a folder a visitor downloaded as a zip says where it was and how much it held', () => {
  const zip = describe(row({ action: 'download_zip_via_share', target_json: JSON.stringify({ files: 12, bytes: 3456 }) }), names());
  assert.deepEqual([zip.id, zip.tail], ['download_zip_via_share', ['Documents/Contracts/NDA.docx', { archive: { files: 12, bytes: 3456 } }]]);
  assert.deepEqual(describe(row({ action: 'download_zip_via_share', target_json: null }), names()).tail, ['Documents/Contracts/NDA.docx']);
});

test('people, groups and places are named from what is known now, and from the row where they are gone', () => {
  const added = describe(row({ action: 'group_member_add', root_id: null, path: null, target_json: target({ groupId: 'g1', userId: 'u2' }) }), names());
  assert.deepEqual([added.id, added.slots], ['group_member_add', { person: 'Kenji Watanabe', group: 'Media editors' }]);
  const gone = describe(row({ action: 'group_member_add', target_json: target({ groupId: 'g9', userId: 'u9' }) }), names());
  assert.deepEqual(gone.slots, { person: undefined, group: undefined });
  const deleted = describe(row({ action: 'group_delete', target_json: target({ id: 'g9', name: 'Old group' }) }), names());
  assert.deepEqual(deleted.slots, { group: 'Old group' });
  const created = describe(row({ action: 'user_create', target_json: target({ id: 'u9', email: 'new@x.test', display_name: 'New Person' }) }), names());
  assert.deepEqual(created.slots, { person: 'New Person' });
  const copy = describe(row({ action: 'copy', target_json: target({ rootSlug: 'photos', path: '/Trip/a.jpg' }) }), names());
  assert.deepEqual(copy.slots, { path: 'Documents/Contracts/NDA.docx', to: 'Photos/Trip' });
  const rename = describe(row({ action: 'rename', target_json: target({ to: '/Contracts/NDA v2.docx' }) }), names());
  assert.deepEqual(rename.slots, { path: 'Documents/Contracts/NDA.docx', to: 'NDA v2.docx' });
});

test('a permission change says who may do what where, and a rule taken away says so', () => {
  const rule = { principal_type: 'group', principal_id: 'g1', root_id: 'r2', level: 'edit' };
  const set = describe(row({ action: 'permission_change', root_id: 'r2', root_name: 'Photos', path: null, target_json: target(rule) }), names());
  assert.deepEqual([set.id, set.slots], ['permission_edit', { who: 'Media editors', place: 'Photos' }]);
  assert.equal(describe(row({ action: 'permission_change', root_id: 'r2', root_name: 'Photos', path: null, target_json: target({ ...rule, level: 'view' }) }), names()).id, 'permission_view');
  const taken = describe(row({ action: 'permission_change', root_id: 'r2', root_name: 'Photos', path: null, target_json: target({ principalType: 'user', principalId: 'u2', deleted: true }) }), names());
  assert.deepEqual([taken.id, taken.slots.who], ['permission_remove', 'Kenji Watanabe']);
  const dropped = describe(row({ action: 'permission_change', actor_type: 'system', root_id: 'r2', root_name: 'Photos', path: '/Old', target_json: target({ principalType: 'user', principalId: 'u2', deleted: true, note: 'Permissions are set per location' }) }), names());
  assert.deepEqual([dropped.id, dropped.tail], ['permission_dropped', ['/Old']]);
});

test('a refusal says what was refused, by what it carries', () => {
  const refused = (value, patch = {}) => describe(row({ action: 'permission_denied', result: 'denied', target_json: target(value), ...patch }), names()).id;
  assert.equal(refused({ action: 'admin' }), 'denied_admin');
  assert.equal(refused({ action: 'shelf_access', shelfId: 's' }), 'denied_shelf');
  assert.equal(refused({ action: 'share_access', shelfId: 's' }), 'denied_share');
  assert.equal(refused({ action: 'task_access' }), 'denied_task');
  assert.equal(refused({ action: 'shared_external_app' }), 'denied_shared_app');
  assert.equal(refused({ level: 'edit', reason: 'No permission' }), 'denied_edit');
  assert.equal(refused({ level: 'view' }), 'denied_view');
  assert.equal(refused({}, { target_json: null }), 'denied');
});

test('the sign-in sentences carry the address tried and how it was done', () => {
  const failed = describe(row({ action: 'login_failed', actor_type: 'system', target_json: target({ email: 'priya@example.test' }) }), names());
  assert.deepEqual([failed.id, failed.tail], ['login_failed', ['priya@example.test']]);
  assert.equal(describe(row({ action: 'login_failed', actor_type: 'system', target_json: target({ method: 'sso', code: 'X' }) }), names()).id, 'login_failed_sso');
  const ipad = 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
  const signedIn = describe(row({ action: 'login_success', user_agent: ipad }), names());
  assert.deepEqual([signedIn.id, signedIn.tail], ['login_success', ['Safari · iPad']]);
  assert.equal(describe(row({ action: 'login_success', target_json: target({ method: 'sso' }) }), names()).id, 'login_success_sso');
  assert.equal(describe(row({ action: 'sso_unlink', actor_id: 'u1', target_json: target({ userId: 'u1' }) }), names()).id, 'sso_unlink_self');
  assert.equal(describe(row({ action: 'sso_unlink', actor_id: 'u1', target_json: target({ userId: 'u2' }) }), names()).id, 'sso_unlink');
  assert.equal(describe(row({ action: 'user_disable', target_json: target({ userId: 'u2', disabled: false }) }), names()).id, 'user_enable');
});

test('what a task was is carried to the component by its type, and an emptied Trash says how much only when it was more than one', () => {
  assert.deepEqual(describe(row({ action: 'create_task', target_json: target({ type: 'copy' }) }), names()).tail, [{ taskType: 'copy' }]);
  assert.equal(describe(row({ action: 'task_failed', actor_type: 'system', target_json: target({ type: 'copy' }) }), names()).id, 'task_failed_system');
  assert.equal(describe(row({ action: 'task_failed', target_json: target({ type: 'copy' }) }), names()).id, 'task_failed');
  const emptied = describe(row({ action: 'trash_empty', path: null, root_id: null, target_json: target({ count: 9 }) }), names());
  assert.deepEqual([emptied.id, emptied.slots], ['trash_empty_many', { count: '9' }]);
  assert.equal(describe(row({ action: 'trash_empty', path: null, target_json: target({ count: 1 }) }), names()).id, 'trash_empty');
});

test('an opened row tells where it came from and what it was about in words, never its JSON', () => {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0';
  const facts = factsOf(row({ action: 'rename', user_agent: ua, target_json: target({ to: '/Contracts/NDA v2.docx' }) }), names());
  assert.deepEqual(facts, [
    { label: 'path', value: 'Documents/Contracts/NDA.docx' },
    { label: 'to', value: 'Documents/Contracts/NDA v2.docx' },
    { label: 'source', value: '203.0.113.42' },
    { label: 'browser', value: 'Firefox 132 · Windows' }
  ]);
  const request = factsOf(row({ action: 'request_denied', path: null, root_id: null, root_name: null, ip: null, target_json: target({ method: 'DELETE', route: '/api/fs/item', code: 'FORBIDDEN', statusCode: 403 }) }), names());
  assert.deepEqual(request, [{ label: 'reason', value: 'forbidden' }, { label: 'request', value: 'DELETE /api/fs/item' }]);
  assert.deepEqual(describe(row({ action: 'request_denied', actor_type: 'system', target_json: target({ code: 'NO_THUMB' }) }), names()).tail, []);
  assert.deepEqual(factsOf(row({ action: 'download_zip', path: null, target_json: target({ sources: [{ rootSlug: 'photos', path: '/a' }, { rootSlug: 'photos', path: '/b' }] }) }), names()).find((fact) => fact.label === 'sources'), { label: 'sources', value: 'Photos/a, Photos/b' });
});

test('a run is timed from its first row to its last', () => {
  assert.deepEqual(timeSpan(row({ created_at: 50, burst: { id: 'b', count: 3, first_at: 20, folders: [], folders_truncated: false } })), { from: 20, to: 50 });
  assert.deepEqual(timeSpan(row({ created_at: 50 })), { from: 50, to: 50 });
});
