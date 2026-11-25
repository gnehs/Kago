import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseTask } from '../src/lib/taskModel.ts';
import { groupTasks, taskCurrentName, taskDestinationName, taskSecondsLeft, taskSubject } from '../src/lib/taskLayout.ts';

const rows = JSON.parse(readFileSync(new URL('./task-rows.json', import.meta.url), 'utf8'));
const task = (type, patch = {}) => ({ ...parseTask(rows.find((item) => item.type === type)), ...patch });
const refs = (...paths) => paths.map((path) => ({ rootSlug: 'files', path }));
const made = (id, status, created_at) => ({ ...task('copy'), id, status, created_at });
const ids = (list) => list.map((item) => item.id);

test('a task is subject to its first source and how many more come with it', () => {
  assert.deepEqual(taskSubject(task('copy')), { name: 'copy-me.txt', more: 0 });
  assert.deepEqual(taskSubject(task('compress')), { name: 'a.txt', more: 1 });
  assert.deepEqual(taskSubject(task('download_zip')), { name: 'b.txt', more: 1 });
  for (const type of ['move', 'delete_to_trash', 'delete', 'extract', 'convert', 'remux', 'sync']) {
    assert.notEqual(taskSubject(task(type)), null, type);
  }
  assert.deepEqual(taskSubject(task('copy', { sources: refs('/Photos/2019/') })), { name: '2019', more: 0 });
});

test('trash tasks, empty sources and the root of a location have no subject', () => {
  assert.equal(taskSubject(task('restore_trash')), null);
  assert.equal(taskSubject(task('empty_trash')), null);
  assert.equal(taskSubject(task('copy', { sources: [] })), null);
  assert.equal(taskSubject(task('sync', { sources: refs('/') })), null);
});

test('the destination is named by its folder, or by the archive a compress writes', () => {
  assert.equal(taskDestinationName(task('copy')), 'dst');
  assert.equal(taskDestinationName(task('move')), 'dst');
  assert.equal(taskDestinationName(task('convert')), 'dst');
  assert.equal(taskDestinationName(task('compress')), 'files.zip');
  assert.equal(taskDestinationName(task('copy', { destination: { rootSlug: 'nas', path: '/backup/2025/' } })), '2025');
});

test('no destination name when there is none or it is the root of a location', () => {
  for (const type of ['delete_to_trash', 'delete', 'restore_trash', 'empty_trash', 'download_zip', 'sync']) {
    assert.equal(taskDestinationName(task(type)), null, type);
  }
  assert.equal(taskDestinationName(task('extract')), null);
  assert.equal(taskDestinationName(task('remux')), null);
});

test('a running task is on the bare name of its current path', () => {
  const running = (current_path, type = 'copy') => task(type, { status: 'running', current_path });
  assert.equal(taskCurrentName(running('/Photos/IMG_1.jpg')), 'IMG_1.jpg');
  assert.equal(taskCurrentName(running('secret.txt', 'extract')), 'secret.txt');
  assert.equal(taskCurrentName(running('docs\\inner/notes.txt', 'extract')), 'notes.txt');
  assert.equal(taskCurrentName(running('/Photos/')), 'Photos');
});

test('no current name when not running, counting, preparing, or unreported', () => {
  const running = (patch) => task('copy', { status: 'running', current_path: '/a/b.txt', ...patch });
  assert.equal(taskCurrentName(running({})), 'b.txt');
  assert.equal(taskCurrentName(running({ status: 'done' })), null);
  assert.equal(taskCurrentName(running({ status: 'queued' })), null);
  assert.equal(taskCurrentName(running({ phase: 'counting' })), null);
  assert.equal(taskCurrentName(running({ phase: 'preparing' })), null);
  assert.equal(taskCurrentName(running({ current_path: null })), null);
  assert.equal(taskCurrentName(running({ current_path: '/' })), null);
  assert.equal(taskCurrentName(task('sync', { status: 'running', current_path: '/src/2026/photo.jpg' })), 'photo.jpg');
});

