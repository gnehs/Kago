import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildApp } from "../dist/app.js";
import { openDb } from "../src/db/db.ts";
import { SecretBox } from "../src/lib/secret-box.ts";
import { AuditService } from "../src/services/audit.service.ts";
import { AuthService } from "../src/services/auth.service.ts";
import { FsService } from "../src/services/fs.service.ts";
import { PathService } from "../src/services/path.service.ts";
import { PermissionService } from "../src/services/permission.service.ts";
import { PreferenceService } from "../src/services/preference.service.ts";
import { RootService } from "../src/services/root.service.ts";
import { StorageService } from "../src/services/storage.service.ts";
import { TaskService } from "../src/services/task.service.ts";
import { RcloneClient, rcloneSocketPath } from "../src/storage/rclone-client.ts";
import { RemoteStorage } from "../src/storage/remote-storage.ts";
import { client, waitFor, waitTask } from "./helpers.mjs";

const testEnv = (fixture) => ({ port: 0, dataDir: fixture.dataDir, appDataDir: fixture.appDataDir, sessionSecret: "trash-contents-test-session-secret", nodeEnv: "test" });

test("the Trash records what each item is, which action threw it away and whose it is, and what it lists stays within who may see it", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "kago-trash-contents."));
  const fixture = { dataDir: path.join(baseDir, "data"), appDataDir: path.join(baseDir, "app-data") };
  const photos = path.join(fixture.dataDir, "photos");
  await mkdir(path.join(photos, "folder", "sub"), { recursive: true });
  await mkdir(path.join(fixture.dataDir, "other"), { recursive: true });
  await mkdir(fixture.appDataDir, { recursive: true });
  await writeFile(path.join(photos, "a.txt"), "aaa");
  await writeFile(path.join(photos, "b.txt"), "bbbbb");
  await writeFile(path.join(photos, "keep.txt"), "kk");
  await writeFile(path.join(photos, "mine.txt"), "mine!");
  await writeFile(path.join(photos, "folder", "x.bin"), Buffer.alloc(10));
  await writeFile(path.join(photos, "folder", "sub", "y.bin"), Buffer.alloc(20));
  await symlink("x.bin", path.join(photos, "folder", "link"));
  await writeFile(path.join(fixture.dataDir, "other", "other.txt"), "other");

  let app = await buildApp(testEnv(fixture));
  let admin = client(app);
  let member = client(app);
  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" })).statusCode, 200);
    const roots = Object.fromEntries((await admin.get("/api/roots")).json.map((root) => [root.slug, root]));
    const created = await admin.post("/api/users", { email: "member@example.test", password: "fake-member-password-123", displayName: "Member", role: "USER" });
    assert.equal(created.statusCode, 200);
    const memberId = created.json.id;
    for (const slug of ["photos", "other"]) {
      assert.equal((await admin.put("/api/permissions", { principalType: "user", principalId: memberId, rootId: roots[slug].id, level: "edit" })).statusCode, 200);
    }
    assert.equal((await member.post("/api/auth/login", { email: "member@example.test", password: "fake-member-password-123" })).statusCode, 200);

    const run = async (who, type, sources) => {
      const response = await who.post("/api/tasks", { type, sources });
      assert.equal(response.statusCode, 200, response.payload);
      return waitTask(who, response.json.id);
    };
    const own = (slug, ...names) => names.map((name) => ({ rootSlug: slug, path: `/${name}` }));
    const byPath = (items) => Object.fromEntries(items.map((item) => [item.original_path, item]));

    const first = await run(admin, "delete_to_trash", own("photos", "a.txt", "b.txt", "folder"));
    assert.equal(first.status, "done");
    const second = await run(admin, "delete_to_trash", own("photos", "keep.txt"));
    const memberTask = await run(member, "delete_to_trash", [...own("photos", "mine.txt"), ...own("other", "other.txt")]);

    // A folder is added up after the task, in the Trash; its row is null until then.
    await waitFor(async () => (await admin.get("/api/trash")).json.find((item) => item.original_path === "/folder")?.size != null, "the folder's size");
    let items = byPath((await admin.get("/api/trash")).json);
    assert.deepEqual(
      ["/a.txt", "/b.txt", "/folder", "/keep.txt"].map((name) => [name, items[name].kind, items[name].size, items[name].item_count, items[name].deletion_id]),
      [["/a.txt", "file", 3, null, first.id], ["/b.txt", "file", 5, null, first.id], ["/folder", "folder", 30, 4, first.id], ["/keep.txt", "file", 2, null, second.id]],
      "one action gives its items one deletion id; a folder holds what is in it, a symlink counting as an entry of no size"
    );
    assert.notEqual(first.id, second.id);
    assert.deepEqual(items["/a.txt"].deleter, { id: items["/a.txt"].deleted_by, email: "admin@example.test", display_name: "Admin", avatar_at: null });
    assert.equal(items["/mine.txt"].deleter.email, "member@example.test", "an admin sees whose each one is");
    assert.equal(items["/mine.txt"].deletion_id, memberTask.id);

    const seen = (await member.get("/api/trash")).json;
    assert.deepEqual(seen.map((item) => item.original_path).sort(), ["/mine.txt", "/other.txt"]);
    assert.ok(seen.every((item) => item.deleter.email === "member@example.test"), "a member sees no one else's item or who owns it");
    assert.equal((await member.post(`/api/trash/${items["/a.txt"].id}/restore`)).statusCode, 404);

    // Items of a location they lost access to are still theirs to see; putting them back needs the access again.
    assert.equal((await admin.put("/api/permissions", { principalType: "user", principalId: memberId, rootId: roots.other.id, level: "view" })).statusCode, 200);
    assert.equal((await member.get("/api/trash")).json.length, 2);
    assert.equal((await member.post("/api/tasks", { type: "restore_trash", sources: [{ rootSlug: "trash", path: seen.find((item) => item.original_path === "/other.txt").id }] })).statusCode, 403);

    // Taking one item for good, by name, leaves the rest and what is not the member's alone.
    const trashDir = path.join(photos, ".kago-trash");
    const before = (await readdir(trashDir)).length;
    assert.equal((await run(member, "empty_trash", [{ rootSlug: "trash", path: items["/a.txt"].id }])).status, "done");
    assert.equal((await admin.get("/api/trash")).json.find((item) => item.original_path === "/a.txt")?.id, items["/a.txt"].id, "another user's item is passed over");
    const gone = await run(admin, "empty_trash", [{ rootSlug: "trash", path: items["/a.txt"].id }]);
    assert.deepEqual([gone.status, gone.processed_files], ["done", 1]);
    assert.equal((await readdir(trashDir)).length, before - 1);
    items = byPath((await admin.get("/api/trash")).json);
    assert.deepEqual(Object.keys(items).sort(), ["/b.txt", "/folder", "/keep.txt", "/mine.txt", "/other.txt"]);
    const logged = (await admin.get("/api/audit")).json.find((entry) => entry.action === "trash_empty" && entry.path === "/a.txt");
    assert.ok(logged, "one item removed for good is named in the audit log");

    // A group goes back together, under another name where something has taken its own.
    await writeFile(path.join(photos, "b.txt"), "taken");
    const restored = await run(admin, "restore_trash", [{ rootSlug: "trash", path: items["/b.txt"].id }, { rootSlug: "trash", path: items["/folder"].id }]);
    assert.equal(restored.status, "done");
    assert.equal(await readFile(path.join(photos, "b 2.txt"), "utf8"), "bbbbb");
    assert.equal(await readFile(path.join(photos, "folder", "sub", "y.bin")).then((data) => data.length), 20);
    assert.deepEqual(Object.keys(byPath((await admin.get("/api/trash")).json)).sort(), ["/keep.txt", "/mine.txt", "/other.txt"]);

    // A batch with an item whose file has gone from the Trash fails before anything is moved: all of it stays listed.
    await writeFile(path.join(photos, "p.txt"), "p");
    await writeFile(path.join(photos, "q.txt"), "q");
    await run(admin, "delete_to_trash", own("photos", "p.txt", "q.txt"));
    const pending = byPath((await admin.get("/api/trash")).json);
    const entry = (await readdir(trashDir)).find((name) => name.endsWith("-q.txt"));
    await rm(path.join(trashDir, entry));
    const partial = await run(admin, "restore_trash", [{ rootSlug: "trash", path: pending["/p.txt"].id }, { rootSlug: "trash", path: pending["/q.txt"].id }]);
    assert.equal(partial.status, "failed");
    assert.ok(!(await readdir(photos)).some((name) => name === "p.txt" || name === "q.txt"));
    const stillListed = byPath((await admin.get("/api/trash")).json);
    assert.ok(stillListed["/p.txt"] && stillListed["/q.txt"]);

    // The database is upgraded in place: what was trashed before has no record of its kind, size or action.
    await app.close();
    const db = new DatabaseSync(path.join(fixture.appDataDir, "app.db"));
    for (const column of ["kind", "size", "item_count", "deletion_id"]) db.exec(`ALTER TABLE trash_items DROP COLUMN ${column}`);
    db.close();
    app = await buildApp(testEnv(fixture));
    await app.ready();
    admin = client(app);
    member = client(app);
    assert.equal((await admin.post("/api/auth/login", { email: "admin@example.test", password: "fake-admin-password-123" })).statusCode, 200);
    const older = (await admin.get("/api/trash")).json;
    assert.ok(older.length >= 3);
    for (const item of older) assert.deepEqual([item.kind, item.size, item.item_count, item.deletion_id], [null, null, null, null]);
    assert.ok(older.every((item) => item.deleter.email));
    const keep = older.find((item) => item.original_path === "/keep.txt");
    assert.equal((await run(admin, "restore_trash", [{ rootSlug: "trash", path: keep.id }])).status, "done");
    assert.equal(await readFile(path.join(photos, "keep.txt"), "utf8"), "kk");
    await run(admin, "delete_to_trash", own("photos", "keep.txt"));
    const fresh = (await admin.get("/api/trash")).json.find((item) => item.original_path === "/keep.txt");
    assert.deepEqual([fresh.kind, fresh.size], ["file", 2]);
  } finally {
    await app.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});

