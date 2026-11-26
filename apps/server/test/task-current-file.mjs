import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
import { taskKinds } from "../src/services/task-kinds.ts";
import { TaskService } from "../src/services/task.service.ts";
import { RcloneClient, rcloneSocketPath } from "../src/storage/rclone-client.ts";
import { RemoteStorage } from "../src/storage/remote-storage.ts";

const names = Array.from({ length: 12 }, (_, index) => `sub/f${index}.txt`);

/** Tasks run in this thread, as a worker runs them. Files are held back for a while so that progress is written while they are worked on. */
async function harness(t) {
  const baseDir = await fsp.realpath(await mkdtemp(path.join(tmpdir(), "kago-current-file.")));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  for (const location of ["family", "backup"]) await mkdir(path.join(dataDir, location), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  for (const name of names) {
    await mkdir(path.dirname(path.join(dataDir, "family", "album", name)), { recursive: true });
    await writeFile(path.join(dataDir, "family", "album", name), "x");
  }
  const env = { port: 0, dataDir, appDataDir, sessionSecret: "current-file-test-session-secret", nodeEnv: "test" };
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

  const originals = { ...fsp };
  const reads = [];
  let started = 0;
  // The first files wait out the flush interval, so that the next one to begin is the one that finds progress due.
  const held = (work) => (...args) => {
    started += 1;
    return (started <= 8 ? new Promise((resolve) => setTimeout(resolve, 700)) : Promise.resolve()).then(() => work(...args));
  };
  t.after(async () => {
    Object.assign(fsp, originals);
    db.close();
    await rm(baseDir, { recursive: true, force: true });
  });
  const run = async (type, sources, destination) => {
    const created = await tasks.create(actor, { type, sources, destination });
    const claimed = tasks.claimNext(taskKinds[type].lane);
    assert.equal(claimed.id, created.id);
    await tasks.runTask(claimed, actor);
    return tasks.get(created.id);
  };
  const shown = () => events.filter((event) => event.type === "task.progress" && event.patch.current_path).map((event) => event.patch.current_path);
  return {
    dataDir,
    reads,
    run,
    shown,
    slowCopy: () => {
      fsp.copyFile = held(originals.copyFile);
    },
    slowUnlink: () => {
      fsp.unlink = held(originals.unlink);
    },
    watchReads: (under) => {
      fsp.readdir = (dir, ...rest) => {
        if (String(dir).startsWith(under)) reads.push(String(dir));
        return originals.readdir(dir, ...rest);
      };
    }
  };
}

const inside = (shown) => shown.filter((current) => /^\/album\/sub\/f\d+\.txt$/.test(current));

test("a folder copied between locations names the file it is on, as a path in its location", async (t) => {
  const h = await harness(t);
  h.slowCopy();
  const task = await h.run("copy", [{ rootSlug: "family", path: "/album" }], { rootSlug: "backup", path: "/" });
  assert.equal(task.status, "done");
  const shown = h.shown();
  assert.ok(inside(shown).length > 0, `a file inside the folder was shown: ${shown.join(" ")}`);
  assert.ok(shown.every((current) => current === "/album" || /^\/album\/sub\/f\d+\.txt$/.test(current)), `nothing but the folder and its files was shown: ${shown.join(" ")}`);
  assert.ok(shown.every((current) => !current.includes(h.dataDir)), "no host path was shown");
});

test("a folder deleted for good names the file it is on", async (t) => {
  const h = await harness(t);
  h.slowUnlink();
  const task = await h.run("delete", [{ rootSlug: "family", path: "/album" }]);
  assert.equal(task.status, "done");
  const shown = h.shown();
  assert.ok(inside(shown).length > 0, `a file inside the folder was shown: ${shown.join(" ")}`);
  assert.ok(shown.every((current) => current === "/album" || current.startsWith("/album/")), `only paths in the folder were shown: ${shown.join(" ")}`);
});

test("a folder moved within one disk is renamed, shown as the folder, and never read", async (t) => {
  const h = await harness(t);
  h.watchReads(path.join(h.dataDir, "family", "album"));
  const task = await h.run("move", [{ rootSlug: "family", path: "/album" }], { rootSlug: "backup", path: "/" });
  assert.equal(task.status, "done");
  assert.deepEqual(h.reads, [], "the folder was not read");
  assert.deepEqual(h.shown().filter((current) => current !== "/album"), [], "only the folder was shown");
});
