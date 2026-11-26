import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { giveWay, requestBegins, requestsUnderWay } from "../src/lib/give-way.ts";
import { copyTree } from "../src/lib/tree-ops.ts";

const settled = async (promise) => Promise.race([promise.then(() => true), sleep(60).then(() => false)]);

test("a walk goes on at once while nobody is waiting on a request", async () => {
  assert.equal(await settled(giveWay()), true);
});

test("a walk stands aside until every request under way is answered", async () => {
  const first = requestBegins();
  const second = requestBegins();
  const waiting = giveWay();
  assert.equal(await settled(waiting), false);
  first();
  // Said twice of one request, it is still counted once.
  first();
  assert.equal(await settled(waiting), false);
  second();
  assert.equal(await settled(waiting), true);
});

test("a copy carries nothing while a request is under way, and all of it afterwards", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "kago-give-way."));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "a.txt"), "carried");
  const answered = requestBegins();
  const copying = copyTree(path.join(dir, "a.txt"), path.join(dir, "b.txt"), () => undefined);
  await sleep(80);
  await assert.rejects(readFile(path.join(dir, "b.txt")));
  answered();
  await copying;
  assert.equal(await readFile(path.join(dir, "b.txt"), "utf8"), "carried");
});

test("a worker goes by the requests the main thread counts", async () => {
  const worker = new Worker(
    `import { parentPort, workerData } from "node:worker_threads";
     const { giveWay, watchRequests } = await import(workerData.module);
     watchRequests(workerData.requests);
     parentPort.on("message", async () => { await giveWay(); parentPort.postMessage("went on"); });
     parentPort.postMessage("ready");`,
    { eval: true, workerData: { module: new URL("../src/lib/give-way.ts", import.meta.url).href, requests: requestsUnderWay() } }
  );
  try {
    const said = () => new Promise((resolve) => worker.once("message", resolve));
    await said();
    const answered = requestBegins();
    const went = said();
    worker.postMessage("go");
    assert.equal(await settled(went), false);
    answered();
    assert.equal(await went, "went on");
  } finally {
    await worker.terminate();
  }
});
