import assert from 'node:assert/strict';
import { test } from 'node:test';
import { arrangeTrash, commonPlace, filterTrash, groupDeletions, MEASURING_SECONDS, othersOf, placeText, sectionOf, sizeState, totalOf, trashFolder, trashName } from '../src/lib/trashModel.ts';

const at = (y, m, d, h = 12, min = 0) => Math.floor(new Date(y, m - 1, d, h, min).getTime() / 1000);
const NOW = at(2026, 11, 26, 14);
let serial = 0;
const item = (patch = {}) => ({
  id: `i${++serial}`, original_root_id: 'r1', original_path: `/Docs/file ${serial}.txt`, deleted_by: 'u1', deleted_at: NOW - serial, restored_at: null,
  kind: 'file', size: 10, item_count: null, deletion_id: null, deleter: { id: 'u1', email: 'a@b.c', display_name: '', avatar_at: null }, ...patch
});
const ids = (list) => list.map((entry) => entry.id);

test('items of one deletion are one entry, and a deletion of one item or an old item stands alone', () => {
  const list = [item({ deletion_id: 'd1' }), item({ deletion_id: 'd2' }), item({ deletion_id: 'd1' }), item({ deletion_id: null }), item({ deletion_id: null })];
  const entries = groupDeletions(list);
  assert.deepEqual(entries.map((entry) => [entry.key, entry.items.length, entry.group]), [['d1', 2, true], ['d2', 1, false], [list[3].id, 1, false], [list[4].id, 1, false]]);
  assert.deepEqual(ids(entries[0].items).sort(), [list[0].id, list[2].id].sort());
  assert.equal(entries[0].deletedAt, list[0].deleted_at);
});

test('a day is the viewer\'s own: today from midnight, yesterday the day before, the rest earlier', () => {
  assert.equal(sectionOf(at(2026, 11, 26, 0, 0), NOW), 'today');
  assert.equal(sectionOf(at(2026, 11, 25, 23, 59), NOW), 'yesterday');
  assert.equal(sectionOf(at(2026, 11, 25, 0, 0), NOW), 'yesterday');
  assert.equal(sectionOf(at(2026, 11, 24, 23, 59), NOW), 'earlier');
  assert.equal(sectionOf(NOW + 60, NOW), 'today');
});

test('the window lists deletions newest first under their day, and leaves out a day with nothing in it', () => {
  const older = item({ deleted_at: at(2026, 11, 20), deletion_id: 'old' });
  const today = [item({ deleted_at: at(2026, 11, 26, 9), deletion_id: 'g' }), item({ deleted_at: at(2026, 11, 26, 9), deletion_id: 'g' })];
  const arranged = arrangeTrash([...today, older], '', NOW);
  assert.deepEqual(arranged.map((part) => [part.section, part.entries.map((entry) => entry.key)]), [['today', ['g']], ['earlier', ['old']]]);
  assert.deepEqual(arrangeTrash([], '', NOW), []);
});

test('a search keeps the items whose name has the text in it, whatever its case, and groups what is left', () => {
  const list = [item({ original_path: '/a/Report.PDF', deletion_id: 'g' }), item({ original_path: '/a/notes.txt', deletion_id: 'g' }), item({ original_path: '/a/report-old.pdf' })];
  assert.deepEqual(filterTrash(list, ' report ').map((found) => trashName(found)), ['Report.PDF', 'report-old.pdf']);
  assert.equal(filterTrash(list, '').length, 3);
  assert.deepEqual(filterTrash(list, 'zzz'), []);
  const arranged = arrangeTrash(list, 'report', NOW);
  assert.deepEqual(arranged.flatMap((part) => part.entries.map((entry) => entry.group)), [false, false]);
  assert.equal(filterTrash([item({ original_path: '/Café/file.txt' })], 'café').length, 0, 'only the name is searched, not the folders');
  assert.equal(filterTrash([item({ original_path: '/a/Café.txt'.normalize('NFD') })], 'café').length, 1, 'a name is compared as people spell it');
});

