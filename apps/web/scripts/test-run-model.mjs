import assert from 'node:assert/strict';
import { test } from 'node:test';
import { convertParts, failedFirst, runSeconds } from '../src/lib/runModel.ts';

test('a run is timed only once it has ended', () => {
  assert.equal(runSeconds({ started_at: 100, finished_at: 220 }), 120);
  assert.equal(runSeconds({ started_at: 100, finished_at: null }), null);
  assert.equal(runSeconds({ started_at: 100, finished_at: 90 }), null);
});

test('what a run did is told kind by kind and leaves out what it did none of', () => {
  assert.deepEqual(convertParts({ converted: 12, copied: 0, failed: 3 }), [{ kind: 'converted', count: 12 }, { kind: 'failed', count: 3 }]);
  assert.deepEqual(convertParts({ converted: 0, copied: 4, failed: 0 }), [{ kind: 'copied', count: 4 }]);
  assert.deepEqual(convertParts({ converted: 0, copied: 0, failed: 0 }), []);
});

test('the files that failed come first and the others keep their order', () => {
  const files = [{ path: 'a', status: 'converted' }, { path: 'b', status: 'failed' }, { path: 'c', status: 'copied' }, { path: 'd', status: 'failed' }];
  assert.deepEqual(failedFirst(files).map((file) => file.path), ['b', 'd', 'a', 'c']);
});
