import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openDb } from "../src/db/db.ts";
import { SecretBox } from "../src/lib/secret-box.ts";
import { AuditService } from "../src/services/audit.service.ts";
import { AuthService } from "../src/services/auth.service.ts";
import { FsService } from "../src/services/fs.service.ts";
import { foldersOverlap, PathService } from "../src/services/path.service.ts";
import { PermissionService } from "../src/services/permission.service.ts";
import { PreferenceService } from "../src/services/preference.service.ts";
import { RootService } from "../src/services/root.service.ts";
import { StorageService } from "../src/services/storage.service.ts";
import { TaskService } from "../src/services/task.service.ts";
import { RcloneClient, rcloneSocketPath } from "../src/storage/rclone-client.ts";
import { RemoteStorage } from "../src/storage/remote-storage.ts";

/**
 * Tasks run here in the test's own thread, the way a task worker runs them, so that what the disk does can be
 * changed underneath them: a rename that finds another disk, a copy that fails half way.
 */
async function harness(t, folders = ["family", "other"]) {
  // Spelled the way the disk has it, as tasks see their paths: the temp dir may lie behind a symlink.
  const baseDir = await fsp.realpath(await mkdtemp(path.join(tmpdir(), "kago-file-safety.")));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  for (const folder of folders) await mkdir(path.join(dataDir, folder), { recursive: true });
  for (const folder of ["trash", "temp"]) await mkdir(path.join(appDataDir, folder), { recursive: true });
  const env = { port: 0, dataDir, appDataDir, sessionSecret: "file-safety-test-session-secret", nodeEnv: "test" };
  const db = openDb(env);
  const events = { publish() {} };
  const audit = new AuditService(db);
  const roots = new RootService(db, dataDir, new SecretBox(appDataDir));
  roots.syncFromDataDir();
  const remote = new RemoteStorage(new RcloneClient(rcloneSocketPath(appDataDir)), roots, env);
  const storage = new StorageService(remote);
  const paths = new PathService(roots, remote);
  const permissions = new PermissionService(db, audit);
  const preferences = new PreferenceService(db, roots, paths, events);
  const fsService = new FsService(paths, permissions, audit, storage, appDataDir, preferences);
  const tasks = new TaskService(db, paths, permissions, audit, events, appDataDir, fsService, storage, preferences);
  const user = await new AuthService(db, env).createUser({ email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin", role: "ADMIN" }, true);
  const actor = { id: user.id, email: user.email, displayName: "Admin", role: "ADMIN", disabled: false };
  const restore = patchable();
  t.after(async () => {
    restore();
    db.close();
    await chmodAll(baseDir);
    await rm(baseDir, { recursive: true, force: true });
  });
  const run = async (type, sources, destination, conflicts) => {
    const created = await tasks.create(actor, { type, sources, ...(destination ? { destination } : {}), ...(conflicts ? { options: { conflicts } } : {}) });
    const claimed = tasks.claimNext("files");
    assert.equal(claimed.id, created.id);
    await tasks.runTask(claimed, actor);
    return tasks.get(created.id);
  };
  const trashed = () => db.prepare("SELECT * FROM trash_items WHERE restored_at IS NULL").all();
  return { dataDir, appDataDir, db, tasks, actor, roots, paths, run, trashed, family: path.join(dataDir, "family"), other: path.join(dataDir, "other") };
}

/** Puts back every fs function a test swapped out. */
function patchable() {
  const originals = { ...fsp };
  return () => Object.assign(fsp, originals);
}

const fail = (code) => Object.assign(new Error(`simulated ${code}`), { code });
const read = (file) => readFile(file, "utf8");
const exists = (file) => stat(file).then(() => true, () => false);

/** Folders a test made read-only are opened up again, or they could not be removed. */
async function chmodAll(dir) {
  await chmod(dir, 0o755).catch(() => undefined);
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) if (entry.isDirectory()) await chmodAll(path.join(dir, entry.name));
}

/** Makes every rename from under `from` into `to` find another disk, as a move between two mounts does. */
function acrossDisks(from, to) {
  const rename = fsp.rename;
  fsp.rename = async (source, target) => {
    if (String(source).startsWith(from) && String(target).startsWith(to)) throw fail("EXDEV");
    return rename(source, target);
  };
}

test("a replacement leaves nothing hidden behind, and puts back what it replaces when it can't take its place", async (t) => {
  const { run, family, other } = await harness(t);
  await writeFile(path.join(family, "report.txt"), "new report");
  await writeFile(path.join(other, "report.txt"), "old report");
  await mkdir(path.join(family, "album"));
  await writeFile(path.join(family, "album", "a.txt"), "new album");
  await mkdir(path.join(other, "album"));
  await writeFile(path.join(other, "album", "b.txt"), "old album");

  // The one renamed into place fails: what was there is back, and the source is untouched.
  const rename = fsp.rename;
  fsp.rename = async (source, target) => {
    if (path.basename(String(target)) === "report.txt" && path.dirname(String(target)) === other && path.basename(path.dirname(String(source))) !== "old") throw fail("EIO");
    return rename(source, target);
  };
  assert.equal((await run("copy", [{ rootSlug: "family", path: "/report.txt" }], { rootSlug: "other", path: "/" }, { "report.txt": "replace" })).status, "failed");
  assert.equal((await run("move", [{ rootSlug: "family", path: "/report.txt" }], { rootSlug: "other", path: "/" }, { "report.txt": "replace" })).status, "failed");
  fsp.rename = rename;
  assert.equal(await read(path.join(other, "report.txt")), "old report");
  assert.equal(await read(path.join(family, "report.txt")), "new report");
  assert.deepEqual((await readdir(other)).sort(), ["album", "report.txt"]);

  assert.equal((await run("copy", [{ rootSlug: "family", path: "/report.txt" }], { rootSlug: "other", path: "/" }, { "report.txt": "replace" })).status, "done");
  assert.equal((await run("move", [{ rootSlug: "family", path: "/album" }], { rootSlug: "other", path: "/" }, { album: "replace" })).status, "done");
  assert.equal(await read(path.join(other, "report.txt")), "new report");
  assert.deepEqual(await readdir(path.join(other, "album")), ["a.txt"]);
  assert.deepEqual((await readdir(other)).sort(), ["album", "report.txt"]);
  assert.equal(await exists(path.join(family, "album")), false);
});

test("what a replacement cut short by a restart left is put back, and what an older Kago hid is shown", async (t) => {
  const { run, family, other } = await harness(t);
  await writeFile(path.join(family, "incoming.txt"), "incoming");
  // Set aside, with nothing in its place yet: it goes back.
  await mkdir(path.join(other, ".kago-replace-1000-temp_aa", "old"), { recursive: true });
  await writeFile(path.join(other, ".kago-replace-1000-temp_aa", "old", "photo.txt"), "old photo");
  // Set aside after its replacement arrived: it goes.
  await mkdir(path.join(other, ".kago-replace-1000-temp_bb", "old"), { recursive: true });
  await writeFile(path.join(other, ".kago-replace-1000-temp_bb", "old", "landed.txt"), "replaced");
  await writeFile(path.join(other, "landed.txt"), "replacement");
  // What an older Kago had renamed aside before it deleted the one in the way.
  await writeFile(path.join(other, ".kago-replace-temp_0123456789abcdef01234567"), "moved source");

  assert.equal((await run("copy", [{ rootSlug: "family", path: "/incoming.txt" }], { rootSlug: "other", path: "/" })).status, "done");
  assert.deepEqual((await readdir(other)).sort(), ["Recovered", "incoming.txt", "landed.txt", "photo.txt"]);
  assert.equal(await read(path.join(other, "photo.txt")), "old photo");
  assert.equal(await read(path.join(other, "landed.txt")), "replacement");
  assert.equal(await read(path.join(other, "Recovered")), "moved source");
});

test("a move to another disk leaves in the source what arrived or changed while it was copied", async (t) => {
  const { run, family, other } = await harness(t);
  const album = path.join(family, "album");
  await mkdir(path.join(album, "inner"), { recursive: true });
  await writeFile(path.join(album, "a.txt"), "a");
  await writeFile(path.join(album, "inner", "b.txt"), "b");
  acrossDisks(family, other);
  const copyFile = fsp.copyFile;
  fsp.copyFile = async (source, target, mode) => {
    await copyFile(source, target, mode);
    if (path.basename(String(source)) === "a.txt") {
      await writeFile(path.join(album, "late.txt"), "arrived meanwhile");
      await writeFile(path.join(album, "a.txt"), "changed meanwhile");
    }
  };
  assert.equal((await run("move", [{ rootSlug: "family", path: "/album" }], { rootSlug: "other", path: "/" })).status, "done");
  assert.equal(await read(path.join(other, "album", "a.txt")), "a");
  assert.equal(await read(path.join(other, "album", "inner", "b.txt")), "b");
  assert.deepEqual((await readdir(album)).sort(), ["a.txt", "late.txt"]);
  assert.equal(await read(path.join(album, "a.txt")), "changed meanwhile");
});

test("a copy that fails takes its partial target with it, but never a folder it was merging into", async (t) => {
  const { run, family, other } = await harness(t);
  const docs = path.join(family, "docs");
  await mkdir(path.join(docs, "deep"), { recursive: true });
  await writeFile(path.join(docs, "a.txt"), "a");
  await writeFile(path.join(docs, "deep", "bad.txt"), "bad");
  const copyFile = fsp.copyFile;
  fsp.copyFile = async (source, target, mode) => {
    if (path.basename(String(source)) === "bad.txt") throw fail("EIO");
    return copyFile(source, target, mode);
  };
  assert.equal((await run("copy", [{ rootSlug: "family", path: "/docs" }], { rootSlug: "other", path: "/" })).status, "failed");
  assert.deepEqual(await readdir(other), []);

  await mkdir(path.join(other, "docs"));
  await writeFile(path.join(other, "docs", "kept.txt"), "kept");
  assert.equal((await run("copy", [{ rootSlug: "family", path: "/docs" }], { rootSlug: "other", path: "/" }, { docs: "merge_keep" })).status, "failed");
  assert.equal(await read(path.join(other, "docs", "kept.txt")), "kept");
  assert.equal(await exists(path.join(other, "docs", "deep")), false);
});

test("a read-only folder is copied, and keeps its mode", { skip: process.getuid?.() === 0 && "root may write anywhere" }, async (t) => {
  const { run, family, other } = await harness(t);
  const locked = path.join(family, "locked");
  await mkdir(locked);
  await writeFile(path.join(locked, "a.txt"), "a");
  await chmod(locked, 0o555);
  assert.equal((await run("copy", [{ rootSlug: "family", path: "/locked" }], { rootSlug: "other", path: "/" })).status, "done");
  assert.equal(await read(path.join(other, "locked", "a.txt")), "a");
  assert.equal((await stat(path.join(other, "locked"))).mode & 0o777, 0o555);
});

test("throwing away to another disk is recorded when it lands, and leaves nothing untracked when it doesn't", async (t) => {
  const { run, trashed, family } = await harness(t);
  const trash = path.join(family, ".kago-trash");
  await mkdir(path.join(family, "album"));
  await writeFile(path.join(family, "album", "a.txt"), "a");
  acrossDisks(path.join(family, "album"), trash);

  const copyFile = fsp.copyFile;
  fsp.copyFile = async () => {
    throw fail("ENOSPC");
  };
  assert.equal((await run("delete_to_trash", [{ rootSlug: "family", path: "/album" }])).status, "failed");
  fsp.copyFile = copyFile;
  assert.deepEqual(trashed(), []);
  assert.deepEqual(await readdir(trash), []);
  assert.equal(await read(path.join(family, "album", "a.txt")), "a");

  // Copied whole, but the source could not all be removed: it is in the trash, and can be restored from there.
  const unlink = fsp.unlink;
  fsp.unlink = async () => {
    throw fail("EACCES");
  };
  assert.equal((await run("delete_to_trash", [{ rootSlug: "family", path: "/album" }])).status, "failed");
  fsp.unlink = unlink;
  const [item] = trashed();
  assert.ok(item, "the trash item is recorded");
  assert.equal(await read(path.join(item.trash_path, "a.txt")), "a");
});

test("a restore makes its folder again, and goes beside what has taken its name", async (t) => {
  const { run, trashed, family } = await harness(t);
  await mkdir(path.join(family, "album", "2024"), { recursive: true });
  await writeFile(path.join(family, "album", "2024", "photo.txt"), "photo");
  await writeFile(path.join(family, "Note.txt"), "old note");
  assert.equal((await run("delete_to_trash", [{ rootSlug: "family", path: "/album/2024/photo.txt" }, { rootSlug: "family", path: "/Note.txt" }])).status, "done");
  await rm(path.join(family, "album"), { recursive: true });
  // Only the case differs, which a volume that does not mind it cannot tell apart.
  await writeFile(path.join(family, "note.txt"), "new note");

  const items = trashed();
  assert.equal((await run("restore_trash", items.map((item) => ({ rootSlug: "trash", path: item.id })))).status, "done");
  assert.equal(await read(path.join(family, "album", "2024", "photo.txt")), "photo");
  assert.equal(await read(path.join(family, "note.txt")), "new note");
  assert.equal(await read(path.join(family, "Note 2.txt")), "old note");
  assert.deepEqual(trashed(), []);
});

test("a move never takes the place of what a volume that does not mind the case finds under its name", async (t) => {
  const { run, family, other } = await harness(t);
  await writeFile(path.join(family, "Photo.txt"), "arriving");
  await writeFile(path.join(other, "photo.txt"), "already there");
  if (!(await exists(path.join(other, "PHOTO.txt")))) return t.skip("the temp volume minds the case");
  assert.equal((await run("move", [{ rootSlug: "family", path: "/Photo.txt" }], { rootSlug: "other", path: "/" })).status, "failed");
  assert.equal(await read(path.join(other, "photo.txt")), "already there");
  assert.equal(await read(path.join(family, "Photo.txt")), "arriving");
});

test("a folder can't go into itself through a location that is another's folder mounted again", async (t) => {
  const { run, paths, dataDir } = await harness(t, ["data", "photos"]);
  const inner = path.join(dataDir, "data", "photos");
  await mkdir(path.join(inner, "Albums"), { recursive: true });
  await mkdir(path.join(dataDir, "photos", "Albums"));
  // The second mount is told apart from the folder it shows only by its path: on disk it is the same folder.
  const mount = path.join(dataDir, "photos");
  const real = await fsp.realpath(mount);
  const same = await stat(inner);
  const statOf = fsp.stat;
  fsp.stat = async (target, options) => (path.resolve(String(target)) === mount || path.resolve(String(target)) === real ? same : statOf(target, options));

  // Refused before it is queued, and again before it runs.
  await assert.rejects(run("copy", [{ rootSlug: "data", path: "/photos" }], { rootSlug: "photos", path: "/Albums" }), { code: "TARGET_INSIDE_SOURCE" });
  assert.deepEqual(await readdir(path.join(dataDir, "photos", "Albums")), []);
  assert.equal(await foldersOverlap(await paths.resolveExisting("data", "/photos"), await paths.resolveExisting("photos", "/Albums")), true);
  assert.equal(await foldersOverlap(await paths.resolveExisting("data", "/photos/Albums"), await paths.resolveExisting("photos", "/")), true);
});