test('names and folders come from the path, and a top-level item lies in the top of its location', () => {
  assert.equal(trashName(item({ original_path: '/a/b/c.txt' })), 'c.txt');
  assert.equal(trashFolder(item({ original_path: '/a/b/c.txt' })), '/a/b');
  assert.equal(trashFolder(item({ original_path: '/c.txt' })), '/');
});

test('a deletion came from the deepest folder that holds all of it, or from no one place', () => {
  const from = (...paths) => paths.map((path) => item({ original_path: path }));
  assert.deepEqual(commonPlace(from('/a/b/x', '/a/b/y')), { rootId: 'r1', folder: '/a/b' });
  assert.deepEqual(commonPlace(from('/a/b/c/x', '/a/b/y')), { rootId: 'r1', folder: '/a/b' });
  assert.deepEqual(commonPlace(from('/a/bc/x', '/a/b/y')), { rootId: 'r1', folder: '/a' });
  assert.deepEqual(commonPlace(from('/a/x', '/b/y')), { rootId: 'r1', folder: '/' });
  assert.deepEqual(commonPlace(from('/a/x')), { rootId: 'r1', folder: '/a' });
  assert.equal(commonPlace([item(), item({ original_root_id: 'r2' })]), null);
  assert.equal(commonPlace([]), null);
});

test('a place is read under its location\'s name, or by the folder alone where the location cannot be named', () => {
  assert.equal(placeText('Docs', '/a/b'), 'Docs/a/b');
  assert.equal(placeText('Docs', '/'), 'Docs');
  assert.equal(placeText(null, '/a/b'), '/a/b');
  assert.equal(placeText(null, '/'), null);
});

test('a folder just thrown away on our own disk is being measured, until the server has had its time; anything else without a size has none', () => {
  const folder = { kind: 'folder', size: null, deleted_at: NOW - 5 };
  assert.deepEqual(sizeState(folder, true, NOW), { kind: 'measuring' });
  assert.deepEqual(sizeState(folder, false, NOW), { kind: 'unknown' });
  assert.deepEqual(sizeState({ ...folder, deleted_at: NOW - MEASURING_SECONDS }, true, NOW), { kind: 'unknown' });
  assert.deepEqual(sizeState({ ...folder, kind: 'file' }, true, NOW), { kind: 'unknown' });
  assert.deepEqual(sizeState({ ...folder, kind: null }, true, NOW), { kind: 'unknown' });
  assert.deepEqual(sizeState({ ...folder, size: 0 }, true, NOW), { kind: 'known', bytes: 0 }, 'an empty file is zero, not unknown');
});

test('a total is exact only when every size is known, and says whether the rest are on their way', () => {
  const local = () => true;
  assert.deepEqual(totalOf([item({ size: 5 }), item({ size: 7 })], local, NOW), { count: 2, bytes: 12, complete: true, measuring: false });
  assert.deepEqual(totalOf([item({ size: 5 }), item({ size: null, kind: 'file' })], local, NOW), { count: 2, bytes: 5, complete: false, measuring: false });
  assert.deepEqual(totalOf([item({ size: 5 }), item({ size: null, kind: 'folder', deleted_at: NOW })], local, NOW), { count: 2, bytes: 5, complete: false, measuring: true });
  assert.deepEqual(totalOf([], local, NOW), { count: 0, bytes: 0, complete: true, measuring: false });
});

test('other people\'s items are counted with how many people they are', () => {
  const list = [item(), item({ deleted_by: 'u2' }), item({ deleted_by: 'u2' }), item({ deleted_by: 'u3' })];
  assert.deepEqual(othersOf(list, 'u1'), { items: 3, people: 2 });
  assert.deepEqual(othersOf(list.slice(0, 1), 'u1'), { items: 0, people: 0 });
});

test('the members of a deletion are in the order of their names, numbers by value', () => {
  const [entry] = groupDeletions([10, 9, 1, 2].map((n) => item({ original_path: `/d/draft ${n}.txt`, deletion_id: 'g' })));
  assert.deepEqual(entry.items.map(trashName), ['draft 1.txt', 'draft 2.txt', 'draft 9.txt', 'draft 10.txt']);
});
