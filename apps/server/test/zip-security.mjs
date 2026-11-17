import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import AdmZip from "adm-zip";
import { buildApp } from "../dist/app.js";
import { client, waitTask } from "./helpers.mjs";

test("extract rejects a small stored archive with a forged huge size without writing it", async () => {
  const fixture = await createFixture("kago-zip-bomb.");
  const archivePath = path.join(fixture.dataDir, "photos", "public", "forged.zip");
  await writeFile(archivePath, storedZip("payload.bin", "x", 1_774_000_000));
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Test Admin" })).statusCode, 200);

    const created = await admin.post("/api/tasks", {
      type: "extract",
      sources: [{ rootSlug: "photos", path: "/public/forged.zip" }],
      destination: { rootSlug: "photos", path: "/public" }
    });
    assert.equal(created.statusCode, 200);
    const task = await waitTask(admin, created.json.id);
    assert.equal(task.status, "failed");
    assert.equal((await readdir(path.join(fixture.dataDir, "photos", "public"))).includes("payload.bin"), false);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("background ZIPs leave symlinks out and stop serving an artifact once its location is taken away", async () => {
  const fixture = await createFixture("kago-zip-acl.");
  const publicDir = path.join(fixture.dataDir, "photos", "public");
  await mkdir(path.join(publicDir, "inner"), { recursive: true });
  await writeFile(path.join(publicDir, "visible.txt"), "visible canary");
  await writeFile(path.join(publicDir, "inner", "deep.txt"), "deep canary");
  await symlink(path.join(publicDir, "visible.txt"), path.join(publicDir, "visible-link.txt"));
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Test Admin" })).statusCode, 200);
    const root = (await admin.get("/api/roots")).json.find((item) => item.slug === "photos");
    const user = await admin.post("/api/users", { email: "zip-user@example.test", password: "fake-user-password-123", displayName: "Zip User", role: "USER" });
    assert.equal(user.statusCode, 200);
    const grant = (level) => admin.put("/api/permissions", { principalType: "user", principalId: user.json.id, rootId: root.id, level });

    const member = client(app);
    assert.equal((await member.post("/api/auth/login", { email: "zip-user@example.test", password: "fake-user-password-123" })).statusCode, 200);
    const zip = () => member.post("/api/tasks", { type: "download_zip", sources: [{ rootSlug: "photos", path: "/public" }] });
    const refused = await zip();
    assert.ok(refused.statusCode === 403 || (await waitTask(member, refused.json.id)).status === "failed");

    assert.equal((await grant("view")).statusCode, 200);
    const created = await zip();
    assert.equal(created.statusCode, 200);
    assert.equal((await waitTask(member, created.json.id)).status, "done");
    const archive = await member.get(`/api/tasks/${created.json.id}/download`, { accept: "*/*" });
    assert.equal(archive.statusCode, 200);
    const names = new AdmZip(archive.raw).getEntries().map((entry) => entry.entryName);
    assert.ok(names.includes("public/visible.txt"));
    assert.ok(names.includes("public/inner/deep.txt"));
    assert.equal(names.includes("public/visible-link.txt"), false);

    assert.equal((await grant(null)).statusCode, 200);
    assert.equal((await member.get(`/api/tasks/${created.json.id}/download`, { accept: "*/*" })).statusCode, 403);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("an archive lists its entries without being extracted, and a file that is not one says so", async () => {
  const fixture = await createFixture("kago-zip-list.");
  const publicDir = path.join(fixture.dataDir, "photos", "public");
  const archive = new AdmZip();
  archive.addFile("docs/", Buffer.alloc(0));
  archive.addFile("docs/readme.txt", Buffer.from("hello archive"));
  archive.addFile("deep/nested/note.md", Buffer.from("# note"));
  archive.addFile("top.bin", Buffer.alloc(2048, 7));
  await writeFile(path.join(publicDir, "bundle.zip"), archive.toBuffer());
  await writeFile(path.join(publicDir, "fake.zip"), "not a zip at all");
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Test Admin" })).statusCode, 200);
    const listed = await admin.get("/api/fs/archive?rootSlug=photos&path=/public/bundle.zip");
    assert.equal(listed.statusCode, 200);
    assert.equal(listed.json.truncated, false);
    const byPath = new Map(listed.json.entries.map((entry) => [entry.path, entry]));
    assert.deepEqual([...byPath.keys()].sort(), ["deep/nested/note.md", "docs", "docs/readme.txt", "top.bin"]);
    assert.equal(byPath.get("docs").folder, true);
    assert.equal(byPath.get("docs/readme.txt").size, "hello archive".length);
    assert.equal(byPath.get("top.bin").size, 2048);
    assert.ok(byPath.get("top.bin").packed < 2048);
    assert.equal(byPath.get("top.bin").locked, false);
    assert.equal(typeof byPath.get("top.bin").mtime, "number");
    assert.deepEqual((await readdir(publicDir)).sort(), ["bundle.zip", "fake.zip"]);

    await writeFile(path.join(publicDir, "mac.zip"), storedZip("相片/指南.md", "# guide"));
    const mac = await admin.get("/api/fs/archive?rootSlug=photos&path=/public/mac.zip");
    assert.deepEqual(mac.json.entries.map((entry) => entry.path), ["相片/指南.md"]);
    const extracted = await admin.post("/api/tasks", { type: "extract", sources: [{ rootSlug: "photos", path: "/public/mac.zip" }], destination: { rootSlug: "photos", path: "/public" } });
    assert.equal((await waitTask(admin, extracted.json.id)).status, "done");
    assert.deepEqual(await readdir(path.join(publicDir, "相片")), ["指南.md"]);

    const fake = await admin.get("/api/fs/archive?rootSlug=photos&path=/public/fake.zip");
    assert.equal(fake.statusCode, 400);
    assert.equal(fake.json.code, "INVALID_ZIP");
    assert.equal((await client(app).get("/api/fs/archive?rootSlug=photos&path=/public/bundle.zip")).statusCode, 401);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

/** One stored entry, with no flag saying its name is UTF-8, as macOS's zip writes it. */
function storedZip(fileName, content, declaredSize = content.length) {
  const name = Buffer.from(fileName);
  const data = Buffer.from(content);
  const checksum = crc32(data);
  const local = Buffer.alloc(30 + name.length + data.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(checksum, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);
  name.copy(local, 30);
  data.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(checksum, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE((0o100644 << 16) >>> 0, 38);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  return Buffer.concat([local, central, end]);
}

function testEnv(fixture) {
  return { port: 0, dataDir: fixture.dataDir, appDataDir: fixture.appDataDir, sessionSecret: "zip-test-session-secret", nodeEnv: "test" };
}

async function createFixture(prefix) {
  const baseDir = await mkdtemp(path.join(tmpdir(), prefix));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  await mkdir(path.join(dataDir, "photos", "public"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  return { baseDir, dataDir, appDataDir };
}
