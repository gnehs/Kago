import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db/db.ts";
import { TaskService } from "../src/services/task.service.ts";
import { taskTransitions } from "../src/services/task-status.ts";

const statuses = ["queued", "paused", "running", "cancelling", "done", "failed", "cancelled", "interrupted"];
const finished = ["done", "failed", "cancelled", "interrupted"];
const admin = { id: "user_admin", email: "admin@example.test", displayName: "Admin", role: "ADMIN", disabled: false };

async function fixture(t) {
  const appDataDir = await mkdtemp(path.join(tmpdir(), "kago-task-status-"));
  const db = openDb({ appDataDir });
  const events = [];
  const audits = [];
  const tasks = new TaskService(db, null, null, { write: (entry) => audits.push(entry) }, { publish: (event) => events.push(event) }, appDataDir, null, null, null);
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, 'x', 'Admin', 'ADMIN', 0, 0)").run(admin.id, admin.email);
  t.after(async () => {
    db.close();
    await rm(appDataDir, { recursive: true, force: true });
  });
  let count = 0;
  const insert = (status, fields = {}) => {
    const id = `task_${(count += 1)}`;
    const row = { status, error_message: null, phase: null, started_at: status === "queued" || status === "paused" ? null : 100, finished_at: finished.includes(status) ? 200 : null, job_id: null, ...fields };
    db.prepare(
      "INSERT INTO tasks (id, type, status, created_by, sources_json, error_message, phase, created_at, updated_at, started_at, finished_at, job_id) VALUES (?, 'copy', ?, ?, '[]', ?, ?, 50, 50, ?, ?, ?)"
    ).run(id, row.status, admin.id, row.error_message, row.phase, row.started_at, row.finished_at, row.job_id);
    return id;
  };
  const read = (id) => ({ ...db.prepare("SELECT status, error_message, phase, updated_at, started_at, finished_at FROM tasks WHERE id = ?").get(id) });
  return { appDataDir, tasks, events, audits, insert, read };
}

const errorFor = (name) => (name === "fail" ? ["it broke"] : []);

for (const [name, move] of Object.entries(taskTransitions)) {
  test(`${name} moves only a task in ${move.from.join(" or ")}`, async (t) => {
    const { tasks, events, insert, read } = await fixture(t);
    for (const status of statuses) {
      const id = insert(status, { error_message: "earlier", phase: "counting" });
      const before = read(id);
      events.length = 0;
      const moved = tasks.transition(id, name, ...errorFor(name));
      const after = read(id);
      if (!move.from.includes(status)) {
        assert.equal(moved, false, `${name} from ${status} is refused`);
        assert.deepEqual(after, before, `${name} from ${status} leaves the row alone`);
        assert.deepEqual(events, [], `${name} from ${status} tells nobody`);
        continue;
      }
      assert.equal(moved, true, `${name} from ${status} is allowed`);
      assert.equal(after.status, move.to);
      assert.ok(after.updated_at > before.updated_at, "updated_at is stamped");
      assert.equal(after.started_at === before.started_at, move.to !== "running", "only starting stamps started_at");
      if (finished.includes(move.to)) assert.ok(after.finished_at > 0, "ending stamps finished_at");
      else assert.equal(after.finished_at, null, "a task not ended has no finished_at");
      if (name === "done") assert.deepEqual([after.error_message, after.phase], [null, null], "done clears the error and the phase");
      else if (name === "fail") assert.deepEqual([after.error_message, after.phase], ["it broke", null], "fail writes the error and clears the phase");
      else assert.deepEqual([after.error_message, after.phase], ["earlier", "counting"], `${name} keeps the error and the phase`);
    }
  });
}

test("each move tells what the task list shows", async (t) => {
  const { tasks, events, insert } = await fixture(t);
  const told = (status, name) => {
    const id = insert(status);
    events.length = 0;
    tasks.transition(id, name, ...errorFor(name));
    for (const event of events) assert.deepEqual([event.userId, event.taskId], [admin.id, id]);
    return events.map(({ userId, taskId, ...event }) => event);
  };
  assert.deepEqual(told("queued", "pause"), [{ type: "task.progress", patch: { status: "paused" } }]);
  assert.deepEqual(told("paused", "resume"), [{ type: "task.progress", patch: { status: "queued" } }]);
  assert.deepEqual(told("queued", "start"), []);
  assert.deepEqual(told("running", "stop"), [{ type: "task.progress", patch: { status: "cancelling", finished_at: null } }]);
  const [cancelled] = told("paused", "cancel");
  assert.equal(cancelled.patch.status, "cancelled");
  assert.ok(cancelled.patch.finished_at > 0);
  const [settled] = told("cancelling", "settle");
  assert.equal(settled.patch.status, "cancelled");
  assert.ok(settled.patch.finished_at > 0);
  assert.deepEqual(told("running", "done"), [{ type: "task.done" }]);
  assert.deepEqual(told("running", "fail"), [{ type: "task.failed", error: "it broke" }]);
  assert.deepEqual(told("running", "interrupt"), []);
});

