import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import AdmZip from "adm-zip";
import { buildApp } from "../dist/app.js";
import { client, waitTask } from "./helpers.mjs";

test("a location's trash and its top can't be reached through copy, move, extract or a download", async () => {
  const baseDir = await mkdtemp(path.join(tmpdir(), "kago-trash-security."));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  const family = path.join(dataDir, "family");
  await mkdir(path.join(family, "sub", ".kago-trash"), { recursive: true });
  await mkdir(path.join(dataDir, "other"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(family, "secret.txt"), "trashed canary");
  await writeFile(path.join(family, "sub", ".kago-trash", "planted.txt"), "planted canary");
  await writeFile(path.join(family, "sub", "..\\..\\evil.bat"), "backslash canary");
  const archive = new AdmZip();
  archive.addFile(".kago-trash/hidden.txt", Buffer.from("hidden canary"));
  archive.writeZip(path.join(family, "sneak.zip"));

  const app = await buildApp({ port: 0, dataDir, appDataDir, sessionSecret: "trash-security-test-session-secret", nodeEnv: "test" });
  const admin = client(app);
  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" })).statusCode, 200);
    const task = async (type, sources, destination, options) => {
      const created = await admin.post("/api/tasks", { type, sources, destination, ...(options ? { options } : {}) });
      return created.statusCode === 200 ? (await waitTask(admin, created.json.id)).status : created.statusCode;
    };
    assert.equal(await task("delete_to_trash", [{ rootSlug: "family", path: "/secret.txt" }]), "done");
    const trash = path.join(family, ".kago-trash");
    const trashed = await readdir(trash);
    assert.equal(trashed.length, 1);

    // A folder named like the trash may not take the trash's place, nor be merged into it.
    for (const choice of ["replace", "merge_replace", "merge_keep"]) {
      assert.notEqual(await task("copy", [{ rootSlug: "family", path: "/sub/.kago-trash" }], { rootSlug: "family", path: "/", options: { conflicts: { ".kago-trash": choice } } }), "done");
    }
    assert.deepEqual(await readdir(trash), trashed);
    assert.equal(await readFile(path.join(trash, trashed[0]), "utf8"), "trashed canary");

    // An archive can't unpack into the trash.
    assert.notEqual(await task("extract", [{ rootSlug: "family", path: "/sneak.zip" }], { rootSlug: "family", path: "/" }), "done");
    assert.deepEqual(await readdir(trash), trashed);

    // A whole location, trash and all, can't be moved, copied or thrown away.
    assert.notEqual(await task("move", [{ rootSlug: "family", path: "/" }], { rootSlug: "other", path: "/" }), "done");
    assert.notEqual(await task("copy", [{ rootSlug: "family", path: "/" }], { rootSlug: "other", path: "/" }), "done");
    assert.notEqual(await task("delete_to_trash", [{ rootSlug: "family", path: "/" }]), "done");
    assert.deepEqual(await readdir(path.join(dataDir, "other")), []);

    // A download of the top leaves out the trash, and any name another system would read a separator in.
    const zip = await admin.get("/api/fs/download-zip?rootSlug=family&path=/", { accept: "*/*" });
    assert.equal(zip.statusCode, 200);
    const names = new AdmZip(zip.raw).getEntries().map((entry) => entry.entryName);
    assert.ok(names.some((name) => name.endsWith("sneak.zip")), "the download holds the location's files");
    assert.ok(!names.some((name) => name.toLowerCase().includes(".kago-trash/") && !name.includes("/sub/")), `the trash is left out: ${names}`);
    assert.ok(!names.some((name) => name.includes("\\")), `backslash names are left out: ${names}`);
  } finally {
    await app.close();
    await rm(baseDir, { recursive: true, force: true });
  }
});
