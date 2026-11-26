import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildApp } from "../dist/app.js";
import { trimDetail } from "../dist/lib/failure.js";

const ffmpegInstalled = spawnSync("ffmpeg", ["-version"]).status === 0;
const rcloneInstalled = spawnSync("rclone", ["version"]).status === 0;
const credentials = { email: "admin@example.test", password: "fake-admin-password-123" };
const old = new Date(Date.now() - 3600_000);

async function open(baseDir, setup) {
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  const app = await buildApp({ port: 0, dataDir, appDataDir, sessionSecret: "run-failures-test-session-secret", nodeEnv: "test" });
  await app.ready();
  let cookie = "";
  const request = async (method, url, body) => {
    const headers = { accept: "application/json", ...(cookie ? { cookie } : {}), ...(method === "GET" ? {} : { "x-kago-csrf": "1" }), ...(body ? { "content-type": "application/json" } : {}) };
    const response = await app.inject({ method, url, headers, payload: body ? JSON.stringify(body) : undefined });
    const set = response.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((value) => value.split(";", 1)[0]).join("; ");
    return { statusCode: response.statusCode, json: response.payload ? JSON.parse(response.payload) : null };
  };
  const api = { get: (url) => request("GET", url), post: (url, body) => request("POST", url, body) };
  const signedIn = (await api.post(setup ? "/api/auth/setup" : "/api/auth/login", setup ? { ...credentials, displayName: "Admin" } : credentials)).statusCode;
  assert.equal(signedIn, 200);
  const waitTask = async (taskId) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const task = (await api.get(`/api/tasks/${taskId}`)).json;
      if (["done", "failed", "cancelled", "interrupted"].includes(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Task ${taskId} did not finish`);
  };
  return { app, api, waitTask, dbPath: path.join(appDataDir, "app.db") };
}

async function workspace(t, { setup = true } = {}) {
  const baseDir = await mkdtemp(path.join(tmpdir(), "kago-run-failures."));
  for (const folder of ["in", "out"]) await mkdir(path.join(baseDir, "data", "media", folder), { recursive: true });
  await mkdir(path.join(baseDir, "app-data"), { recursive: true });
  const server = await open(baseDir, setup);
  t.after(async () => {
    await chmod(path.join(baseDir, "data", "media", "out"), 0o755).catch(() => undefined);
    await server.app.close().catch(() => undefined);
    await rm(baseDir, { recursive: true, force: true });
  });
  return { ...server, baseDir, inDir: path.join(baseDir, "data", "media", "in"), outDir: path.join(baseDir, "data", "media", "out") };
}

const job = { name: "Shrink", input: { rootSlug: "media", path: "/in" }, destination: { rootSlug: "media", path: "/out" }, spec: { format: "mkv" }, watch: false };

async function makeVideo(file) {
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=duration=1:size=64x64:rate=5", "-pix_fmt", "yuv420p", "-y", file]);
  assert.equal(made.status, 0, String(made.stderr));
  await utimes(file, old, old);
}

async function runJob(ws, extra = {}) {
  const created = await ws.api.post("/api/convert-jobs", { ...job, ...extra });
  assert.equal(created.statusCode, 200, JSON.stringify(created.json));
  const started = await ws.api.post(`/api/convert-jobs/${created.json.id}/run`);
  assert.equal(started.statusCode, 200, JSON.stringify(started.json));
  const task = await ws.waitTask(started.json.id);
  const runs = (await ws.api.get(`/api/convert-jobs/${created.json.id}/runs`)).json;
  const files = (await ws.api.get(`/api/convert-jobs/${created.json.id}/runs/${task.id}/files`)).json;
  return { jobId: created.json.id, task, run: runs[0], runs, files };
}

const noHostDetail = (detail, ws) => {
  assert.equal(typeof detail, "string");
  assert.ok(!detail.includes(ws.baseDir) && !detail.includes(tmpdir()) && !detail.includes(".kago-convert") && !/[\\/]\w+[\\/]/.test(detail), `detail leaks a path: ${detail}`);
};

test("a detail says the same thing for every file it happened to, whatever the file is called", () => {
  assert.equal(trimDetail("/data/in/clip.mp4: Invalid data found when processing input"), "Invalid data found when processing input");
  assert.equal(trimDetail("/data/in/my holiday clip a.mp4: Invalid data found when processing input"), "Invalid data found when processing input");
  assert.equal(trimDetail("Error opening output /data/out/a b.mkv for writing: Permission denied"), "Permission denied");
  assert.equal(trimDetail("Conversion failed!"), "Conversion failed!");
});

test("a corrupt input is recorded as unreadable, with a detail that names no host path", { skip: !ffmpegInstalled && "ffmpeg is not installed" }, async (t) => {
  const ws = await workspace(t);
  await writeFile(path.join(ws.inDir, "bad.mp4"), Buffer.from("this is not a video ".repeat(200)));
  await utimes(path.join(ws.inDir, "bad.mp4"), old, old);
  await makeVideo(path.join(ws.inDir, "good.mp4"));
  const { task, run, files } = await runJob(ws);
  assert.equal(task.status, "failed");
  const bad = files.find((file) => file.path === "bad.mp4");
  assert.deepEqual([bad.status, bad.error_code, bad.skip_reason], ["failed", "unreadable", null]);
  noHostDetail(bad.error_detail, ws);
  const good = files.find((file) => file.path === "good.mp4");
  assert.deepEqual([good.status, good.error_code, good.error_detail, good.skip_reason], ["converted", null, null, null], "a file that went well has no reason");
  assert.deepEqual([run.converted, run.failed, run.skipped, run.error_code, run.error_detail], [1, 1, 0, null, null], "a run that failed only in a file has no run-level code");
  assert.equal(typeof run.began_at, "number");
  assert.ok(run.finished_at >= run.began_at);
});

test("a destination the server may not write to is recorded as permission", { skip: (!ffmpegInstalled && "ffmpeg is not installed") || (process.getuid?.() === 0 && "root is not held back by a read-only folder") }, async (t) => {
  const ws = await workspace(t);
  await makeVideo(path.join(ws.inDir, "good.mp4"));
  await chmod(ws.outDir, 0o555);
  const { files } = await runJob(ws);
  assert.deepEqual([files[0].status, files[0].error_code], ["failed", "permission"]);
  noHostDetail(files[0].error_detail, ws);
});

test("a full disk, as ffmpeg words it, is recorded as no_space and a file in the way as skipped or failed with its reason", { skip: !ffmpegInstalled && "ffmpeg is not installed" }, async (t) => {
  // ffmpeg is stood in for only when it is asked to write the conversion: the disk cannot really be filled here.
  const stub = path.join(await mkdtemp(path.join(tmpdir(), "kago-stub.")), "ffmpeg");
  await writeFile(stub, `#!/bin/sh\nfor last; do :; done\ncase "$last" in *.kago-convert-*) echo "[libx264 @ 0x600003a1c000] Error writing $last: No space left on device" >&2; exit 1;; esac\nexec ffmpeg "$@"\n`, { mode: 0o755 });
  const before = process.env.FFMPEG_PATH;
  process.env.FFMPEG_PATH = stub;
  t.after(() => {
    if (before === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = before;
  });
  const ws = await workspace(t);
  await makeVideo(path.join(ws.inDir, "good.mp4"));
  await writeFile(path.join(ws.inDir, "fresh.mp4"), "still arriving");
  const { files, run } = await runJob(ws);
  const full = files.find((file) => file.path === "good.mp4");
  assert.deepEqual([full.status, full.error_code], ["failed", "no_space"]);
  noHostDetail(full.error_detail, ws);
  assert.match(full.error_detail, /No space left on device/);
  const fresh = files.find((file) => file.path === "fresh.mp4");
  assert.deepEqual([fresh.status, fresh.skip_reason, fresh.error_code], ["skipped", "too_new", null]);
  assert.equal(run.skipped, 1);
});

/** Queues a run by hand, as one is when the folder it names is gone only after it was asked for: asking for it refuses a folder that is already missing. */
function queueByHand(ws, { id, type, jobId, destination }) {
  const store = new DatabaseSync(ws.dbPath);
  try {
    store.prepare("INSERT INTO tasks (id, type, status, created_by, sources_json, destination, created_at, updated_at, job_id) SELECT ?, ?, 'queued', id, '[]', ?, 1, 1, ? FROM users LIMIT 1").run(id, type, JSON.stringify(destination), jobId);
    if (type === "convert") store.prepare("INSERT INTO convert_runs (task_id, job_id, started_at, status) VALUES (?, ?, 1, 'queued')").run(id, jobId);
    store.prepare(`UPDATE ${type === "convert" ? "convert_jobs" : "sync_jobs"} SET last_task_id = ?, last_run_at = 1 WHERE id = ?`).run(id, jobId);
  } finally {
    store.close();
  }
}

test("a job whose input folder is gone fails as a whole with a code", async (t) => {
  const ws = await workspace(t);
  const created = await ws.api.post("/api/convert-jobs", job);
  const options = { keepSmaller: false, after: "keep", copyOthers: false, extensions: null };
  queueByHand(ws, { id: "task_gone_convert", type: "convert", jobId: created.json.id, destination: { rootSlug: "media", path: "/out", convert: { format: "mkv" }, job: { id: created.json.id, input: { rootSlug: "media", path: "/gone" }, options } } });
  const task = await ws.waitTask("task_gone_convert");
  assert.equal(task.status, "failed");
  assert.equal(task.error_message, "Path not found");
  const run = (await ws.api.get(`/api/convert-jobs/${created.json.id}/runs`)).json[0];
  assert.deepEqual([run.error_code, run.failed, run.skipped], ["not_found", 0, 0]);
  assert.equal(typeof run.began_at, "number");
});

test("a sync that fails says why, and keeps saying it once it is not the last run", { skip: !rcloneInstalled && "rclone is not installed" }, async (t) => {
  const ws = await workspace(t);
  const endpoint = (folder) => ({ kind: "location", rootSlug: "media", path: folder });
  const created = await ws.api.post("/api/sync-jobs", { name: "Backup", source: endpoint("/in"), destination: endpoint("/out") });
  assert.equal(created.statusCode, 200, JSON.stringify(created.json));
  const spec = { jobId: created.json.id, source: endpoint("/gone"), destination: endpoint("/out"), options: { mode: "copy", dryRun: false } };
  queueByHand(ws, { id: "task_gone_sync", type: "sync", jobId: created.json.id, destination: { rootSlug: "media", path: "/out", sync: spec } });
  const task = await ws.waitTask("task_gone_sync");
  assert.equal(task.status, "failed");
  const [run] = (await ws.api.get(`/api/sync-jobs/${created.json.id}/runs`)).json;
  assert.deepEqual([run.error_code, run.task_id], ["not_found", task.id]);
  assert.equal(typeof run.began_at, "number");
  const next = await ws.api.post(`/api/sync-jobs/${created.json.id}/run`);
  await ws.waitTask(next.json.id);
  const earlier = (await ws.api.get(`/api/sync-jobs/${created.json.id}/runs`)).json.find((item) => item.task_id === task.id);
  assert.equal(earlier.error_code, "not_found", "the reason is kept when the run is no longer the last");
});

test("a database from before reasons were kept upgrades in place and returns null for them", async (t) => {
  const ws = await workspace(t);
  const created = await ws.api.post("/api/convert-jobs", job);
  const sync = await ws.api.post("/api/sync-jobs", { name: "Backup", source: { kind: "location", rootSlug: "media", path: "/in" }, destination: { kind: "location", rootSlug: "media", path: "/out" } });
  await ws.app.close();
  const db = new DatabaseSync(ws.dbPath);
  db.prepare("INSERT INTO convert_runs (task_id, job_id, started_at, status, converted, failed) VALUES ('old_run', ?, 100, 'failed', 0, 1)").run(created.json.id);
  db.prepare("INSERT INTO convert_run_files (task_id, path, status, size_in) VALUES ('old_run', 'x.mp4', 'failed', 5)").run();
  db.prepare("INSERT INTO sync_runs (task_id, job_id, started_at, status) VALUES ('old_sync', ?, 100, 'failed')").run(sync.json.id);
  for (const column of ["skipped", "began_at", "error_code", "error_detail"]) db.exec(`ALTER TABLE convert_runs DROP COLUMN ${column}`);
  for (const column of ["error_code", "error_detail", "skip_reason"]) db.exec(`ALTER TABLE convert_run_files DROP COLUMN ${column}`);
  for (const column of ["began_at", "error_code", "error_detail"]) db.exec(`ALTER TABLE sync_runs DROP COLUMN ${column}`);
  db.exec("DROP TABLE task_failures");
  db.close();
  const again = await open(ws.baseDir, false);
  t.after(() => again.app.close());
  const [run] = (await again.api.get(`/api/convert-jobs/${created.json.id}/runs`)).json;
  assert.deepEqual([run.error_code, run.error_detail, run.began_at, run.skipped, run.failed], [null, null, null, 0, 1]);
  const [file] = (await again.api.get(`/api/convert-jobs/${created.json.id}/runs/old_run/files`)).json;
  assert.deepEqual([file.status, file.error_code, file.error_detail, file.skip_reason], ["failed", null, null, null]);
  const [syncRun] = (await again.api.get(`/api/sync-jobs/${sync.json.id}/runs`)).json;
  assert.deepEqual([syncRun.error_code, syncRun.error_detail, syncRun.began_at], [null, null, null]);
});