test("cancelling stops a running task and ends a waiting one", async (t) => {
  const { tasks, audits, insert } = await fixture(t);
  const outcome = (status) => {
    try {
      return tasks.cancel(admin, insert(status)).status;
    } catch (error) {
      return error.code;
    }
  };
  assert.deepEqual(
    Object.fromEntries(statuses.map((status) => [status, outcome(status)])),
    {
      queued: "cancelled",
      paused: "cancelled",
      running: "cancelling",
      cancelling: "cancelling",
      done: "TASK_CANCEL_NOT_ALLOWED",
      failed: "TASK_CANCEL_NOT_ALLOWED",
      cancelled: "cancelled",
      interrupted: "TASK_CANCEL_NOT_ALLOWED"
    }
  );
  assert.equal(audits.filter((entry) => entry.action === "task_cancel").length, 3, "only a cancel that moved the task is audited");
});

test("pausing and resuming move only a waiting task", async (t) => {
  const { tasks, insert } = await fixture(t);
  const outcome = (method, status) => {
    try {
      return tasks[method](admin, insert(status)).status;
    } catch (error) {
      return error.code;
    }
  };
  assert.deepEqual(Object.fromEntries(statuses.map((status) => [status, outcome("pause", status)])), {
    queued: "paused",
    paused: "paused",
    ...Object.fromEntries(statuses.filter((status) => !["queued", "paused"].includes(status)).map((status) => [status, "TASK_PAUSE_NOT_ALLOWED"]))
  });
  assert.deepEqual(Object.fromEntries(statuses.map((status) => [status, outcome("resume", status)])), {
    queued: "queued",
    paused: "queued",
    ...Object.fromEntries(statuses.filter((status) => !["queued", "paused"].includes(status)).map((status) => [status, "TASK_RESUME_NOT_ALLOWED"]))
  });
});

test("a worker's failure ends a running task, and settles one asked to stop", async (t) => {
  const { tasks, events, audits, insert, read } = await fixture(t);
  const running = insert("running");
  tasks.failRunning(running, "Worker exited before completing task");
  assert.deepEqual([read(running).status, read(running).error_message], ["failed", "Worker exited before completing task"]);
  assert.deepEqual(events.map((event) => event.type), ["task.failed"]);
  assert.deepEqual(audits.map((entry) => entry.action), ["task_failed"]);

  events.length = 0;
  audits.length = 0;
  const stopping = insert("cancelling");
  tasks.failRunning(stopping);
  assert.deepEqual([read(stopping).status, read(stopping).error_message], ["cancelled", null]);
  assert.deepEqual(events.map((event) => event.patch?.status), ["cancelled"]);
  assert.deepEqual(audits, [], "a task that was stopping did not fail");

  events.length = 0;
  const done = insert("done");
  tasks.failRunning(done);
  assert.equal(read(done).status, "done");
  assert.deepEqual(events, []);
});

test("claiming takes the oldest waiting task and starts it", async (t) => {
  const { tasks, insert, read } = await fixture(t);
  insert("paused");
  const queued = insert("queued");
  const claimed = tasks.claimNext();
  assert.equal(claimed.id, queued);
  assert.equal(read(queued).status, "running");
  assert.ok(read(queued).started_at > 0);
  assert.equal(tasks.claimNext(), null, "a paused task is not claimed");
});

test("opening the database ends what the last run left running", async (t) => {
  const { appDataDir, insert, read } = await fixture(t);
  const ids = Object.fromEntries(statuses.map((status) => [status, insert(status, { phase: "counting" })]));
  const before = Object.fromEntries(statuses.map((status) => [status, read(ids[status])]));
  const reopened = openDb({ appDataDir });
  const after = (status) => reopened.prepare("SELECT status, phase, finished_at FROM tasks WHERE id = ?").get(ids[status]);
  assert.equal(after("running").status, "interrupted");
  assert.ok(after("running").finished_at > 0);
  assert.equal(after("running").phase, "counting", "an interrupted task keeps its phase");
  assert.equal(after("cancelling").status, "cancelled");
  assert.ok(after("cancelling").finished_at > 0);
  for (const status of statuses.filter((status) => !["running", "cancelling"].includes(status))) {
    assert.deepEqual({ ...after(status) }, { status, phase: before[status].phase, finished_at: before[status].finished_at }, `${status} is left alone`);
  }
  reopened.close();

  insert("running");
  const kept = openDb({ appDataDir }, { interruptRunningTasks: false });
  assert.equal(kept.prepare("SELECT COUNT(*) AS n FROM tasks WHERE status = 'running'").get().n, 1, "recovery tooling leaves a live server's tasks alone");
  kept.close();
});

