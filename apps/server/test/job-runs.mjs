import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildApp } from "../dist/app.js";

// Every sync runs through rclone, and every conversion through ffmpeg, which a development machine may not have.
const rcloneInstalled = spawnSync("rclone", ["version"]).status === 0;
const ffmpegInstalled = spawnSync("ffmpeg", ["-version"]).status === 0;

async function server(t) {
  const baseDir = await mkdtemp(path.join(tmpdir(), "kago-job-runs."));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  for (const folder of ["in", "out"]) await mkdir(path.join(dataDir, "media", folder), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(dataDir, "media", "in", "note.txt"), "note");
  const app = await buildApp({ port: 0, dataDir, appDataDir, sessionSecret: "job-runs-test-session-secret", nodeEnv: "test" });
  await app.ready();
  const store = new DatabaseSync(path.join(appDataDir, "app.db"));
  t.after(async () => {
    store.close();
    await app.close();
    await rm(baseDir, { recursive: true, force: true });
  });
  let cookie = "";
  const request = async (method, url, body) => {
    const headers = { accept: "application/json", ...(cookie ? { cookie } : {}), ...(method === "GET" ? {} : { "x-kago-csrf": "1" }), ...(body ? { "content-type": "application/json" } : {}) };
    const response = await app.inject({ method, url, headers, payload: body ? JSON.stringify(body) : undefined });
    const set = response.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((value) => value.split(";", 1)[0]).join("; ");
    return { statusCode: response.statusCode, json: response.payload ? JSON.parse(response.payload) : null };
  };
  const api = { get: (url) => request("GET", url), post: (url, body) => request("POST", url, body), delete: (url) => request("DELETE", url) };
  assert.equal((await api.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" })).statusCode, 200);
  const runsOf = (jobId) => store.prepare("SELECT id, status FROM tasks WHERE job_id = ? ORDER BY created_at, rowid").all(jobId);
  const waitTask = async (taskId) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const task = (await api.get(`/api/tasks/${taskId}`)).json;
      if (["done", "failed", "cancelled", "interrupted"].includes(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Task ${taskId} did not finish`);
  };
  /** A run of the job that waits, as one paused by hand does, so that the job stays busy for as long as the test needs. */
  const waitingRun = (jobId, type) => {
    const id = `task_waiting_${jobId}`;
    store.prepare("INSERT INTO tasks (id, type, status, created_by, sources_json, created_at, updated_at, job_id) SELECT ?, ?, 'paused', id, '[]', 0, 0, ? FROM users LIMIT 1").run(id, type, jobId);
    return id;
  };
  return { api, store, runsOf, waitTask, waitingRun };
}

const statuses = (responses) => responses.map((response) => response.statusCode).sort();

async function oneRunAtATime(t, { kind, type, busy, create }) {
  const { api, store, runsOf, waitTask, waitingRun } = await server(t);
  const job = await api.post(`/api/${kind}`, create);
  assert.equal(job.statusCode, 200, JSON.stringify(job.json));
  const jobId = job.json.id;

  const asked = await Promise.all(Array.from({ length: 6 }, () => api.post(`/api/${kind}/${jobId}/run`)));
  assert.deepEqual(statuses(asked), [200, 409, 409, 409, 409, 409], "six asks at once start the job once");
  for (const refused of asked.filter((response) => response.statusCode === 409)) assert.equal(refused.json.code, busy);
  const first = asked.find((response) => response.statusCode === 200).json;
  assert.deepEqual(runsOf(jobId).map((run) => run.id), [first.id], "exactly one task is queued");
  assert.equal(first.job_id, undefined, "the job column is not sent");

  const finished = await waitTask(first.id);
  const next = await api.post(`/api/${kind}/${jobId}/run`);
  assert.equal(next.statusCode, 200, "a finished run lets the next one start");
  await waitTask(next.json.id);

  store.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(finished.id);
  const waiting = waitingRun(jobId, type);
  const retried = await api.post(`/api/tasks/${finished.id}/retry`);
  assert.deepEqual([retried.statusCode, retried.json.code], [409, busy], "a retry while another run waits is refused");
  assert.equal(runsOf(jobId).filter((run) => ["queued", "paused", "running", "cancelling"].includes(run.status)).length, 1);
  assert.equal((await api.post(`/api/tasks/${waiting}/cancel`)).statusCode, 200);
  const again = await api.post(`/api/tasks/${finished.id}/retry`);
  assert.equal(again.statusCode, 200, "once it is cancelled the retry goes ahead");
  await waitTask(again.json.id);
  assert.ok(runsOf(jobId).some((run) => run.id === again.json.id), "the retry is a run of the job");

  // A run whose job is gone is queued again as the plain task it was, and is still held to one at a time.
  assert.equal((await api.delete(`/api/${kind}/${jobId}`)).statusCode, 200);
  store.prepare("UPDATE tasks SET status = 'failed' WHERE id = ?").run(again.json.id);
  const orphans = await Promise.all([api.post(`/api/tasks/${again.json.id}/retry`), api.post(`/api/tasks/${again.json.id}/retry`)]);
  assert.deepEqual(statuses(orphans), [200, 409]);
  assert.equal(orphans.find((response) => response.statusCode === 409).json.code, "JOB_ALREADY_RUNNING");
  const orphan = orphans.find((response) => response.statusCode === 200).json;
  assert.equal(store.prepare("SELECT job_id FROM tasks WHERE id = ?").get(orphan.id).job_id, jobId, "a retried run keeps its job");
  await waitTask(orphan.id);
}

test("a sync job runs once at a time", { skip: !rcloneInstalled && "rclone is not installed" }, (t) =>
  oneRunAtATime(t, {
    kind: "sync-jobs",
    type: "sync",
    busy: "SYNC_ALREADY_RUNNING",
    create: { name: "Backup", source: { kind: "location", rootSlug: "media", path: "/in" }, destination: { kind: "location", rootSlug: "media", path: "/out" } }
  })
);

test("an auto-convert job runs once at a time", { skip: !ffmpegInstalled && "ffmpeg is not installed" }, (t) =>
  oneRunAtATime(t, {
    kind: "convert-jobs",
    type: "convert",
    busy: "CONVERT_ALREADY_RUNNING",
    create: { name: "Shrink", input: { rootSlug: "media", path: "/in" }, destination: { rootSlug: "media", path: "/out" }, spec: { format: "mp4" }, watch: false }
  })
);

test("tasks of no job are not held to one at a time", async (t) => {
  const { api, store } = await server(t);
  const copy = () => api.post("/api/tasks", { type: "copy", sources: [{ rootSlug: "media", path: "/in/note.txt" }], destination: { rootSlug: "media", path: "/out" } });
  const both = await Promise.all([copy(), copy()]);
  assert.deepEqual(statuses(both), [200, 200]);
  assert.deepEqual(
    both.map((response) => store.prepare("SELECT job_id FROM tasks WHERE id = ?").get(response.json.id).job_id),
    [null, null]
  );
});
