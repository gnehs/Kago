// How long the everyday requests take while a large copy keeps a disk busy.
//
//   BENCH_DATA=/hdd node scripts/bench-load.mjs prepare
//   BENCH_DATA=/hdd BENCH_OUT=result.json node scripts/bench-load.mjs run
//
// BENCH_DATA is a folder on the disk under test. `prepare` fills it; `run` starts the built server on it, asks each
// probe while nothing else happens, starts a copy of the large folder and asks them all again. Every probe touches
// folders nothing has read yet, so drop the page cache between `prepare` and `run` for the disk to be asked at all.
// See scripts/bench-load-hdd.sh for a disk slowed down to a hard disk's pace.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const mode = process.argv[2];
const data = process.env.BENCH_DATA;
if (!data || !["prepare", "run"].includes(mode)) {
  console.error("usage: BENCH_DATA=<folder on the disk under test> node scripts/bench-load.mjs prepare|run");
  process.exit(2);
}
const root = path.join(data, "hdd");
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 6);
/** A probe unanswered after this long is given up on, and reported as having taken at least that. */
const PROBE_LIMIT_MS = Number(process.env.BENCH_PROBE_LIMIT_MS ?? 20_000);
const ROUND_GAP_MS = Number(process.env.BENCH_ROUND_GAP_MS ?? 5000);
const ALONE_MS = Number(process.env.BENCH_ALONE_MS ?? 30_000);
const SMALL_FOLDERS = Number(process.env.BENCH_SMALL_FOLDERS ?? 60);
const LARGE_FILES = Number(process.env.BENCH_LARGE_FILES ?? 3);
const LARGE_MB = Number(process.env.BENCH_LARGE_MB ?? 400);

/**
 * The reads the disk has answered so far, where BENCH_BLOCK_STAT names its `stat` file in sysfs. Taken around each
 * probe: one that read nothing found its folder in memory and says nothing about the disk. Under load the copy's
 * reads are counted with the probe's.
 */
async function diskReads() {
  if (!process.env.BENCH_BLOCK_STAT) return null;
  return Number((await readFile(process.env.BENCH_BLOCK_STAT, "utf8")).trim().split(/\s+/)[0]);
}

if (mode === "prepare") await prepare();
else await run();

async function fill(folder, count, bytes) {
  await mkdir(folder, { recursive: true });
  for (let index = 0; index < count; index += 1) await writeFile(path.join(folder, `file-${String(index).padStart(4, "0")}.bin`), randomBytes(bytes()));
}

async function prepare() {
  await mkdir(root, { recursive: true });
  for (const name of await readdir(root)) if (name !== "src") await rm(path.join(root, name), { recursive: true, force: true });
  const src = path.join(root, "src");
  if (!(await readdir(src).catch(() => null))) {
    for (let folder = 0; folder < SMALL_FOLDERS; folder += 1) await fill(path.join(src, `small-${folder}`), 100, () => 16 * 1024 + Math.floor(Math.random() * 240 * 1024));
    const chunk = randomBytes(1024 * 1024);
    for (let file = 0; file < LARGE_FILES; file += 1) await writeFile(path.join(src, `large-${file}.bin`), (async function* () { for (let mb = 0; mb < LARGE_MB; mb += 1) yield chunk; })());
  }
  // One of each for every round of each phase: nothing a probe asks about has been read before.
  for (let index = 0; index < ROUNDS * 2; index += 1) {
    await fill(path.join(root, "browse", `b${index}`), 200, () => 1024);
    await fill(path.join(root, "trash-me", `t${index}`), 100, () => 1024);
    await fill(path.join(root, "delete-me", `d${index}`), 100, () => 1024);
    await mkdir(path.join(root, "rename-me", `r${index}`), { recursive: true });
  }
  await mkdir(path.join(root, "made"), { recursive: true });
  console.log(`prepared ${root}`);
}

