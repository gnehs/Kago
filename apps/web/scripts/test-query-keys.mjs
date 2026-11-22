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
const { keys, isListingKey } = await import('../src/api/keys.ts');
const { eventKeys, reconnectKeys } = await import('../src/api/invalidations.ts');

test('builders produce the arrays the cache is already keyed by', () => {
  assert.deepEqual(keys.tasks(), ['tasks']);
  assert.deepEqual(keys.auth.me(), ['auth', 'me']);
  assert.deepEqual(keys.fs.list('home', '/a'), ['fs', 'list', 'home', '/a']);
  assert.deepEqual(keys.fs.search('home', '/a', 'cat'), ['fs', 'list', 'home', '/a', 'search', 'cat']);
  assert.deepEqual(keys.fs.sqliteRows('home', '/a.db', 5, 't', 0, 50), ['fs', 'sqlite', 'home', '/a.db', 5, 't', 0, 50]);
  assert.deepEqual(keys.media.info('home', '/a.mp4', 7), ['media', 'info', 'home', '/a.mp4', 7]);
  assert.deepEqual(keys.permissions.forRoot(undefined), ['permissions', 'all']);
  assert.deepEqual(keys.permissions.forRoot('r1'), ['permissions', 'r1']);
  assert.deepEqual(keys.syncTrial('j', 3), ['sync-trial', 'j', 3]);
});

test('a listing is told from a search', () => {
  assert.equal(isListingKey(keys.fs.list('home', '/a')), true);
  assert.equal(isListingKey(keys.fs.search('home', '/a', 'cat')), false);
  assert.equal(isListingKey(keys.fs.meta('home', '/a')), false);
  assert.equal(isListingKey(keys.fs.lists()), false);
  assert.equal(isListingKey(keys.tasks()), false);
});

test('a search sits under its folder listing, so a prefix reaches both', () => {
  const listing = keys.fs.list('home', '/a');
  const search = keys.fs.search('home', '/a', 'cat');
  assert.deepEqual(search.slice(0, listing.length), listing);
  assert.deepEqual(listing.slice(0, keys.fs.rootLists('home').length), keys.fs.rootLists('home'));
  assert.deepEqual(keys.fs.rootLists('home').slice(0, 2), keys.fs.lists());
});

test('reconnect refetches everything an event can invalidate, folder data aside', () => {
  const covered = new Set(reconnectKeys.map((key) => JSON.stringify(key)));
  const events = Object.keys(eventKeys);
  assert.ok(events.includes('task.done') && events.includes('roots.updated'));
  for (const [type, queryKeys] of Object.entries(eventKeys)) {
    for (const queryKey of queryKeys) {
      if (queryKey[0] === 'fs') continue;
      assert.ok(covered.has(JSON.stringify(queryKey)), `${type} invalidates ${JSON.stringify(queryKey)}, which a reconnect misses`);
    }
  }
  for (const queryKey of [keys.trash(), keys.users(), keys.groups(), keys.storage()]) assert.ok(covered.has(JSON.stringify(queryKey)));
  assert.ok(reconnectKeys.every((key) => key[0] !== 'fs'));
  assert.equal(covered.size, reconnectKeys.length, 'no key is listed twice');
});
