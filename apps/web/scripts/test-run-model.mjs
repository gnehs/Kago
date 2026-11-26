import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertParts, failureGroups, lastRunTrouble, runSeconds, skipGroups } from '../src/lib/runModel.ts';

test('a run is timed only once it has ended', () => {
  assert.equal(runSeconds({ started_at: 100, finished_at: 220 }), 120);
  assert.equal(runSeconds({ started_at: 100, finished_at: null }), null);
  assert.equal(runSeconds({ started_at: 100, finished_at: 90 }), null);
});

test('a run is timed from when it began, not from when it was queued', () => {
  assert.equal(runSeconds({ started_at: 100, began_at: 160, finished_at: 220 }), 60);
  assert.equal(runSeconds({ started_at: 100, began_at: null, finished_at: 220 }), 120);
  assert.equal(runSeconds({ started_at: 100, began_at: 160, finished_at: null }), null);
});

test('what a run did is told kind by kind and leaves out what it did none of', () => {
  assert.deepEqual(convertParts({ converted: 12, copied: 0, failed: 3, skipped: 2 }), [{ kind: 'converted', count: 12 }, { kind: 'failed', count: 3 }, { kind: 'skipped', count: 2 }]);
  assert.deepEqual(convertParts({ converted: 0, copied: 4, failed: 0, skipped: 0 }), [{ kind: 'copied', count: 4 }]);
  assert.deepEqual(convertParts({ converted: 0, copied: 0, failed: 0, skipped: 0 }), []);
});

const failed = (path, error_code, error_detail = null) => ({ path, status: 'failed', error_code, error_detail });

test('failed files are grouped by reason, the commonest first, and files of one complaint share it', () => {
  const files = [
    { path: 'ok', status: 'converted', error_code: null, error_detail: null },
    failed('a', 'no_space'),
    failed('b', 'unreadable', 'Invalid data found when processing input'),
    failed('c', 'unreadable', 'Invalid data found when processing input'),
    failed('d', 'unreadable', 'moov atom not found'),
    failed('e', 'unreadable', 'Invalid data found when processing input')
  ];
  const groups = failureGroups(files);
  assert.deepEqual(groups.map((group) => [group.code, group.count]), [['unreadable', 4], ['no_space', 1]]);
  assert.deepEqual(groups[0].clusters.map((cluster) => [cluster.detail, cluster.files.map((file) => file.path)]), [['Invalid data found when processing input', ['b', 'c', 'e']], ['moov atom not found', ['d']]]);
  assert.deepEqual(groups[1].clusters.map((cluster) => cluster.detail), [null]);
});

test('a failure with no reason on record is the last group, however many there are', () => {
  const groups = failureGroups([failed('a', null), failed('b', null), failed('c', null), failed('d', 'timeout')]);
  assert.deepEqual(groups.map((group) => [group.code, group.count]), [['timeout', 1], [null, 3]]);
});

test('skipped files are grouped by why and a run with none has no groups', () => {
  const files = [
    { path: 'a', status: 'skipped', skip_reason: 'too_new' },
    { path: 'b', status: 'skipped', skip_reason: 'failed_earlier' },
    { path: 'c', status: 'skipped', skip_reason: 'failed_earlier' },
    { path: 'd', status: 'failed', skip_reason: null },
    { path: 'e', status: 'skipped', skip_reason: null }
  ];
  assert.deepEqual(skipGroups(files).map((group) => [group.reason, group.files.map((file) => file.path)]), [['failed_earlier', ['b', 'c']], ['too_new', ['a']], [null, ['e']]]);
  assert.deepEqual(skipGroups([failed('a', 'timeout')]), []);
  assert.deepEqual(failureGroups([{ path: 'a', status: 'converted', error_code: null, error_detail: null }]), []);
});

test('a job row warns of a last run that failed or was cut short, or that had files failing', () => {
  assert.equal(lastRunTrouble({ last_status: 'failed' }), 'failed');
  assert.equal(lastRunTrouble({ last_status: 'interrupted', failed: 0 }), 'interrupted');
  assert.equal(lastRunTrouble({ last_status: 'done', failed: 3 }), 'some_failed');
  assert.equal(lastRunTrouble({ last_status: 'done', failed: 0 }), null);
  assert.equal(lastRunTrouble({ last_status: 'running', failed: 3 }), null);
  assert.equal(lastRunTrouble({ last_status: null }), null);
});
