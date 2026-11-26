/*
 * What the auto-convert form knows about a draft without asking anyone: where a new job starts out and why it cannot
 * be saved yet. The words are chosen by the component, which holds the translations; this file only says which apply,
 * so that node can test it.
 */

type Folder = { rootSlug: string; path: string };

/** Why the form cannot be saved yet, in the order it is easiest to fix; null when it can. */
export type ConvertProblem = "no-name" | "no-input" | "no-destination" | "destination-readonly" | "overlap" | "no-extensions" | "bad-settings";

/** Whether one folder is the other or lies inside it, in the same location: the server refuses such a pair, because the job would feed on its own output. */
export function foldersOverlap(a: Folder, b: Folder): boolean {
  if (a.rootSlug !== b.rootSlug) return false;
  const inside = (path: string, folder: string) => folder === "/" || path === folder || path.startsWith(`${folder}/`);
  return inside(a.path, b.path) || inside(b.path, a.path);
}

/** Where a field starts: the folder it was given, or the top of the first location it may use. A folder to put things in never starts in a location that cannot be written to. */
export function startingFolder(folder: Folder | null | undefined, roots: ReadonlyArray<{ slug: string; readonly: number }>, writable = false): Folder {
  if (folder) return folder;
  const root = (writable ? roots.find((item) => !item.readonly) : undefined) ?? (writable ? undefined : roots[0]);
  return { rootSlug: root?.slug ?? "", path: "/" };
}

export function convertProblem(draft: { name: string; input: Folder | null; destination: Folder | null; /** The destination's location cannot be written to. */ destinationReadonly: boolean; /** How many file endings were given. */ extensions: number; /** The format settings are values the server takes. */ settingsValid: boolean }): ConvertProblem | null {
  if (!draft.name.trim()) return "no-name";
  if (!draft.input) return "no-input";
  if (!draft.destination) return "no-destination";
  if (draft.destinationReadonly) return "destination-readonly";
  if (foldersOverlap(draft.input, draft.destination)) return "overlap";
  if (draft.extensions === 0) return "no-extensions";
  if (!draft.settingsValid) return "bad-settings";
  return null;
}
