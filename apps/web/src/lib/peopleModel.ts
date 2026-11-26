import type { Group, PermissionRule, UserAccount } from "../types/kago";

/*
 * What the Users and Groups pages know about people without asking anyone: which section a user is listed under, which
 * groups they are in, how they can sign in, what a group is allowed to reach, and who a search finds. The words are
 * chosen by the components, which hold the translations; this file only says which apply and with what, so that node
 * can test it.
 */

type Named = Pick<UserAccount, "email" | "display_name">;

/** What a person is called in a list: their name, or their address where they have not given one. */
export const personName = (person: Named) => (person.display_name || person.email).normalize("NFC");

const byName = (a: Named, b: Named) => personName(a).localeCompare(personName(b), undefined, { numeric: true });

const needleOf = (query: string) => query.trim().normalize("NFC").toLowerCase();
const matches = (needle: string, ...texts: string[]) => !needle || texts.some((text) => text.normalize("NFC").toLowerCase().includes(needle));
const matchesPerson = (needle: string, person: Named) => matches(needle, person.display_name, person.email);

export type UserSection = "admins" | "users" | "disabled";

/** Where a user is listed: a disabled account is set apart whatever its role. */
export const sectionOfUser = (user: Pick<UserAccount, "role" | "disabled">): UserSection => (user.disabled ? "disabled" : user.role === "ADMIN" ? "admins" : "users");

/** The users a search by name or address finds, under Administrators, Users and Disabled, each by name; a section with nobody in it is left out. */
export function arrangeUsers(users: readonly UserAccount[], query: string): Array<{ section: UserSection; users: UserAccount[] }> {
  const needle = needleOf(query);
  const sections: Record<UserSection, UserAccount[]> = { admins: [], users: [], disabled: [] };
  for (const user of [...users].sort(byName)) if (matchesPerson(needle, user)) sections[sectionOfUser(user)].push(user);
  return (["admins", "users", "disabled"] as const).filter((section) => sections[section].length > 0).map((section) => ({ section, users: sections[section] }));
}

/** The groups a user is in, by name. */
export const groupsOf = (userId: string, groups: readonly Group[]): Group[] => groups.filter((group) => group.members.some((member) => member.id === userId)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

/** The chips for a user's groups: all of them when there are two, otherwise the first and how many more there are. */
export function groupChips<T>(groups: readonly T[], limit = 2): { shown: T[]; rest: T[] } {
  if (groups.length <= limit) return { shown: [...groups], rest: [] };
  return { shown: groups.slice(0, 1), rest: groups.slice(1) };
}

/** The ways a user can sign in: with a password, through single sign-on, both, or (for an account with neither) none at all. */
export const signInOf = (user: Pick<UserAccount, "has_password" | "identities">) => ({ password: user.has_password, sso: user.identities.length > 0 });

/** Whether this is the only enabled administrator: the one account that cannot be disabled or made a standard user. */
export const isLastAdmin = (users: readonly Pick<UserAccount, "id" | "role" | "disabled">[], id: string) => {
  const user = users.find((entry) => entry.id === id);
  return Boolean(user && user.role === "ADMIN" && !user.disabled && !users.some((entry) => entry.id !== id && entry.role === "ADMIN" && !entry.disabled));
};

/** The groups a search finds: by the name of the group or of one of its members, by name. */
export function filterGroups(groups: readonly Group[], query: string): Group[] {
  const needle = needleOf(query);
  return groups.filter((group) => matches(needle, group.name) || group.members.some((member) => matchesPerson(needle, member))).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The members a search leaves showing: all of them where it found the group itself, only the ones it matched where it found the group by them. */
export function visibleMembers(group: Group, query: string): Group["members"] {
  const needle = needleOf(query);
  const members = [...group.members].sort(byName);
  return matches(needle, group.name) ? members : members.filter((member) => matchesPerson(needle, member));
}

/** Whether a search found the group only through its members, so that it is shown open on the ones it found. */
export const foundByMember = (group: Group, query: string) => needleOf(query) !== "" && !matches(needleOf(query), group.name);

/**
 * What the permission rules that name a group let it do: the locations it can edit and the ones it can only view, by
 * name. A location that cannot be named any more is left out.
 */
export function accessOf(groupId: string, rules: readonly Pick<PermissionRule, "principal_type" | "principal_id" | "root_id" | "level">[], rootName: (rootId: string) => string | null): { edit: string[]; view: string[] } {
  const access = { edit: [] as string[], view: [] as string[] };
  for (const rule of rules) {
    if (rule.principal_type !== "group" || rule.principal_id !== groupId) continue;
    const name = rootName(rule.root_id);
    if (name !== null) access[rule.level].push(name);
  }
  access.edit.sort((a, b) => a.localeCompare(b));
  access.view.sort((a, b) => a.localeCompare(b));
  return access;
}

/** The users who could be put into the group that a search finds: not in it already, those who can sign in first, each by name. */
export function candidatesFor(users: readonly UserAccount[], group: Group, query: string): UserAccount[] {
  const needle = needleOf(query);
  return users
    .filter((user) => !group.members.some((member) => member.id === user.id) && matchesPerson(needle, user))
    .sort((a, b) => Number(a.disabled) - Number(b.disabled) || byName(a, b));
}

/** How many members an opened group lists, and how many more each press adds: hundreds are not drawn at once. */
export const MEMBERS_FIRST = 5;
export const MEMBERS_MORE = 50;
