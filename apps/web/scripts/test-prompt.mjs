import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { test } from 'node:test';

// The app imports its own modules without an extension, as Vite resolves them; Node is told to do the same.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error;
      return next(`${specifier}.ts`, context);
    }
  },
});
const { createPrompt, createScopedPrompt } = await import('../src/stores/prompt.ts');

test('a question resolves to the answer it is settled with', async () => {
  const prompt = createPrompt();
  const asked = prompt.ask({ title: 'Name?' });
  assert.equal(prompt.useStore.getState().request.title, 'Name?');
  prompt.settle('kago');
  assert.equal(await asked, 'kago');
  assert.equal(prompt.useStore.getState().request, null);
});

test('dismissing resolves to null and clears the question', async () => {
  const prompt = createPrompt();
  const asked = prompt.ask({ title: 'Name?' });
  prompt.settle(null);
  assert.equal(await asked, null);
  assert.equal(prompt.useStore.getState().request, null);
});

test('settling with nothing open does nothing', () => {
  const prompt = createPrompt();
  prompt.settle('x');
  assert.equal(prompt.useStore.getState().request, null);
});

test('a second question while one is open dismisses the first and takes its place', async () => {
  const prompt = createPrompt();
  const first = prompt.ask({ title: 'first' });
  const second = prompt.ask({ title: 'second' });
  assert.equal(await first, null);
  assert.equal(prompt.useStore.getState().request.title, 'second');
  prompt.settle('answer');
  assert.equal(await second, 'answer');
});

test('each window holds its own question and settles it alone', async () => {
  const prompt = createScopedPrompt();
  const a = prompt.ask('win_a', { title: 'a' });
  const b = prompt.ask('win_b', { title: 'b' });
  const page = prompt.ask(null, { title: 'page' });
  assert.deepEqual(Object.keys(prompt.useStore.getState().requests).sort(), ['', 'win_a', 'win_b']);
  prompt.settle('win_a', 'yes');
  assert.equal(await a, 'yes');
  assert.deepEqual(Object.keys(prompt.useStore.getState().requests).sort(), ['', 'win_b']);
  prompt.settle('win_b', null);
  assert.equal(await b, null);
  prompt.settle('', 'page answer');
  assert.equal(await page, 'page answer');
  assert.deepEqual(prompt.useStore.getState().requests, {});
});

test('a second question in the same window dismisses only that window\'s first', async () => {
  const prompt = createScopedPrompt();
  const first = prompt.ask('win_a', { title: 'first' });
  const other = prompt.ask('win_b', { title: 'other' });
  const second = prompt.ask('win_a', { title: 'second' });
  assert.equal(await first, null);
  assert.equal(prompt.useStore.getState().requests.win_a.title, 'second');
  assert.equal(prompt.useStore.getState().requests.win_b.title, 'other');
  prompt.settle('win_a', 'ok');
  assert.equal(await second, 'ok');
  prompt.settle('win_b', 'fine');
  assert.equal(await other, 'fine');
});
