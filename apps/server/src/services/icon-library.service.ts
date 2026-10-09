import fsp from "node:fs/promises";
import path from "node:path";
import { AppError } from "../lib/errors.js";
import { ICON_MAX_BYTES, readIcon, type IconType } from "../lib/icon-image.js";
import { pruneKeptFiles, useKeptFile } from "../lib/kept-files.js";
import { logger } from "../lib/logger.js";
import { fetchPublic, type PublicFetch } from "../lib/public-fetch.js";

/** Everything is fetched from here and from nowhere else: not from an address a library names, and never from one a person typed. */
const HOSTS = ["cdn.jsdelivr.net"] as const;
const CDN = "https://cdn.jsdelivr.net/gh";
const INDEX_MAX_BYTES = 8 * 1024 * 1024;
/** A list of icons is good for a day, and is used past that while a newer one is fetched. */
const INDEX_FRESH_MS = 24 * 60 * 60 * 1000;
/** A library, or one icon of it, that could not be fetched is left alone for this long. */
const RETRY_MS = 5 * 60 * 1000;
const MAX_REMEMBERED_FAILURES = 2000;
/** What an icon may be called. Its name becomes part of an address and of a file name, so it is held to this. */
const NAME = /^[a-z0-9][a-z0-9_-]{0,79}$/;

type Entry = { name: string; label: string; aliases: string[]; type: IconType };
/** An entry with what it is matched by worked out once: its names run together, its other names, and its words. */
type Indexed = Entry & { keys: string[]; aliasKeys: string[]; words: string[] };
type Library = { id: string; index: string; file: (entry: Entry) => string; read: (json: unknown) => Entry[] };

const strings = (value: unknown): string[] => (Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : []).filter((item): item is string => typeof item === "string").map((item) => item.trim().slice(0, 80)).filter(Boolean).slice(0, 20);
const formatOf = (...formats: Array<[IconType, unknown]>) => formats.find(([, present]) => present === true || present === "Yes")?.[0];

/** The libraries that are asked, in the order their icons are preferred. */
const LIBRARIES: Library[] = [
  {
    id: "dashboard-icons",
    index: `${CDN}/homarr-labs/dashboard-icons/metadata.json`,
    file: (entry) => `${CDN}/homarr-labs/dashboard-icons/${entry.type}/${entry.name}.${entry.type}`,
    // { "home-assistant": { "base": "svg", "aliases": ["hass"] } }: it has no name but the file's.
    read: (json) =>
      Object.entries((json ?? {}) as Record<string, { base?: unknown; aliases?: unknown } | null>).flatMap(([name, meta]) => {
        const type = formatOf(["svg", meta?.base === "svg"], ["png", meta?.base === "png"], ["webp", meta?.base === "webp"]);
        return type ? [{ name, label: name.split(/[-_]/).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" "), aliases: strings(meta?.aliases), type }] : [];
      })
  },
  {
    id: "selfhst",
    index: `${CDN}/selfhst/icons/index.json`,
    file: (entry) => `${CDN}/selfhst/icons/${entry.type}/${entry.name}.${entry.type}`,
    // [{ "Name": "Home Assistant", "Reference": "home-assistant", "SVG": "Yes", "PNG": "Yes", "Tags": "" }]
    read: (json) =>
      (Array.isArray(json) ? (json as Array<Record<string, unknown> | null>) : []).flatMap((item) => {
        const type = formatOf(["svg", item?.SVG], ["png", item?.PNG], ["webp", item?.WebP]);
        const name = item?.Reference;
        return type && typeof name === "string" ? [{ name, label: typeof item?.Name === "string" && item.Name.trim() ? item.Name.trim().slice(0, 80) : name, aliases: strings(item?.Tags), type }] : [];
      })
  }
];

const wordsOf = (text: string) => text.normalize("NFKD").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const fold = (text: string) => wordsOf(text).join("");

const indexed = (entry: Entry): Indexed => ({
  ...entry,
  keys: [...new Set([fold(entry.name), fold(entry.label)])].filter(Boolean),
  aliasKeys: entry.aliases.map(fold).filter(Boolean),
  words: [...new Set([...wordsOf(entry.name), ...wordsOf(entry.label)])]
});

