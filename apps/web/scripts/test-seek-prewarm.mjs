import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSeekPrewarmer } from '../src/features/files/seekPrewarm.ts';

function withTimers(t) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  return { tick: (milliseconds) => t.mock.timers.tick(milliseconds) };
}

function recorder(result = () => Promise.resolve()) {
  const calls = [];
  return {
    calls,
    send(time, revision, signal) {
      calls.push({ time, revision, signal });
      return result(time, revision, signal);
    },
  };
}

test('waits for 250 ms of hover dwell and sends only the latest target', (t) => {
  const timers = withTimers(t);
  const sent = recorder();
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(1);
  timers.tick(100);
  prewarmer.hover(2);
  timers.tick(100);
  prewarmer.hover(3);
  timers.tick(249);
  assert.equal(sent.calls.length, 0);
  timers.tick(1);

  assert.equal(sent.calls.length, 1);
  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[3, 1]]);
  assert.equal(sent.calls[0].signal.aborted, false);
});

test('deduplicates requests within a six-second bucket until the pointer leaves', (t) => {
  const timers = withTimers(t);
  const sent = recorder();
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(7);
  timers.tick(250);
  prewarmer.hover(11.9);
  timers.tick(2_000);
  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[7, 1]]);

  prewarmer.hover(null);
  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[7, 1], [null, 2]]);
  prewarmer.hover(11.9);
  timers.tick(250);
  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[7, 1], [null, 2], [11.9, 3]]);
});

test('bucket changes abort stale target requests and only dispatch the latest dwell target', (t) => {
  const timers = withTimers(t);
  const sent = recorder((time) => time === 2 ? new Promise(() => {}) : Promise.resolve());
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(2);
  timers.tick(250);
  assert.equal(sent.calls.length, 1);
  const firstSignal = sent.calls[0].signal;

  prewarmer.hover(8);
  assert.equal(firstSignal.aborted, true);
  timers.tick(100);
  prewarmer.hover(14);
  timers.tick(249);
  assert.equal(sent.calls.length, 1);
  timers.tick(1);

  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[2, 1], [14, 2]]);
});

test('revisiting a previously sent bucket dispatches it again with a newer revision', (t) => {
  const timers = withTimers(t);
  const sent = recorder();
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(2);
  timers.tick(250);
  prewarmer.hover(8);
  timers.tick(250);
  prewarmer.hover(3);
  timers.tick(250);

  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[2, 1], [8, 2], [3, 3]]);
});

test('returning to a sent bucket before the new bucket dwell reschedules the original target', (t) => {
  const timers = withTimers(t);
  const sent = recorder((time) => time === 2 ? new Promise(() => {}) : Promise.resolve());
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(2);
  timers.tick(250);
  const firstSignal = sent.calls[0].signal;

  prewarmer.hover(8);
  assert.equal(firstSignal.aborted, true);
  timers.tick(100);
  prewarmer.hover(3);
  timers.tick(249);
  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[2, 1]]);
  timers.tick(1);

  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[2, 1], [3, 2]]);
});

test('leaving before dwell sends nothing and cancels the pending timer', (t) => {
  const timers = withTimers(t);
  const sent = recorder();
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(12);
  timers.tick(249);
  prewarmer.hover(null);
  timers.tick(2_000);

  assert.deepEqual(sent.calls, []);
});

test('leaving aborts the target and sends one uncancelled null request with the next revision', (t) => {
  const timers = withTimers(t);
  const sent = recorder();
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(12);
  timers.tick(250);
  const targetSignal = sent.calls[0].signal;
  prewarmer.hover(null);
  prewarmer.hover(null);

  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[12, 1], [null, 2]]);
  assert.equal(targetSignal.aborted, true);
  assert.notEqual(sent.calls[1].signal, targetSignal);
  assert.equal(sent.calls[1].signal.aborted, false);
});

test('a newer target can follow an unresolved cancellation and has a higher revision', (t) => {
  const timers = withTimers(t);
  const sent = recorder((time) => time === null ? new Promise(() => {}) : Promise.resolve());
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(2);
  timers.tick(250);
  prewarmer.hover(null);
  prewarmer.hover(20);
  timers.tick(250);

  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[2, 1], [null, 2], [20, 3]]);
  assert.equal(sent.calls[1].signal.aborted, false);
  assert.equal(sent.calls[2].signal.aborted, false);
});

test('disposing cancels a pending dwell without sending a null request', (t) => {
  const timers = withTimers(t);
  const sent = recorder();
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(12);
  timers.tick(100);
  prewarmer.dispose();
  timers.tick(1_000);

  assert.deepEqual(sent.calls, []);
});

test('disposing after a sent request aborts it, cancels once, and ignores later hovers', (t) => {
  const timers = withTimers(t);
  const sent = recorder();
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(18);
  timers.tick(250);
  const targetSignal = sent.calls[0].signal;
  prewarmer.dispose();
  prewarmer.dispose();
  prewarmer.hover(30);
  timers.tick(1_000);

  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[18, 1], [null, 2]]);
  assert.equal(targetSignal.aborted, true);
  assert.equal(sent.calls[1].signal.aborted, false);
});

test('invalid hover times are ignored without disturbing a valid pending dwell', (t) => {
  const timers = withTimers(t);
  const sent = recorder();
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(7);
  timers.tick(100);
  prewarmer.hover(-1);
  prewarmer.hover(Number.NaN);
  prewarmer.hover(Number.POSITIVE_INFINITY);
  prewarmer.hover(Number.NEGATIVE_INFINITY);
  timers.tick(150);

  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[7, 1]]);
});

test('a rejected prewarm request is handled and is not retried in the same bucket', async (t) => {
  const timers = withTimers(t);
  const sent = recorder((time) => time === null ? Promise.resolve() : Promise.reject(new Error('offline')));
  const prewarmer = createSeekPrewarmer(sent.send);

  prewarmer.hover(5);
  timers.tick(250);
  await Promise.resolve();
  prewarmer.hover(5.5);
  timers.tick(2_000);

  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[5, 1]]);
  prewarmer.hover(null);
  assert.deepEqual(sent.calls.map(({ time, revision }) => [time, revision]), [[5, 1], [null, 2]]);
});