/** Tasks run in this thread, as a worker runs them, with the reads of the Trash's folders held back so that what happens meanwhile is not left to timing. */
async function trashHarness(t) {
  const baseDir = await fsp.realpath(await mkdtemp(path.join(tmpdir(), "kago-trash-measure.")));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  await mkdir(path.join(dataDir, "family"), { recursive: true });
  await mkdir(path.join(appDataDir, "trash"), { recursive: true });
  const env = { port: 0, dataDir, appDataDir, sessionSecret: "trash-measure-test-session-secret", nodeEnv: "test" };
  const db = openDb(env);
  const events = [];
  const publisher = { publish: (event) => events.push(event) };
  const audit = new AuditService(db);
  const roots = new RootService(db, dataDir, new SecretBox(appDataDir));
  roots.syncFromDataDir();
  const remote = new RemoteStorage(new RcloneClient(rcloneSocketPath(appDataDir)), roots, env);
  const storage = new StorageService(remote);
  const paths = new PathService(roots, remote);
  const permissions = new PermissionService(db, audit);
  const preferences = new PreferenceService(db, roots, paths, publisher);
  const tasks = new TaskService(db, paths, permissions, audit, publisher, appDataDir, new FsService(paths, permissions, audit, storage, appDataDir, preferences), storage, preferences);
  const user = await new AuthService(db, env).createUser({ email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin", role: "ADMIN" }, true);
  const actor = { id: user.id, email: user.email, displayName: "Admin", role: "ADMIN", disabled: false };

  const family = path.join(dataDir, "family");
  const trashDir = path.join(family, ".kago-trash");
  const reads = { source: [], trash: [] };
  let gate = Promise.resolve();
  let held = () => true;
  const originals = { ...fsp };
  fsp.readdir = (dir, ...rest) => {
    if (String(dir).startsWith(trashDir + path.sep)) {
      reads.trash.push(String(dir));
      return (held(String(dir)) ? gate : Promise.resolve()).then(() => originals.readdir(dir, ...rest));
    }
    if (String(dir).startsWith(family + path.sep)) reads.source.push(String(dir));
    return originals.readdir(dir, ...rest);
  };
  const failures = [];
  const noteFailure = (error) => failures.push(error);
  process.on("unhandledRejection", noteFailure);
  process.on("uncaughtException", noteFailure);
  t.after(async () => {
    process.off("unhandledRejection", noteFailure);
    process.off("uncaughtException", noteFailure);
    Object.assign(fsp, originals);
    db.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  const hold = (only = () => true) => {
    held = only;
    let open;
    gate = new Promise((resolve) => (open = resolve));
    return open;
  };
  const folder = async (name, files) => {
    for (const [file, size] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(family, name, file)), { recursive: true });
      await writeFile(path.join(family, name, file), Buffer.alloc(size));
    }
  };
  const trash = async (...names) => {
    const created = await tasks.create(actor, { type: "delete_to_trash", sources: names.map((name) => ({ rootSlug: "family", path: `/${name}` })) });
    const claimed = tasks.claimNext("files");
    assert.equal(claimed.id, created.id);
    await tasks.runTask(claimed, actor);
    return tasks.get(created.id);
  };
  const itemOf = (name) => db.prepare("SELECT * FROM trash_items WHERE original_path = ?").get(`/${name}`);
  const yieldAWhile = async () => {
    for (let turn = 0; turn < 30; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const heard = () => events.filter((event) => event.type === "trash.updated");
  return { actor, family, trashDir, db, tasks, events, reads, failures, hold, folder, trash, itemOf, yieldAWhile, heard, originals };
}

test("a folder on the Trash's disk is renamed in unread, then added up where it lies, and only if nothing has happened to it since", async (t) => {
  const h = await trashHarness(t);
  const shape = { "a.bin": 7, "sub/b.bin": 11, "sub/deep/c.bin": 13 };

  await h.folder("kept", shape);
  const release = h.hold();
  const task = await h.trash("kept");
  assert.equal(task.status, "done");
  assert.deepEqual(h.reads.source, [], "the folder was never read where it lay");
  assert.ok(!h.events.some((event) => event.type === "task.progress" && event.patch.phase === "counting"), "the task never counted");
  await waitFor(() => h.reads.trash.length > 0, "the measuring to begin");
  const pending = h.itemOf("kept");
  assert.deepEqual([pending.kind, pending.size, pending.item_count], ["folder", null, null], "the row is there, unmeasured, as the task is done");
  release();
  await h.tasks.trash.settled();
  const done = h.itemOf("kept");
  assert.deepEqual([done.size, done.item_count], [31, 5], "the sum is of the files; folders inside count among the entries");
  assert.deepEqual(h.heard(), [{ type: "trash.updated", userId: h.actor.id }]);

  // Put back while it is being read: nothing is written, and what the walk did not find is no size.
  await h.folder("restored", shape);
  const openRestored = h.hold();
  await h.trash("restored");
  const restoring = h.itemOf("restored");
  await waitFor(() => h.reads.trash.some((dir) => dir.endsWith("-restored")), "the measuring to begin");
  await rename(restoring.trash_path, path.join(h.family, "restored"));
  h.tasks.trash.markRestored(restoring.id);
  const before = h.heard().length;
  openRestored();
  await h.tasks.trash.settled();
  const after = h.itemOf("restored");
  assert.deepEqual([after.size, after.item_count, after.restored_at !== null], [null, null, true]);
  assert.equal(h.heard().length, before, "nobody is told of what was not written");

  // Taken away for good meanwhile: no row to write into, and a walk that loses what it walks does not throw.
  await h.folder("removed", shape);
  const openRemoved = h.hold();
  await h.trash("removed");
  const removing = h.itemOf("removed");
  await waitFor(() => h.reads.trash.some((dir) => dir.endsWith("-removed")), "the measuring to begin");
  await rm(removing.trash_path, { recursive: true });
  h.db.prepare("DELETE FROM trash_items WHERE id = ?").run(removing.id);
  openRemoved();
  await h.tasks.trash.settled();
  assert.equal(h.itemOf("removed"), undefined);
  assert.equal(h.heard().length, before);

  // A tree that loses part of itself under the walk is not added up short.
  await h.folder("shrinking", shape);
  const openShrinking = h.hold((dir) => dir.endsWith(`${path.sep}sub`));
  await h.trash("shrinking");
  const shrinking = h.itemOf("shrinking");
  await waitFor(() => h.reads.trash.some((dir) => dir.endsWith(`-shrinking${path.sep}sub`)), "the measuring to reach the inner folder");
  await rm(path.join(shrinking.trash_path, "sub"), { recursive: true });
  openShrinking();
  await h.tasks.trash.settled();
  assert.deepEqual([h.itemOf("shrinking").size, h.itemOf("shrinking").item_count], [null, null]);
  assert.deepEqual(h.failures, [], "nothing was thrown into nowhere");
});

test("many folders thrown away at once are measured one walk at a time, and the ones left unmeasured are picked up again", async (t) => {
  const h = await trashHarness(t);
  const names = ["one", "two", "three", "four", "five"];
  for (const name of names) await h.folder(name, { "x.bin": 5, "inner/y.bin": 6 });
  const release = h.hold();
  assert.equal((await h.trash(...names)).status, "done");
  await waitFor(() => h.reads.trash.length > 0, "the measuring to begin");
  await h.yieldAWhile();
  assert.equal(h.reads.trash.length, 1, "one folder is being read, the rest wait their turn");
  release();
  await h.tasks.trash.settled();
  for (const name of names) assert.deepEqual([h.itemOf(name).size, h.itemOf(name).item_count], [11, 3]);
  assert.equal(h.heard().length, 1, "everyone who is looking is told once");

  // As if the server had stopped partway: the next worker to start measures what was left.
  h.db.prepare("UPDATE trash_items SET size = NULL, item_count = NULL").run();
  await h.tasks.trash.measureLeftover();
  await h.tasks.trash.settled();
  for (const name of names) assert.deepEqual([h.itemOf(name).size, h.itemOf(name).item_count], [11, 3]);
});

test("a folder that has to be copied to the Trash's disk is still counted by the task, and recorded whole", async (t) => {
  const h = await trashHarness(t);
  await h.folder("far", { "x.bin": 5, "inner/y.bin": 6 });
  // The Trash is reported to lie on another disk; the walk itself reads what is really there.
  fsp.stat = async (target, ...rest) => {
    const stat = await h.originals.stat(target, ...rest);
    return String(target).endsWith(".kago-trash") ? Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { dev: stat.dev + 1 }) : stat;
  };
  t.after(() => Object.assign(fsp, { stat: h.originals.stat }));
  assert.equal((await h.trash("far")).status, "done");
  assert.ok(h.reads.source.length > 0, "the task read it through before moving it");
  const item = h.itemOf("far");
  assert.deepEqual([item.size, item.item_count], [11, 3]);
  await h.tasks.trash.settled();
  assert.equal(h.heard().length, 0, "nothing was left to add up");
});