/** How well an icon answers to a name: by being called exactly that, then by starting with it, then by sharing its words. */
function score(entry: Indexed, wanted: string, words: string[]): number {
  if (entry.keys.includes(wanted)) return 100;
  if (entry.aliasKeys.includes(wanted)) return 90;
  if (entry.keys.some((key) => key.startsWith(wanted))) return 70;
  if (words.every((word) => entry.words.some((own) => own.startsWith(word)))) return 50;
  // "My Jellyfin" is still Jellyfin.
  if (entry.keys.some((key) => key.length >= 3 && words.includes(key))) return 45;
  if (entry.aliasKeys.some((key) => key.startsWith(wanted))) return 40;
  if (wanted.length >= 3 && entry.keys.some((key) => key.includes(wanted))) return 30;
  return 0;
}

export type LibraryIcon = { source: string; name: string; label: string; /** Whether the icon goes by the very name that was asked for. */ exact: boolean };

type State = { ready?: Promise<void>; index?: { fetchedAt: number; entries: Indexed[]; byName: Map<string, Indexed> }; refreshing?: Promise<void>; failedAt: number };

/**
 * The open icon libraries for self-hosted software (Dashboard Icons, selfh.st Icons): which icons they have, found
 * by name, and the icons themselves. Their lists and every icon looked at are kept on disk, so the libraries are
 * asked as seldom as possible and an icon that was chosen never has to be fetched again.
 */
export class IconLibraryService {
  private readonly dir: string;
  private readonly states = new Map<string, State>(LIBRARIES.map((library) => [library.id, { failedAt: 0 }]));
  private readonly pending = new Map<string, Promise<void>>();
  private readonly failed = new Map<string, number>();

  constructor(appDataDir: string, private readonly fetch: PublicFetch = fetchPublic) {
    this.dir = path.join(appDataDir, "app-icons");
  }

  /** The icons that answer to a name, best first. `available` is false when no library could be reached at all. */
  async search(query: string, limit = 12): Promise<{ available: boolean; items: LibraryIcon[] }> {
    const indexes = await Promise.all(LIBRARIES.map((library) => this.entries(library)));
    const available = indexes.some((index) => index !== null);
    const words = wordsOf(query);
    const wanted = words.join("");
    if (wanted.length < 2) return { available, items: [] };
    const found = indexes.flatMap((index, order) => (index?.entries ?? []).map((entry) => ({ entry, order, score: score(entry, wanted, words) })).filter((match) => match.score > 0));
    found.sort((a, b) => b.score - a.score || a.entry.name.length - b.entry.name.length || a.order - b.order || a.entry.name.localeCompare(b.entry.name));
    // The libraries mostly draw the same logos; one of each is enough to choose from.
    const seen = new Set<string>();
    const items: LibraryIcon[] = [];
    for (const { entry, order, score } of found) {
      if (seen.has(entry.keys[0]!)) continue;
      seen.add(entry.keys[0]!);
      items.push({ source: LIBRARIES[order]!.id, name: entry.name, label: entry.label, exact: score >= 90 });
      if (items.length >= limit) break;
    }
    return { available, items };
  }

  /** One icon of a library as a file on this machine, fetched first unless it was before. Only icons a library lists are ever asked for. */
  async icon(source: string, name: string): Promise<{ file: string; type: IconType }> {
    const library = LIBRARIES.find((item) => item.id === source);
    const entry = library && NAME.test(name) ? (await this.entries(library))?.byName.get(name) : undefined;
    if (!library || !entry) throw new AppError(404, "Icon not found", "ICON_NOT_FOUND");
    const file = path.join(this.dir, "library", `${library.id}.${entry.name}.${entry.type}`);
    if (await useKeptFile(file)) return { file, type: entry.type };
    if (Date.now() - (this.failed.get(file) ?? 0) < RETRY_MS) throw new AppError(502, "The icon could not be fetched", "ICON_FETCH_FAILED");
    let job = this.pending.get(file);
    if (!job) {
      job = this.download(library.file(entry), entry.type, file).finally(() => this.pending.delete(file));
      this.pending.set(file, job);
    }
    try {
      await job;
    } catch (error) {
      if (this.failed.size >= MAX_REMEMBERED_FAILURES) this.failed.clear();
      this.failed.set(file, Date.now());
      logger.warn(`could not fetch the icon ${library.id}/${entry.name}`, error instanceof Error ? error.message : String(error));
      throw new AppError(502, "The icon could not be fetched", "ICON_FETCH_FAILED");
    }
    return { file, type: entry.type };
  }

