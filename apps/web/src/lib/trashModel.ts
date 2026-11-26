import type { Root, TrashItem } from "../types/kago";
import { daysAgo } from "./days.ts";

/*
 * What the Trash window knows about its items without asking anyone: which were thrown away together, which day each
 * belongs under, where a group came from, what it all adds up to and whose it is. The words are chosen by the
 * components, which hold the translations; this file only says which apply and with what numbers, so that node can
 * test it.
 */

const segments = (path: string) => path.split("/").filter(Boolean);

/** The name an item is listed under. */
export const trashName = (item: Pick<TrashItem, "original_path">) => (segments(item.original_path).at(-1) ?? item.original_path).normalize("NFC");

/** The folder an item lay in: its path without its own name, `/` for one at the top of its location. */
export const trashFolder = (item: Pick<TrashItem, "original_path">) => `/${segments(item.original_path).slice(0, -1).join("/")}`.normalize("NFC");

/** One thing that was thrown away: a single item, or the several that went in together and come back together. */
export type Deletion = { key: string; items: TrashItem[]; deletedAt: number; group: boolean };

/**
 * Items sharing a deletion are one entry, in the position of the newest of them. A deletion of one item, and an item
 * made before the server recorded its deletion, stand alone. `items` is newest first, as the server sends them.
 */
export function groupDeletions(items: readonly TrashItem[]): Deletion[] {
  const byDeletion = new Map<string, TrashItem[]>();
  const entries: Array<{ key: string; items: TrashItem[] }> = [];
  for (const item of items) {
    const members = item.deletion_id ? byDeletion.get(item.deletion_id) : undefined;
    if (members) {
      members.push(item);
      continue;
    }
    const own = [item];
    if (item.deletion_id) byDeletion.set(item.deletion_id, own);
    entries.push({ key: item.deletion_id ?? item.id, items: own });
  }
  return entries.map(({ key, items: members }) => ({
    key,
    // Everything of one deletion went in at the same moment, so its order is by name: the one that heads the card is the first one a person would look for.
    items: [...members].sort((a, b) => trashName(a).localeCompare(trashName(b), undefined, { numeric: true })),
    deletedAt: Math.max(...members.map((item) => item.deleted_at)),
    group: members.length > 1
  }));
}

/** The items with a name that has no part of `query` in it left out. */
export function filterTrash(items: readonly TrashItem[], query: string): TrashItem[] {
  const needle = query.trim().normalize("NFC").toLowerCase();
  return needle ? items.filter((item) => trashName(item).toLowerCase().includes(needle)) : [...items];
}

export type TrashSection = "today" | "yesterday" | "earlier";

/** Which day an item falls under by the clock of the person looking, not of the server. */
export function sectionOf(deletedAt: number, nowSeconds = Math.floor(Date.now() / 1000)): TrashSection {
  const days = daysAgo(deletedAt, nowSeconds);
  return days <= 0 ? "today" : days === 1 ? "yesterday" : "earlier";
}

/** What the window lists for a search: whole deletions, newest first, under the day they belong to; a day with nothing is left out. */
export function arrangeTrash(items: readonly TrashItem[], query: string, nowSeconds = Math.floor(Date.now() / 1000)): Array<{ section: TrashSection; entries: Deletion[] }> {
  const sections: Record<TrashSection, Deletion[]> = { today: [], yesterday: [], earlier: [] };
  for (const entry of groupDeletions(filterTrash(items, query)).sort((a, b) => b.deletedAt - a.deletedAt)) sections[sectionOf(entry.deletedAt, nowSeconds)].push(entry);
  return (["today", "yesterday", "earlier"] as const).filter((section) => sections[section].length > 0).map((section) => ({ section, entries: sections[section] }));
}

/** Where a deletion came from: the one location and the deepest folder that holds all of it, or null where it came from more than one location. */
export function commonPlace(items: readonly TrashItem[]): { rootId: string; folder: string } | null {
  const [first, ...rest] = items;
  if (!first || rest.some((item) => item.original_root_id !== first.original_root_id)) return null;
  let common = segments(trashFolder(first));
  for (const item of rest) {
    const folder = segments(trashFolder(item));
    let shared = 0;
    while (shared < common.length && shared < folder.length && common[shared] === folder[shared]) shared += 1;
    common = common.slice(0, shared);
  }
  return { rootId: first.original_root_id, folder: `/${common.join("/")}` };
}

/** A place as people read it: under the name of its location, or where that location cannot be named, the folder alone, and nothing for the top of it. */
export function placeText(rootName: string | null, folder: string): string | null {
  if (rootName !== null) return `${rootName}${folder === "/" ? "" : folder}`;
  return folder === "/" ? null : folder;
}

/** A folder only just thrown away and kept on a disk of ours is being added up by the server; it tells when it is done. After this long it has given up. */
export const MEASURING_SECONDS = 600;

export type SizeState = { kind: "known"; bytes: number } | { kind: "measuring" } | { kind: "unknown" };

/** Whether an item's size is there, on its way, or never coming. `local` is whether its location is on a disk of ours. */
export function sizeState(item: Pick<TrashItem, "kind" | "size" | "deleted_at">, local: boolean, nowSeconds = Math.floor(Date.now() / 1000)): SizeState {
  if (item.size !== null) return { kind: "known", bytes: item.size };
  return item.kind === "folder" && local && nowSeconds - item.deleted_at < MEASURING_SECONDS ? { kind: "measuring" } : { kind: "unknown" };
}

/** What a set of items adds up to. `bytes` is only a floor while `complete` is false, and `measuring` says some of the missing sizes are still coming. */
export type Total = { count: number; bytes: number; complete: boolean; measuring: boolean };

export function totalOf(items: readonly TrashItem[], isLocal: (item: TrashItem) => boolean, nowSeconds = Math.floor(Date.now() / 1000)): Total {
  const total: Total = { count: items.length, bytes: 0, complete: true, measuring: false };
  for (const item of items) {
    const size = sizeState(item, isLocal(item), nowSeconds);
    if (size.kind === "known") total.bytes += size.bytes;
    else {
      total.complete = false;
      total.measuring ||= size.kind === "measuring";
    }
  }
  return total;
}

/** Whose items there are that are not the viewer's. The server shows an admin everyone's; for anyone else this is nothing. */
export function othersOf(items: readonly TrashItem[], meId: string): { items: number; people: number } {
  const people = new Set<string>();
  let count = 0;
  for (const item of items) {
    if (item.deleted_by === meId) continue;
    count += 1;
    people.add(item.deleted_by);
  }
  return { items: count, people: people.size };
}

/** Members shown under an open group at first, and how many more each "more…" adds, so that a group of hundreds is never hundreds of rows. */
export const MEMBERS_FIRST = 5;
export const MEMBERS_MORE = 50;

export const isLocalRoot = (roots: readonly Root[] | undefined, rootId: string) => roots?.find((root) => root.id === rootId)?.provider === "local";
