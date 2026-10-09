export type SyncChange = { action: "copy" | "delete" | "mkdir" | "rmdir" | "touch"; path: string; size?: number };
export type SyncSummary = Record<SyncChange["action"], number> & { bytes: number };
/** What the changes add up to, counted over all of them and not only the ones that are listed. */
export type SyncStats = {
  /** The bytes of what would be deleted, as far as the tool said how big that is. */
  freed: number;
  /** What would be copied, by the ending of its name; the many small ones are folded into the one with no ending. */
  extensions: Array<{ extension: string; count: number; bytes: number }>;
  /** The folders at the top that most would change in; `name` is empty for what lies beside them. */
  folders: Array<{ name: string; copy: number; delete: number; bytes: number }>;
  moreFolders: number;
};

/** A trial run of a big folder may name far more than anyone reads; the counts are of all of it all the same. */
const LISTED_CHANGES = 20_000;
const LISTED_EXTENSIONS = 40;
const LISTED_FOLDERS = 5;

const rcloneActions: Record<string, SyncChange["action"]> = {
  copy: "copy",
  delete: "delete",
  "make directory": "mkdir",
  "remove directory": "rmdir",
  "update modification time": "touch"
};

/** What a run of a sync did, or a trial run would have done, gathered from what rclone or rsync said as it went. */
export class SyncReport {
  readonly summary: SyncSummary = { copy: 0, delete: 0, mkdir: 0, rmdir: 0, touch: 0, bytes: 0 };
  readonly changes: SyncChange[] = [];
  private freed = 0;
  private readonly extensions = new Map<string, { count: number; bytes: number }>();
  private readonly folders = new Map<string, { copy: number; delete: number; bytes: number }>();

  /** `listed` is how many of the changes are named; a run that was not a trial is only counted. */
  constructor(private readonly listed = LISTED_CHANGES) {}

  get truncated(): boolean {
    return this.changes.length < this.summary.copy + this.summary.delete + this.summary.mkdir + this.summary.rmdir + this.summary.touch;
  }

  add(change: SyncChange): void {
    this.summary[change.action] += 1;
    if (this.changes.length < this.listed) this.changes.push(change);
    if (change.action !== "copy" && change.action !== "delete") return;
    const size = change.size ?? 0;
    const slash = change.path.indexOf("/");
    const top = slash > 0 ? change.path.slice(0, slash) : "";
    const folder = this.folders.get(top) ?? { copy: 0, delete: 0, bytes: 0 };
    this.folders.set(top, folder);
    folder[change.action] += 1;
    if (change.action === "delete") {
      this.freed += size;
      return;
    }
    folder.bytes += size;
    this.summary.bytes += size;
    const name = change.path.slice(change.path.lastIndexOf("/") + 1);
    const dot = name.lastIndexOf(".");
    const ending = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
    const extension = ending.length <= 12 ? ending : "";
    const kind = this.extensions.get(extension) ?? { count: 0, bytes: 0 };
    this.extensions.set(extension, kind);
    kind.count += 1;
    kind.bytes += size;
  }

  stats(): SyncStats {
    const extensions = [...this.extensions].map(([extension, kind]) => ({ extension, ...kind })).sort((a, b) => b.bytes - a.bytes || b.count - a.count);
    const rest = extensions.splice(LISTED_EXTENSIONS);
    if (rest.length > 0) {
      let other = extensions.find((kind) => kind.extension === "");
      if (!other) extensions.push((other = { extension: "", count: 0, bytes: 0 }));
      for (const kind of rest) {
        other.count += kind.count;
        other.bytes += kind.bytes;
      }
    }
    const folders = [...this.folders].map(([name, folder]) => ({ name, ...folder })).sort((a, b) => b.copy + b.delete - (a.copy + a.delete) || b.bytes - a.bytes);
    return { freed: this.freed, extensions, folders: folders.slice(0, LISTED_FOLDERS), moreFolders: Math.max(folders.length - LISTED_FOLDERS, 0) };
  }

  /** One entry of rclone's JSON log: `{"skipped":"copy","size":4,"object":"deep/b.txt"}` is a thing it left undone. */
  addRcloneLog(entry: Record<string, unknown>): void {
    const action = typeof entry.skipped === "string" ? rcloneActions[entry.skipped] : undefined;
    if (!action || typeof entry.object !== "string") return;
    this.add({ action, path: entry.object, ...(typeof entry.size === "number" && entry.size >= 0 ? { size: entry.size } : {}) });
  }

  /** What a job of rclone's daemon adds up to once it has ended. It tells of no folder it made and no time it set. */
  countRcloneStats(stats: { transfers: number; bytes: number; deletes?: number; deletedDirs?: number }): void {
    this.summary.copy = stats.transfers;
    this.summary.bytes = stats.bytes;
    this.summary.delete = stats.deletes ?? 0;
    this.summary.rmdir = stats.deletedDirs ?? 0;
  }

  /** One line of rsync's `--out-format=%i %l %n`: `>f+++++++++ 4 deep/b.txt`, `cd+++++++++ 4096 deep/`, `*deleting   0 old/`. */
  addRsyncLine(line: string): void {
    // rsync 3 pads the word to the width of the other lines and gives a size; the one macOS ships does neither.
    const deleted = /^\*deleting {3}\d+ (.+)$/.exec(line) ?? /^\*deleting (.+)$/.exec(line);
    if (deleted) {
      const name = deleted[1]!;
      if (name.endsWith("/")) this.add({ action: "rmdir", path: name.slice(0, -1) });
      else this.add({ action: "delete", path: name });
      return;
    }
    const match = /^([<>ch.])([fdLDS])(\S*) (\d+) (.+)$/.exec(line);
    if (!match) return;
    const [, how, kind, flags, size, name] = match as unknown as [string, string, string, string, string, string];
    if (name === "./") return;
    if (kind === "d") {
      if (how === "c") this.add({ action: "mkdir", path: name.replace(/\/$/, "") });
    } else if (how !== ".") this.add({ action: "copy", path: name, size: kind === "f" ? Number(size) : 0 });
    else if (flags.includes("t")) this.add({ action: "touch", path: name });
  }
}

/** Hands on whole lines out of text that arrives in pieces. */
export function byLine(onLine: (line: string) => void): (text: string) => void {
  let rest = "";
  return (text) => {
    const lines = `${rest}${text}`.split(/\r?\n/);
    rest = lines.pop() ?? "";
    for (const line of lines) if (line) onLine(line);
  };
}
