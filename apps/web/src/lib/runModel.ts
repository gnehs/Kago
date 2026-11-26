/*
 * What the run lists of a sync and of an auto-convert know about a run without asking anyone: how long it took, what
 * it did to how many files, and which of its files to show first. The words are chosen by the components, which hold
 * the translations; this file only says which apply and with what numbers, so that node can test it.
 */

/** How long a run took in seconds, or null while it has not ended (or ended before it was timed). */
export const runSeconds = (run: { started_at: number; finished_at: number | null }) => (run.finished_at !== null && run.finished_at >= run.started_at ? run.finished_at - run.started_at : null);

export type ConvertPart = { kind: "converted" | "copied" | "failed"; count: number };

/** What an auto-convert's run did, kind by kind in the order it reads best, leaving out what it did none of. Empty for a run that has yet to say. */
export const convertParts = (run: { converted: number; copied: number; failed: number }): ConvertPart[] =>
  (["converted", "copied", "failed"] as const).filter((kind) => run[kind] > 0).map((kind) => ({ kind, count: run[kind] }));

/** The files of a run with the ones that failed first, since those are what anybody opens the list for; the rest stay in the order the server gave. */
export const failedFirst = <T extends { status: string }>(files: readonly T[]): T[] =>
  files.map((file, index) => ({ file, index })).sort((a, b) => Number(b.file.status === "failed") - Number(a.file.status === "failed") || a.index - b.index).map(({ file }) => file);
