import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseTask } from '../src/lib/taskModel.ts';
import { withSpeeds } from '../src/lib/taskSpeed.ts';

// One row of each task type, as a sandbox server sent them over GET /api/tasks.
const rows = JSON.parse(readFileSync(new URL('./task-rows.json', import.meta.url), 'utf8'));
const row = (type, status) => rows.find((item) => item.type === type && (status === undefined || item.status === status));
const folder = (path) => ({ rootSlug: 'files', path });

test('every task type reads to the sources and destination its row holds', () => {
  const expected = {
    copy: [[folder('/copy-me.txt')], folder('/dst')],
    move: [[folder('/move-me.txt')], folder('/dst')],
    delete_to_trash: [[folder('/copy-me.txt')], null],
    delete: [[folder('/trash-me.txt')], null],
    // A trash task's sources name items of the Trash, not paths.
    restore_trash: [[{ rootSlug: 'trash', path: JSON.parse(row('restore_trash').sources_json)[0].path }], null],
    empty_trash: [[{ rootSlug: 'trash', path: JSON.parse(row('empty_trash').sources_json)[0].path }], null],
    compress: [[folder('/a.txt'), folder('/b.txt')], folder('/files.zip')],
    // Its destination holds only the name the archive is given.
    download_zip: [[folder('/b.txt'), folder('/src')], null],
    extract: [[folder('/locked.zip')], folder('/')],
    // A sync's endpoints are in its job, not in a place it writes to.
    sync: [[folder('/src')], null],
    convert: [[folder('/clip.mp4')], folder('/dst')],
    remux: [[folder('/clip.mp4')], folder('/')],
  };
  for (const [type, [sources, destination]] of Object.entries(expected)) {
    const task = parseTask(row(type));
    assert.deepEqual(task.sources, sources, `${type} sources`);
    assert.deepEqual(task.destination, destination, `${type} destination`);
  }
  assert.equal(new Set(rows.map((item) => item.type)).size, Object.keys(expected).length);
});

test('a task keeps every other field and no longer carries the JSON strings', () => {
  const wire = row('extract', 'failed');
  const task = parseTask(wire);
  const { sources_json, destination, auth_snapshot_json, ...kept } = wire;
  assert.deepEqual({ ...task, sources: undefined, destination: undefined }, { ...kept, sources: undefined, destination: undefined });
  assert.equal(task.error_message, 'Archive password required');
  assert.ok(!('sources_json' in task) && !('auth_snapshot_json' in task));
  assert.deepEqual(task.sources, [folder('/locked.zip')]);
  assert.deepEqual(task.destination, folder('/'));
});

test('a row that cannot be read gives empty fields instead of throwing', () => {
  const base = row('copy');
  const parsed = (patch) => parseTask({ ...base, ...patch });
  for (const sources_json of ['not json', '', '{', 'null', '5', '{"rootSlug":"files","path":"/a"}']) {
    assert.deepEqual(parsed({ sources_json }).sources, [], `sources_json ${JSON.stringify(sources_json)}`);
  }
  for (const destination of ['not json', '', '{', 'null', '5', '[]', '"files"', '{"rootSlug":"files"}', '{"path":"/a"}', '{"rootSlug":"","path":"/a"}', '{"rootSlug":"files","path":""}', '{"rootSlug":1,"path":"/a"}', null]) {
    assert.equal(parsed({ destination }).destination, null, `destination ${JSON.stringify(destination)}`);
  }
  const mixed = parsed({ sources_json: JSON.stringify([folder('/a'), null, 3, { rootSlug: 'files' }, { rootSlug: 'files', path: '/b', extra: true }]) });
  assert.deepEqual(mixed.sources, [folder('/a'), folder('/b')]);
  assert.equal(mixed.status, base.status);
});

test('a row refreshed after a progress patch keeps its parsed fields and takes the new counts', () => {
  const wire = { ...row('copy'), status: 'running', total_bytes: 600, total_files: 3 };
  // The shape the server sends in a task.progress event.
  const patch = { processed_files: 2, processed_bytes: 400, current_path: '/dst/copy-me.txt' };
  const before = parseTask(wire);
  const after = parseTask({ ...wire, ...patch });
  assert.deepEqual(after.sources, before.sources);
  assert.deepEqual(after.destination, before.destination);
  assert.equal(after.processed_bytes, 400);
  assert.equal(after.current_path, '/dst/copy-me.txt');
});

test('a running task is given its speed after it has been seen moving', () => {
  const running = (processed_bytes) => parseTask({ ...row('copy'), status: 'running', total_bytes: 10000, processed_bytes });
  const [first] = withSpeeds([running(0)], 1_000_000);
  assert.equal(first.speed, undefined);
  const [second] = withSpeeds([running(3000)], 1_002_000);
  assert.equal(second.speed, 1500);
  assert.deepEqual(second.destination, folder('/dst'));
});
