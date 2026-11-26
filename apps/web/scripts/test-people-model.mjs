import assert from 'node:assert/strict';
import { test } from 'node:test';
import { accessOf, arrangeUsers, candidatesFor, filterGroups, foundByMember, groupChips, groupsOf, isLastAdmin, sectionOfUser, signInOf, visibleMembers } from '../src/lib/peopleModel.ts';

let serial = 0;
const user = (patch = {}) => ({ id: `u${++serial}`, email: `user${serial}@x.test`, display_name: `User ${serial}`, role: 'USER', disabled: 0, avatar_at: null, has_password: true, identities: [], ...patch });
const member = (u) => ({ id: u.id, email: u.email, display_name: u.display_name, avatar_at: null });
const group = (name, members = [], id = `g${++serial}`) => ({ id, name, members: members.map(member), created_at: 0, updated_at: 0 });
const rule = (patch) => ({ principal_type: 'group', principal_id: 'g', root_id: 'r1', level: 'view', ...patch });

test('users are listed as administrators, users and the disabled, each by name, and an empty section is left out', () => {
  const list = [user({ display_name: 'Zed', role: 'ADMIN' }), user({ display_name: 'amy' }), user({ display_name: 'Bob' }), user({ display_name: 'Old admin', role: 'ADMIN', disabled: 1 })];
  const sections = arrangeUsers(list, '');
  assert.deepEqual(sections.map((part) => [part.section, part.users.map((entry) => entry.display_name)]), [['admins', ['Zed']], ['users', ['amy', 'Bob']], ['disabled', ['Old admin']]]);
  assert.deepEqual(arrangeUsers(list.filter((entry) => !entry.disabled), '').map((part) => part.section), ['admins', 'users']);
  assert.equal(sectionOfUser({ role: 'ADMIN', disabled: 1 }), 'disabled');
});

test('a search finds users by name or address, in any case, and the sections keep to what was found', () => {
  const list = [user({ display_name: 'Mei-Ling Chen', email: 'meiling@x.test' }), user({ display_name: 'Kenji', email: 'k@Chen.test' }), user({ display_name: 'Priya', disabled: 1 })];
  assert.deepEqual(arrangeUsers(list, ' chen ')[0].users.map((entry) => entry.display_name), ['Kenji', 'Mei-Ling Chen']);
  assert.deepEqual(arrangeUsers(list, 'nobody'), []);
  assert.deepEqual(arrangeUsers(list, 'priya').map((part) => part.section), ['disabled']);
});

test('a user\'s groups are the ones that have them as a member, by name, and the chips show one or two then the rest', () => {
  const a = user();
  const groups = [group('Zoo', [a]), group('Alpha', [a]), group('Other', [user()]), group('Mid', [a])];
  const mine = groupsOf(a.id, groups);
  assert.deepEqual(mine.map((entry) => entry.name), ['Alpha', 'Mid', 'Zoo']);
  assert.deepEqual(groupChips(mine.slice(0, 2)).rest, []);
  const chips = groupChips(mine);
  assert.deepEqual([chips.shown.map((entry) => entry.name), chips.rest.map((entry) => entry.name)], [['Alpha'], ['Mid', 'Zoo']]);
  assert.deepEqual(groupChips([]), { shown: [], rest: [] });
});

test('sign-in methods say whether there is a password, a single sign-on identity, or both', () => {
  assert.deepEqual(signInOf({ has_password: true, identities: [] }), { password: true, sso: false });
  assert.deepEqual(signInOf({ has_password: false, identities: [{ id: 'i' }] }), { password: false, sso: true });
  assert.deepEqual(signInOf({ has_password: true, identities: [{ id: 'i' }] }), { password: true, sso: true });
});

test('only the one enabled administrator is the last, and a disabled one does not count as another', () => {
  const root = user({ role: 'ADMIN' });
  const other = user({ role: 'ADMIN' });
  assert.equal(isLastAdmin([root, other, user()], root.id), false);
  assert.equal(isLastAdmin([root, { ...other, disabled: 1 }, user()], root.id), true);
  assert.equal(isLastAdmin([root], root.id), true);
  assert.equal(isLastAdmin([root, user()], 'u-none'), false);
  assert.equal(isLastAdmin([{ ...root, disabled: 1 }], root.id), false);
});

test('a group search finds a group by its name or a member\'s, and shows the matching members where it found it by them', () => {
  const kenji = user({ display_name: 'Kenji' });
  const groups = [group('Family', [kenji, user({ display_name: 'Grandma' })]), group('Auditors', [user({ display_name: 'Priya' })])];
  assert.deepEqual(filterGroups(groups, '').map((entry) => entry.name), ['Auditors', 'Family']);
  assert.deepEqual(filterGroups(groups, 'kenj').map((entry) => entry.name), ['Family']);
  assert.deepEqual(filterGroups(groups, 'AUDIT').map((entry) => entry.name), ['Auditors']);
  assert.equal(foundByMember(groups[0], 'kenji'), true);
  assert.equal(foundByMember(groups[0], 'fam'), false);
  assert.equal(foundByMember(groups[0], ''), false);
  assert.deepEqual(visibleMembers(groups[0], 'kenji').map((entry) => entry.display_name), ['Kenji']);
  assert.deepEqual(visibleMembers(groups[0], 'family').map((entry) => entry.display_name), ['Grandma', 'Kenji']);
});

test('what a group can reach is the locations its rules name, edit and view apart, by name, leaving out a location that is gone', () => {
  const names = { r1: 'Photos', r2: 'Media', r3: 'Archive' };
  const rules = [rule({ root_id: 'r2', level: 'edit' }), rule({ root_id: 'r1', level: 'edit' }), rule({ root_id: 'r3', level: 'view' }), rule({ root_id: 'gone', level: 'view' }), rule({ principal_id: 'other' }), rule({ principal_type: 'user' })];
  assert.deepEqual(accessOf('g', rules, (id) => names[id] ?? null), { edit: ['Media', 'Photos'], view: ['Archive'] });
  assert.deepEqual(accessOf('nobody', rules, (id) => names[id] ?? null), { edit: [], view: [] });
});

test('people to add are those not in the group, found by name or address, with those who are disabled last', () => {
  const inside = user({ display_name: 'Inside' });
  const off = user({ display_name: 'Aaa off', disabled: 1 });
  const b = user({ display_name: 'Bob', email: 'bob@x.test' });
  const c = user({ display_name: 'Cy' });
  const target = group('G', [inside]);
  assert.deepEqual(candidatesFor([inside, off, c, b], target, '').map((entry) => entry.display_name), ['Bob', 'Cy', 'Aaa off']);
  assert.deepEqual(candidatesFor([inside, off, c, b], target, 'BOB@').map((entry) => entry.display_name), ['Bob']);
  assert.deepEqual(candidatesFor([inside], target, ''), []);
});