test('seconds left come from the bytes still to go and the speed', () => {
  const running = (patch) => task('copy', { status: 'running', total_bytes: 1000, processed_bytes: 400, speed: 100, ...patch });
  assert.equal(taskSecondsLeft(running({})), 6);
  assert.equal(taskSecondsLeft(running({ speed: 70 })), 9);
  assert.equal(taskSecondsLeft(running({ processed_bytes: 1000 })), 0);
  assert.equal(taskSecondsLeft(running({ processed_bytes: 1200 })), 0);
});

test('seconds left are unknown without a speed, a byte total, or when not running', () => {
  const running = (patch) => task('copy', { status: 'running', total_bytes: 1000, processed_bytes: 400, speed: 100, ...patch });
  assert.equal(taskSecondsLeft(running({ speed: undefined })), null);
  assert.equal(taskSecondsLeft(running({ speed: 0 })), null);
  assert.equal(taskSecondsLeft(running({ total_bytes: 0 })), null);
  assert.equal(taskSecondsLeft(running({ phase: 'counting' })), null);
  assert.equal(taskSecondsLeft(running({ phase: 'preparing' })), null);
  assert.equal(taskSecondsLeft(running({ status: 'queued' })), null);
  assert.equal(taskSecondsLeft(running({ status: 'paused' })), null);
  assert.equal(taskSecondsLeft(running({ status: 'done' })), null);
});

test('groups: running and cancelling, then the ones that need the user, are pinned', () => {
  // The list is newest first, as GET /api/tasks sends it.
  const list = [
    made('failed', 'failed', 90),
    made('run1', 'running', 80),
    made('interrupted', 'interrupted', 70),
    made('cancelling', 'cancelling', 60),
    made('run2', 'running', 50)
  ];
  assert.deepEqual(ids(groupTasks(list).pinned), ['run1', 'cancelling', 'run2', 'failed', 'interrupted']);
  assert.deepEqual(groupTasks(list).queue, []);
  assert.deepEqual(groupTasks(list).finished, []);
});

test('groups: the queue lists the task that runs next first, and paused ones after', () => {
  const list = [made('c', 'queued', 30), made('p', 'paused', 25), made('b', 'queued', 20), made('p-old', 'paused', 5), made('a', 'queued', 10)];
  assert.deepEqual(ids(groupTasks(list).queue), ['a', 'b', 'c', 'p-old', 'p']);
});

test('groups: queued tasks made in one second keep the reverse of the list order', () => {
  const list = [made('third', 'queued', 10), made('second', 'queued', 10), made('first', 'queued', 10), made('older', 'queued', 9)];
  assert.deepEqual(ids(groupTasks(list).queue), ['older', 'first', 'second', 'third']);
});

test('groups: done and cancelled are finished, in the list order', () => {
  const list = [made('d1', 'done', 40), made('x', 'cancelled', 30), made('d2', 'done', 20), made('q', 'queued', 10)];
  const { pinned, queue, finished } = groupTasks(list);
  assert.deepEqual(ids(finished), ['d1', 'x', 'd2']);
  assert.deepEqual(ids(queue), ['q']);
  assert.deepEqual(pinned, []);
});

test('groups: every status lands in exactly one group and the input is left alone', () => {
  const statuses = ['queued', 'paused', 'running', 'cancelling', 'done', 'failed', 'cancelled', 'interrupted'];
  const list = statuses.map((status, index) => made(status, status, index));
  const before = ids(list);
  const { pinned, queue, finished } = groupTasks(list);
  assert.deepEqual([...ids(pinned), ...ids(queue), ...ids(finished)].sort(), [...statuses].sort());
  assert.deepEqual(ids(list), before);
  assert.deepEqual(groupTasks([]), { pinned: [], queue: [], finished: [] });
});