  /** Deletes the library icons nobody looked at for a month. The ones in use are copies of their own and stay. */
  prune(): Promise<number> {
    return pruneKeptFiles(path.join(this.dir, "library"));
  }

  private async download(url: string, type: IconType, file: string): Promise<void> {
    // What arrives is read like any picture a stranger hands over, whichever library it came from.
    const image = readIcon(await this.fetch(url, { hosts: HOSTS, maxBytes: ICON_MAX_BYTES }));
    if (image.type !== type) throw new Error(`expected ${type}, got ${image.type}`);
    await writeWhole(file, image.data);
  }

  private async entries(library: Library): Promise<State["index"] | null> {
    const state = this.states.get(library.id)!;
    await (state.ready ??= this.restore(library, state));
    const stale = !state.index || Date.now() - state.index.fetchedAt > INDEX_FRESH_MS;
    if (stale && !state.refreshing && Date.now() - state.failedAt > RETRY_MS) {
      state.refreshing = this.refresh(library, state).finally(() => (state.refreshing = undefined));
    }
    // What is on hand is used while a newer list is on its way; only a first search has to wait for one.
    if (!state.index && state.refreshing) await state.refreshing;
    return state.index ?? null;
  }

  private indexFile(library: Library): string {
    return path.join(this.dir, "index", `${library.id}.json`);
  }

  /** The list as it was last fetched, from before the server was restarted. */
  private async restore(library: Library, state: State): Promise<void> {
    try {
      const saved = JSON.parse(await fsp.readFile(this.indexFile(library), "utf8")) as { fetchedAt: number; entries: Entry[] };
      if (typeof saved.fetchedAt === "number" && Array.isArray(saved.entries)) this.adopt(state, saved.entries, saved.fetchedAt);
    } catch {
      // Never fetched, or not readable: it is fetched again.
    }
  }

  private async refresh(library: Library, state: State): Promise<void> {
    try {
      const entries = library.read(JSON.parse((await this.fetch(library.index, { hosts: HOSTS, maxBytes: INDEX_MAX_BYTES })).toString("utf8"))).filter((entry) => NAME.test(entry.name));
      if (entries.length === 0) throw new Error("the list is empty");
      this.adopt(state, entries, Date.now());
      await writeWhole(this.indexFile(library), JSON.stringify({ fetchedAt: Date.now(), entries }));
    } catch (error) {
      state.failedAt = Date.now();
      logger.warn(`could not fetch the icon list of ${library.id}`, error instanceof Error ? error.message : String(error));
    }
  }

  private adopt(state: State, entries: Entry[], fetchedAt: number): void {
    // Read back from disk as much as from the network: only what still has the shape of an entry is believed.
    const list = entries
      .filter((entry) => entry && typeof entry.name === "string" && NAME.test(entry.name) && typeof entry.label === "string" && Array.isArray(entry.aliases) && ["svg", "png", "webp"].includes(entry.type))
      .map((entry) => indexed({ name: entry.name, label: entry.label, aliases: strings(entry.aliases), type: entry.type }));
    state.index = { fetchedAt, entries: list, byName: new Map(list.map((entry) => [entry.name, entry])) };
  }
}

/** Writes a file so that it is either all there or not there. */
async function writeWhole(file: string, data: string | Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const partial = `${file}.${process.hrtime.bigint()}.partial`;
  try {
    await fsp.writeFile(partial, data);
    await fsp.rename(partial, file);
  } finally {
    await fsp.rm(partial, { force: true });
  }
}
