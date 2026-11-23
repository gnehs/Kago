import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db/db.ts";
import { jobIdOf } from "../src/services/job-run.ts";
import { taskChanges, taskKinds } from "../src/services/task-kinds.ts";
import { TaskService } from "../src/services/task.service.ts";

const lanes = {
  copy: "files",
  move: "files",
  delete_to_trash: "files",
  delete: "files",
  restore_trash: "files",
  empty_trash: "files",
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
    const other = lane === "media" ? "files" : "media";
    assert.equal(tasks.claimNext(other), null, `the ${other} worker leaves a ${type}`);
    assert.equal(tasks.claimNext(lane)?.type, type, `the ${lane} worker takes a ${type}`);
  }
});

test("a destination that is not a job run names no job", () => {
  assert.equal(jobIdOf({ type: "sync", destination: "{" }), null);
  assert.equal(jobIdOf({ type: "convert", destination: "null" }), null);
});