test("a job has one active run at a time, and other tasks are not held to that", async (t) => {
  const { tasks, insert } = await fixture(t);
  const run = (status, jobId) => insert(status, { job_id: jobId });
  run("done", "sync_a");
  const going = run("running", "sync_a");
  for (const status of ["queued", "paused", "running", "cancelling"]) {
    assert.throws(() => run(status, "sync_a"), /UNIQUE constraint failed: tasks\.job_id/, `a ${status} run beside a running one is refused`);
  }
  run("failed", "sync_a");
  run("queued", "convert_b");
  run("queued", null);
  run("queued", null);
  tasks.transition(going, "done");
  run("queued", "sync_a");
  assert.equal(tasks.get(going).job_id, undefined, "the job column is not part of a task as it is sent");
});

/** A database as Kago left it before tasks named their job: no job_id, no index on it. */
async function oldDatabase(t, runs) {
  const appDataDir = await mkdtemp(path.join(tmpdir(), "kago-job-runs-"));
  t.after(() => rm(appDataDir, { recursive: true, force: true }));
  const db = openDb({ appDataDir });
  db.exec("DROP INDEX idx_tasks_active_job; ALTER TABLE tasks DROP COLUMN job_id");
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES (?, ?, 'x', 'Admin', 'ADMIN', 0, 0)").run(admin.id, admin.email);
  const lastOf = (jobId) => runs.find((run) => run.job === jobId && run.last)?.id ?? null;
  db.prepare("INSERT INTO sync_jobs (id, name, source_json, destination_json, created_by, created_at, updated_at, last_task_id) VALUES ('sync_a', 'A', '{}', '{}', ?, 0, 0, ?)").run(admin.id, lastOf("sync_a"));
  db.prepare("INSERT INTO convert_jobs (id, name, input_json, destination_json, spec_json, created_by, created_at, updated_at, last_task_id) VALUES ('convert_b', 'B', '{}', '{}', '{}', ?, 0, 0, ?)").run(admin.id, lastOf("convert_b"));
  const destination = (run) =>
    run.type === "sync" ? JSON.stringify({ sync: { jobId: run.job } }) : run.type === "convert" ? JSON.stringify({ rootSlug: "r", path: "/", convert: {}, ...(run.job ? { job: { id: run.job } } : {}) }) : null;
  for (const run of runs) {
    db.prepare("INSERT INTO tasks (id, type, status, created_by, sources_json, destination, created_at, updated_at) VALUES (?, ?, ?, ?, '[]', ?, ?, ?)").run(run.id, run.type, run.status, admin.id, destination(run), run.at, run.at);
  }
  db.close();
  return appDataDir;
}

const jobsOf = (db) => Object.fromEntries(db.prepare("SELECT id, job_id FROM tasks ORDER BY id").all().map((task) => [task.id, task.job_id]));

test("an older database learns which job each task ran, and holds each job to one active run from then on", async (t) => {
  const appDataDir = await oldDatabase(t, [
    { id: "t1", type: "sync", job: "sync_a", status: "done", at: 1 },
    { id: "t2", type: "sync", job: "sync_a", status: "queued", at: 2, last: true },
    { id: "t3", type: "convert", job: "convert_b", status: "paused", at: 3, last: true },
    { id: "t4", type: "convert", status: "queued", at: 4 },
    { id: "t5", type: "copy", status: "queued", at: 5 }
  ]);
  const db = openDb({ appDataDir });
  const expected = { t1: "sync_a", t2: "sync_a", t3: "convert_b", t4: null, t5: null };
  assert.deepEqual(jobsOf(db), expected);
  assert.throws(
    () => db.prepare("INSERT INTO tasks (id, type, status, created_by, sources_json, created_at, updated_at, job_id) VALUES ('t6', 'sync', 'queued', ?, '[]', 6, 6, 'sync_a')").run(admin.id),
    /UNIQUE constraint failed: tasks\.job_id/,
    "a second active run of the job is refused"
  );
  db.close();
  const again = openDb({ appDataDir });
  assert.deepEqual(jobsOf(again), expected, "opening it again changes nothing");
  again.close();
});

test("an older database that already ran a job twice at once keeps the run the job points at, or else the newest", async (t) => {
  const appDataDir = await oldDatabase(t, [
    { id: "t1", type: "sync", job: "sync_a", status: "queued", at: 1, last: true },
    { id: "t2", type: "sync", job: "sync_a", status: "paused", at: 2 },
    { id: "t3", type: "sync", job: "sync_a", status: "failed", at: 3 },
    { id: "t4", type: "convert", job: "convert_b", status: "queued", at: 4 },
    { id: "t5", type: "convert", job: "convert_b", status: "queued", at: 5 }
  ]);
  const db = openDb({ appDataDir });
  const expected = { t1: "sync_a", t2: null, t3: "sync_a", t4: null, t5: "convert_b" };
  assert.deepEqual(jobsOf(db), expected);
  assert.deepEqual(db.prepare("SELECT status FROM tasks ORDER BY id").all().map((task) => task.status), ["queued", "paused", "failed", "queued", "queued"], "no run is stopped");
  db.close();
  const again = openDb({ appDataDir });
  assert.deepEqual(jobsOf(again), expected, "opening it again changes nothing");
  again.close();
});