async function run() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const appData = await mkdtemp(path.join(tmpdir(), "kago-bench-app."));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = spawn(process.execPath, [path.join(repo, "apps/server/dist/main.js")], {
    env: { ...process.env, PORT: String(port), DATA_DIR: data, APP_DATA_DIR: appData },
    stdio: ["ignore", "ignore", "inherit"]
  });
  const base = `http://127.0.0.1:${port}`;
  let cookie = "";
  const call = async (method, url, body, accept = "application/json") => {
    const response = await fetch(base + url, {
      method,
      headers: { accept, ...(cookie ? { cookie } : {}), ...(method === "GET" ? {} : { "x-kago-csrf": "1" }), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    for (const value of response.headers.getSetCookie()) cookie = `${cookie ? `${cookie}; ` : ""}${value.split(";", 1)[0]}`;
    return response;
  };
  const json = async (method, url, body) => {
    const response = await call(method, url, body);
    const text = await response.text();
    if (!response.ok) throw new Error(`${method} ${url}: ${response.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };

  try {
    for (let attempt = 0; ; attempt += 1) {
      if (await fetch(`${base}/api/auth/setup`).then((response) => response.ok, () => false)) break;
      if (attempt > 200) throw new Error("server did not start");
      await sleep(100);
    }
    await json("POST", "/api/auth/setup", { email: "bench@example.test", password: "fake-bench-password-123", displayName: "Bench" });
    const slug = (await json("GET", "/api/roots")).find((item) => item.slug.startsWith("hdd")).slug;

    const settle = async (taskId, started) => {
      let running = null;
      for (;;) {
        const task = await json("GET", `/api/tasks/${taskId}`);
        if (running === null && task.status !== "queued") running = performance.now() - started;
        if (["done", "failed", "cancelled", "interrupted"].includes(task.status)) {
          if (task.status !== "done") throw new Error(`task ${task.type} ${task.status}: ${task.error ?? ""}`);
          return { waited: running };
        }
        if (performance.now() - started > PROBE_LIMIT_MS) {
          await json("POST", `/api/tasks/${taskId}/cancel`).catch(() => undefined);
          return { waited: running, gaveUp: true };
        }
        await sleep(25);
      }
    };
    const task = (type, folder) => async (index) => {
      const started = performance.now();
      const created = await json("POST", "/api/tasks", { type, sources: [{ rootSlug: slug, path: `/${folder}${index}` }] });
      return settle(created.id, started);
    };
    const probes = {
      ping: () => json("GET", "/api/roots").then(() => ({})),
      list: async (index) => {
        const started = performance.now();
        const response = await call("GET", `/api/fs/list?rootSlug=${slug}&path=${encodeURIComponent(`/browse/b${index}`)}`, undefined, "application/x-ndjson");
        if (!response.ok) throw new Error(`list: ${response.status}`);
        let first = null;
        let items = 0;
        let pending = "";
        for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
          pending += chunk;
          const lines = pending.split("\n");
          pending = lines.pop();
          for (const line of lines) {
            const value = JSON.parse(line);
            if (value.items) {
              first ??= performance.now() - started;
              items += value.items.length;
            }
          }
        }
        if (items !== 200) throw new Error(`list gave ${items} items`);
        return { first };
      },
      mkdir: (index) => json("POST", "/api/fs/mkdir", { rootSlug: slug, path: "/made", name: `m${index}` }).then(() => ({})),
      rename: (index) => json("POST", "/api/fs/rename", { rootSlug: slug, path: `/rename-me/r${index}`, name: `renamed-${index}` }).then(() => ({})),
      trash: task("delete_to_trash", "trash-me/t"),
      delete: task("delete", "delete-me/d")
    };

    const phase = async (offset, gapMs = 0) => {
      const samples = {};
      for (let round = 0; round < ROUNDS; round += 1) {
        if (round > 0) await sleep(gapMs);
        for (const [name, probe] of Object.entries(probes)) {
          const readsBefore = await diskReads();
          const started = performance.now();
          const limit = AbortSignal.timeout(PROBE_LIMIT_MS + 5000);
          const extra = await Promise.race([probe(offset + round), new Promise((resolve) => limit.addEventListener("abort", () => resolve({ gaveUp: true })))]);
          (samples[name] ??= []).push({ ms: Math.round(performance.now() - started), ...extra, ...(readsBefore === null ? {} : { diskReads: (await diskReads()) - readsBefore }) });
        }
      }
      return samples;
    };

    const idle = await phase(0);
    // What the copy carries when nobody asks for anything, to set beside what it carries between the probes.
    const alone = await (async () => {
      const copy = await json("POST", "/api/tasks", { type: "copy", sources: [{ rootSlug: slug, path: "/src" }], destination: { rootSlug: slug, path: "/made" } });
      const read = () => json("GET", `/api/tasks/${copy.id}`);
      let from = await read();
      while (from.processed_bytes === 0) {
        await sleep(100);
        from = await read();
      }
      const started = performance.now();
      await sleep(ALONE_MS);
      let state = await read();
      const seconds = (performance.now() - started) / 1000;
      const rate = { mbPerSecond: Math.round(((state.processed_bytes - from.processed_bytes) / 1e6 / seconds) * 10) / 10, filesPerSecond: Math.round((state.processed_files - from.processed_files) / seconds) };
      await json("POST", `/api/tasks/${copy.id}/cancel`).catch(() => undefined);
      while (["queued", "running", "cancelling"].includes(state.status)) {
        await sleep(200);
        state = await read();
      }
      await rm(path.join(root, "made", "src"), { recursive: true, force: true, maxRetries: 5 });
      return rate;
    })();
    // One copy after another for as long as the probes take, so that every one of them is asked under load.
    const load = { stop: false, copies: 0, bytes: 0, last: "" };
    const copying = (async () => {
      while (!load.stop) {
        const copy = await json("POST", "/api/tasks", { type: "copy", sources: [{ rootSlug: slug, path: "/src" }], destination: { rootSlug: slug, path: "/made" } });
        let state = copy;
        while (!load.stop && ["queued", "running"].includes(state.status)) {
          await sleep(200);
          state = await json("GET", `/api/tasks/${copy.id}`);
        }
        if (load.stop) {
          await json("POST", `/api/tasks/${copy.id}/cancel`).catch(() => undefined);
          // A copy told to stop takes back what it made, and is over only once it has.
          while (["queued", "running", "cancelling"].includes(state.status)) {
            await sleep(200);
            state = await json("GET", `/api/tasks/${copy.id}`);
          }
        }
        load.copies += 1;
        load.bytes += state.processed_bytes;
        load.last = state.status;
        if (state.status === "failed") throw new Error(`copy failed: ${state.error ?? ""}`);
        await rm(path.join(root, "made", "src"), { recursive: true, force: true, maxRetries: 5 });
      }
    })();
    // The copy is under way once it has carried something.
    for (;;) {
      const running = (await json("GET", "/api/tasks")).find?.((item) => item.type === "copy" && item.processed_bytes > 0);
      if (running) break;
      await sleep(100);
    }
    const loadStarted = performance.now();
    // Spread out, so that the rounds meet the copy at its small files and its large ones, and the disk with a backlog.
    const loaded = await phase(ROUNDS, ROUND_GAP_MS);
    const seconds = (performance.now() - loadStarted) / 1000;
    load.stop = true;
    await copying;

    const summary = (samples) =>
      Object.fromEntries(
        Object.entries(samples).map(([name, list]) => {
          const ms = list.map((sample) => sample.ms).sort((a, b) => a - b);
          return [name, { median: ms[Math.floor(ms.length / 2)], max: ms.at(-1), gaveUp: list.filter((sample) => sample.gaveUp).length, samples: list }];
        })
      );
    const result = {
      label: process.env.BENCH_LABEL ?? "",
      rounds: ROUNDS,
      probeLimitMs: PROBE_LIMIT_MS,
      // How hard the disk was worked meanwhile: the copies started, and what they carried a second.
      copyAlone: alone,
      load: { copies: load.copies, seconds: Math.round(seconds), mbPerSecond: Math.round(load.bytes / 1e6 / seconds) },
      idle: summary(idle),
      loaded: summary(loaded)
    };
    if (process.env.BENCH_OUT) await writeFile(process.env.BENCH_OUT, JSON.stringify(result, null, 2));
    console.log(`copy alone: ${alone.mbPerSecond} MB/s, ${alone.filesPerSecond} files/s`);
    console.log(`load: ${load.copies} copies over ${Math.round(seconds)} s, ${result.load.mbPerSecond} MB/s`);
    console.table(Object.fromEntries(Object.keys(probes).map((name) => [name, { "idle median": result.idle[name].median, "idle max": result.idle[name].max, "loaded median": result.loaded[name].median, "loaded max": result.loaded[name].max, "gave up": result.loaded[name].gaveUp }])));
  } finally {
    server.kill("SIGKILL");
    await rm(appData, { recursive: true, force: true }).catch(() => undefined);
  }
}
