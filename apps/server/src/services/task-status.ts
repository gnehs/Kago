import type { Db } from "../db/db.js";
import { now } from "../lib/ids.js";
import { finishedTaskStatuses, sqlStatuses, type FileTask, type TaskStatus } from "./types.js";

export type Transition = {
  from: readonly TaskStatus[];
  to: TaskStatus;
  /** Writes the task's error, or clears it, and ends its phase. */
  outcome?: true;
  /** How the move is told: the fields of a `task.progress` patch, the event that ends the task, or nothing. */
  tell: readonly (keyof FileTask)[] | "task.done" | "task.failed" | null;
};

/**
 * Every way a task's status changes. A move asked of a task in any status other than its `from` leaves the row as it
 * was. Landing in `running` stamps `started_at`, and landing in a finished status stamps `finished_at`.
 */
export const taskTransitions = {
  pause: { from: ["queued"], to: "paused", tell: ["status"] },
  resume: { from: ["paused"], to: "queued", tell: ["status"] },
  // Clients hear of it from the first progress the worker reports.
  start: { from: ["queued"], to: "running", tell: null },
  cancel: { from: ["queued", "paused"], to: "cancelled", tell: ["status", "finished_at"] },
  // A running task belongs to its worker, which sees this at its next checkpoint and lets go.
  stop: { from: ["running"], to: "cancelling", tell: ["status", "finished_at"] },
  settle: { from: ["cancelling"], to: "cancelled", tell: ["status", "finished_at"] },
  done: { from: ["running"], to: "done", outcome: true, tell: "task.done" },
  fail: { from: ["running"], to: "failed", outcome: true, tell: "task.failed" },
  // Only at startup, before anyone can listen.
  interrupt: { from: ["running"], to: "interrupted", tell: null }
} as const satisfies Record<string, Transition>;

export type TaskTransition = keyof typeof taskTransitions;

export const allowsTransition = (status: TaskStatus, name: TaskTransition) => (taskTransitions[name].from as readonly TaskStatus[]).includes(status);

export const endsTask = (name: TaskTransition) => (finishedTaskStatuses as readonly TaskStatus[]).includes(taskTransitions[name].to);

/** Moves one task; false when its status does not allow the move. */
export function transitionTask(db: Db, taskId: string, name: TaskTransition, error?: string): boolean {
  const { sql, values } = update(name, error);
  return Number(db.prepare(`${sql} AND id = ?`).run(...values, taskId).changes) > 0;
}

/** Moves every task whose status allows it. */
export function transitionAll(db: Db, name: TaskTransition): number {
  const { sql, values } = update(name);
  return Number(db.prepare(sql).run(...values).changes);
}

function update(name: TaskTransition, error?: string) {
  const move: Transition = taskTransitions[name];
  const ts = now();
  const set: Array<[string, string | number | null]> = [["status", move.to], ["updated_at", ts]];
  if (move.to === "running") set.push(["started_at", ts]);
  if (endsTask(name)) set.push(["finished_at", ts]);
  if (move.outcome) set.push(["error_message", error ?? null], ["phase", null]);
  return {
    sql: `UPDATE tasks SET ${set.map(([column]) => `${column} = ?`).join(", ")} WHERE status IN (${sqlStatuses(move.from)})`,
    values: set.map(([, value]) => value)
  };
}
