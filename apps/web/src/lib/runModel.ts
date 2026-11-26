import type { ConvertRun, ConvertRunFile, ConvertSkipReason, RunFailureCode } from "@kago/contract";

/*
 * What the run lists of a sync and of an auto-convert know about a run without asking anyone: how long it took, what
 * it did to how many files, which of its files to show first, and why the ones that did not work did not. The words
 * are chosen by the components, which hold the translations; this file only says which apply and with what numbers,
 * so that node can test it.
 */

/** How long a run took in seconds, or null while it has not ended (or ended before it was timed). Waiting in the queue is not part of it, where the run says when it began. */
export const runSeconds = (run: { started_at: number; began_at?: number | null; finished_at: number | null }) => {
  const from = run.began_at ?? run.started_at;
  return run.finished_at !== null && run.finished_at >= from ? run.finished_at - from : null;
};

export type ConvertPart = { kind: "converted" | "copied" | "failed" | "skipped"; count: number };

/** What an auto-convert's run did, kind by kind in the order it reads best, leaving out what it did none of. Empty for a run that has yet to say. */
export const convertParts = (run: Pick<ConvertRun, "converted" | "copied" | "failed" | "skipped">): ConvertPart[] =>
  (["converted", "copied", "failed", "skipped"] as const).filter((kind) => run[kind] > 0).map((kind) => ({ kind, count: run[kind] }));

/** The files of a run with the ones that failed first, since those are what anybody opens the list for; the rest stay in the order the server gave. */
export const failedFirst = <T extends { status: string }>(files: readonly T[]): T[] =>
  files.map((file, index) => ({ file, index })).sort((a, b) => Number(b.file.status === "failed") - Number(a.file.status === "failed") || a.index - b.index).map(({ file }) => file);

/** The files of a run that passed the test, in the order the server gave them. */
const only = <T extends { status: string }>(files: readonly T[], status: ConvertRunFile["status"]) => files.filter((file) => file.status === status);

/** Files kept apart by one thing they have in common, the groups with the most files first and a tie in the order the first of each turned up. */
function groupBy<T, K>(files: readonly T[], keyOf: (file: T) => K): Array<{ key: K; files: T[] }> {
  const groups = new Map<K, T[]>();
  for (const file of files) {
    const key = keyOf(file);
    const members = groups.get(key);
    if (members) members.push(file);
    else groups.set(key, [file]);
  }
  return [...groups].map(([key, members]) => ({ key, files: members })).sort((a, b) => b.files.length - a.files.length);
}

/** The files that failed for one reason. A reason is told once; the files of it are then told apart by what ffmpeg said, if it said anything, so that forty files with one complaint carry it once. */
export type FailureGroup<T> = { code: RunFailureCode | null; count: number; clusters: Array<{ detail: string | null; files: T[] }> };

/** The files that failed, by why: one group per reason, and in it one cluster per thing ffmpeg said. A file from before the reason was told is in the group of `null`, which comes last. */
export function failureGroups<T extends Pick<ConvertRunFile, "status" | "error_code" | "error_detail">>(files: readonly T[]): Array<FailureGroup<T>> {
  const groups = groupBy(only(files, "failed"), (file) => file.error_code).map(({ key, files: members }) => ({
    code: key,
    count: members.length,
    clusters: groupBy(members, (file) => file.error_detail).map((cluster) => ({ detail: cluster.key, files: cluster.files }))
  }));
  return [...groups.filter((group) => group.code !== null), ...groups.filter((group) => group.code === null)];
}

/** The files a run passed over, by why. One with no reason told is in the group of `null`, which comes last. */
export function skipGroups<T extends Pick<ConvertRunFile, "status" | "skip_reason">>(files: readonly T[]): Array<{ reason: ConvertSkipReason | null; files: T[] }> {
  const groups = groupBy(only(files, "skipped"), (file) => file.skip_reason).map(({ key, files: members }) => ({ reason: key, files: members }));
  return [...groups.filter((group) => group.reason !== null), ...groups.filter((group) => group.reason === null)];
}

/** Files shown under a group at first, and how many more each "more…" adds, so that a group of hundreds is never hundreds of rows. */
export const FILES_FIRST = 5;
export const FILES_MORE = 50;

/** How the last run of a job went, for the row of the job: it did not finish well, or it did and some of its files did not. Null when there is nothing to warn of. */
export function lastRunTrouble(job: { last_status: string | null; failed?: number }): "failed" | "interrupted" | "some_failed" | null {
  if (job.last_status === "failed" || job.last_status === "interrupted") return job.last_status;
  return job.last_status === "done" && (job.failed ?? 0) > 0 ? "some_failed" : null;
}
