import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db/db.ts";
import { jobIdOf } from "../src/services/job-run.ts";
import { nextToStart, taskChanges, taskKinds, taskLanes } from "../src/services/task-kinds.ts";
import { TaskService } from "../src/services/task.service.ts";

const lanes = {
  copy: "files",
  move: "files",
  delete_to_trash: "removal",
  delete: "removal",
  restore_trash: "removal",
  empty_trash: "removal",
  compress: "files",
  download_zip: "files",
  extract: "files",
  thumbnail: "files",
  sync: "files",
  convert: "media",
  remux: "media"
};

/** Finished tasks of every type, with what the code before the table of kinds announced for each and the job it named. */
const finished = {
copy: {
    task: {"type":"copy","sources":[{"rootSlug":"media","path":"/a/one.txt"},{"rootSlug":"docs","path":"/b/two.txt"}],"destination":{"rootSlug":"media","path":"/out","options":{}}},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":["/out"]}],
    jobId: null
  },
  copy_no_destination: {
    task: {"type":"copy","sources":[{"rootSlug":"media","path":"/a/one.txt"}],"destination":null},
    changes: [],
    jobId: null
  },
  move: {
    task: {"type":"move","sources":[{"rootSlug":"media","path":"/a/one.txt"},{"rootSlug":"docs","path":"/b/two.txt"}],"destination":{"rootSlug":"media","path":"/out","options":{"conflicts":{"one.txt":"replace"}}}},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":["/out","/a"],"gone":["/a/one.txt"]},{"type":"fs.changed","rootSlug":"docs","paths":["/b"],"gone":["/b/two.txt"]}],
    jobId: null
  },
  delete_to_trash: {
    task: {"type":"delete_to_trash","sources":[{"rootSlug":"media","path":"/a/one.txt"},{"rootSlug":"media","path":"/a/two.txt"}],"destination":null},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":["/a"],"gone":["/a/one.txt","/a/two.txt"]}],
    jobId: null
  },
  delete: {
    task: {"type":"delete","sources":[{"rootSlug":"media","path":"/a/one.txt"},{"rootSlug":"docs","path":"/b"}],"destination":null},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":["/a"],"gone":["/a/one.txt"]},{"type":"fs.changed","rootSlug":"docs","paths":["/"],"gone":["/b"]}],
    jobId: null
  },
  restore_trash: {
    task: {"type":"restore_trash","sources":[{"rootSlug":"trash","path":"trash_1"},{"rootSlug":"trash","path":"trash_gone"}],"destination":null},
    changes: [{"type":"fs.changed","rootSlug":"photos","paths":["/2024"]}],
    jobId: null
  },
  empty_trash: {
    task: {"type":"empty_trash","sources":[{"rootSlug":"trash","path":"trash_1"}],"destination":null},
    changes: [],
    jobId: null
  },
  compress: {
    task: {"type":"compress","sources":[{"rootSlug":"media","path":"/a"}],"destination":{"rootSlug":"media","path":"/out/a.zip","options":{"level":"normal"}}},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":["/out"]}],
    jobId: null
  },
  download_zip: {
    task: {"type":"download_zip","sources":[{"rootSlug":"media","path":"/a"}],"destination":{"fileName":"a.zip"}},
    changes: [],
    jobId: null
  },
  extract: {
    task: {"type":"extract","sources":[{"rootSlug":"media","path":"/out/a.zip"}],"destination":{"rootSlug":"media","path":"/ext","options":{}}},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":[],"trees":["/ext"]}],
    jobId: null
  },
  thumbnail: {
    task: {"type":"thumbnail","sources":[{"rootSlug":"media","path":"/a/pic.png"}],"destination":null},
    changes: [],
    jobId: null
  },
  sync: {
    task: {"type":"sync","sources":[{"rootSlug":"media","path":"/in"}],"destination":{"sync":{"jobId":"sync_1","name":"Backup","source":{"kind":"location","rootSlug":"media","path":"/in"},"destination":{"kind":"location","rootSlug":"docs","path":"/backup"},"options":{"mode":"copy","dryRun":false}}}},
    changes: [{"type":"fs.changed","rootSlug":"docs","paths":[],"trees":["/backup"]}],
    jobId: "sync_1"
  },
  sync_trial: {
    task: {"type":"sync","sources":[{"rootSlug":"media","path":"/in"}],"destination":{"sync":{"jobId":"sync_1","name":"Backup","source":{"kind":"location","rootSlug":"media","path":"/in"},"destination":{"kind":"location","rootSlug":"docs","path":"/backup"},"options":{"mode":"mirror","dryRun":true}}}},
    changes: [],
    jobId: "sync_1"
  },
  sync_no_job: {
    task: {"type":"sync","sources":[{"rootSlug":"media","path":"/in"}],"destination":{"sync":{"name":"Backup","source":{"kind":"location","rootSlug":"media","path":"/in"},"destination":{"kind":"location","rootSlug":"media","path":"/backup"},"options":{"mode":"copy","dryRun":false}}}},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":[],"trees":["/backup"]}],
    jobId: null
  },
  convert: {
    task: {"type":"convert","sources":[{"rootSlug":"media","path":"/v/clip.mp4"}],"destination":{"rootSlug":"media","path":"/out","convert":{"format":"mkv"}}},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":["/out"]}],
    jobId: null
  },
  convert_job: {
    task: {"type":"convert","sources":[{"rootSlug":"media","path":"/in/clip.mp4"}],"destination":{"rootSlug":"media","path":"/out","convert":{"format":"mkv"},"job":{"id":"cjob_1","input":{"rootSlug":"docs","path":"/in"},"options":{}}}},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":[],"trees":["/out"]},{"type":"fs.changed","rootSlug":"docs","paths":[],"trees":["/in"]}],
    jobId: "cjob_1"
  },
  remux: {
    task: {"type":"remux","sources":[{"rootSlug":"media","path":"/v/clip.mp4"}],"destination":{"rootSlug":"media","path":"/v","remux":{"name":"clip.mkv"}}},
    changes: [{"type":"fs.changed","rootSlug":"media","paths":["/v"]}],
    jobId: null
  }
};

async function fixture(t) {
  const appDataDir = await mkdtemp(path.join(tmpdir(), "kago-task-kinds-"));
  const db = openDb({ appDataDir });
  db.prepare("INSERT INTO users (id, email, password_hash, display_name, role, created_at, updated_at) VALUES ('user_admin', 'admin@example.test', 'x', 'Admin', 'ADMIN', 0, 0)").run();
  db.prepare("INSERT INTO roots (id, slug, name, base_path, created_at, updated_at) VALUES ('root_photos', 'photos', 'Photos', '/photos', 0, 0)").run();
  db.prepare("INSERT INTO trash_items (id, original_root_id, original_path, trash_path, deleted_by, deleted_at) VALUES ('trash_1', 'root_photos', '/2024/cat.jpg', '/t', 'user_admin', 0)").run();
  t.after(async () => {
    db.close();
    await rm(appDataDir, { recursive: true, force: true });
  });
  return { db, appDataDir };
}

test("every task type has a kind", () => {
  assert.deepEqual(Object.keys(taskKinds).sort(), Object.keys(lanes).sort());
  assert.deepEqual([...new Set(Object.values(finished).map((example) => example.task.type))].sort(), Object.keys(lanes).sort(), "every type has a finished example");
});

for (const [name, example] of Object.entries(finished)) {
  test(`a finished ${name} announces what it changed and names its job as before`, async (t) => {
    const { db } = await fixture(t);
    const task = { id: "task_1", type: example.task.type, sources_json: JSON.stringify(example.task.sources), destination: example.task.destination === null ? null : JSON.stringify(example.task.destination) };
    assert.deepEqual(taskChanges(db, task), example.changes);
    assert.equal(jobIdOf(task), example.jobId);
  });
}

test("each type waits in the lane it did", async (t) => {
  const { db, appDataDir } = await fixture(t);
  const tasks = new TaskService(db, null, null, { write() {} }, { publish() {} }, appDataDir, null, null, null);
  for (const [type, lane] of Object.entries(lanes)) {
    db.prepare("INSERT INTO tasks (id, type, status, created_by, sources_json, created_at, updated_at) VALUES (?, ?, 'queued', 'user_admin', '[]', 1, 1)").run(`task_${type}`, type);
    for (const other of taskLanes.filter((name) => name !== lane)) assert.equal(tasks.claimNext(other), null, `the ${other} worker leaves a ${type}`);
    assert.equal(tasks.claimNext(lane)?.type, type, `the ${lane} worker takes a ${type}`);
  }
});

test("a destination that is not a job run names no job", () => {
  assert.equal(jobIdOf({ type: "sync", destination: "{" }), null);
  assert.equal(jobIdOf({ type: "convert", destination: "null" }), null);
});

test("the thread pool has room for every lane working flat out, and for requests beside them", async () => {
  const { threadPoolSize } = await import("../src/config/threadpool.ts");
  const { treeConcurrency } = await import("../src/lib/tree-ops.ts");
  assert.ok(threadPoolSize >= taskLanes.length * treeConcurrency + treeConcurrency);
});

const waiting = (type, sources, destination, status = "queued") => ({ type, status, sources_json: JSON.stringify(sources.map((path) => ({ rootSlug: "media", path }))), destination: destination ? JSON.stringify({ rootSlug: "media", path: destination }) : null });

test("a deletion does not wait for a copy it has nothing to do with", () => {
  const copy = waiting("copy", ["/films"], "/backup", "running");
  const unrelated = waiting("delete_to_trash", ["/old"]);
  assert.equal(nextToStart("removal", [copy, unrelated]), unrelated);
  // Something else in the folder copied into is no part of the copy either.
  const beside = waiting("delete", ["/backup/notes.txt"]);
  assert.equal(nextToStart("removal", [copy, beside]), beside);
});

test("what was asked for after a task that touches the same paths waits for it", () => {
  const copy = waiting("copy", ["/films"], "/backup", "running");
  for (const path of ["/films", "/films/one.mkv", "/", "/backup/films", "/backup/films/one.mkv"]) {
    assert.equal(nextToStart("removal", [copy, waiting("delete_to_trash", [path])]), null, path);
  }
  // A copy still waiting its turn holds them back as much as one under way.
  assert.equal(nextToStart("removal", [waiting("copy", ["/films"], "/backup"), waiting("delete", ["/films"])]), null);
  // And the other way about: nothing is copied out of a folder that is still being thrown away.
  assert.equal(nextToStart("files", [waiting("delete", ["/films"], null, "running"), waiting("copy", ["/films/one.mkv"], "/backup")]), null);
});

test("a task asked for before another never waits for it", () => {
  const removal = waiting("delete", ["/films"]);
  const copy = waiting("copy", ["/films"], "/backup");
  assert.equal(nextToStart("removal", [removal, copy]), removal);
  assert.equal(nextToStart("files", [removal, copy]), null);
});

test("one that has to wait lets the next of its lane by, unless that one waits for it in turn", () => {
  const copy = waiting("copy", ["/films"], "/backup", "running");
  const held = waiting("delete", ["/films"]);
  const free = waiting("delete", ["/old"]);
  assert.equal(nextToStart("removal", [copy, held, free]), free);
  assert.equal(nextToStart("removal", [copy, held, waiting("delete", ["/films/one.mkv"])]), null);
});
