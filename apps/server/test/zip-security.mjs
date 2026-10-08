import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { crc32 } from "node:zlib";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import AdmZip from "adm-zip";
import { buildApp } from "../dist/app.js";

test("extract rejects a small stored archive with a forged huge size without writing it", async () => {
  const fixture = await createFixture("kago-zip-bomb.");
  const archivePath = path.join(fixture.dataDir, "photos", "public", "forged.zip");
  await writeFile(archivePath, forgedStoredZip());
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

test("background ZIPs omit descendants no rule grants and stop serving an artifact after a child permission is revoked", async () => {
  const fixture = await createFixture("kago-zip-acl.");
  const publicDir = path.join(fixture.dataDir, "photos", "public");
  await mkdir(path.join(publicDir, "private"), { recursive: true });
  await writeFile(path.join(publicDir, "visible.txt"), "visible canary");
  await writeFile(path.join(publicDir, "private", "hidden.txt"), "hidden canary");
  await symlink(path.join(publicDir, "visible.txt"), path.join(publicDir, "visible-link.txt"));
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Test Admin" })).statusCode, 200);
    const root = (await admin.get("/api/roots")).json.find((item) => item.slug === "photos");
    const user = await admin.post("/api/users", { email: "zip-user@example.test", password: "fake-user-password-123", displayName: "Zip User", role: "USER" });
    assert.equal(user.statusCode, 200);
    const rule = (pathPrefix, recursive) => admin.post("/api/permissions", { principalType: "user", principalId: user.json.id, rootId: root.id, pathPrefix, level: "view", recursive });
    assert.equal((await rule("/public", false)).statusCode, 200);
    const visibleRule = await rule("/public/visible.txt", true);
    assert.equal(visibleRule.statusCode, 200);
    assert.equal((await rule("/public/visible-link.txt", true)).statusCode, 200);

    const member = client(app);
    assert.equal((await member.post("/api/auth/login", { email: "zip-user@example.test", password: "fake-user-password-123" })).statusCode, 200);
    const created = await member.post("/api/tasks", { type: "download_zip", sources: [{ rootSlug: "photos", path: "/public" }] });
    assert.equal(created.statusCode, 200);
    assert.equal((await waitTask(member, created.json.id)).status, "done");
    const archive = await member.get(`/api/tasks/${created.json.id}/download`, { accept: "*/*" });
    assert.equal(archive.statusCode, 200);
    const names = new AdmZip(archive.raw).getEntries().map((entry) => entry.entryName);
    assert.ok(names.includes("public/visible.txt"));
    assert.equal(names.includes("public/visible-link.txt"), false);
    assert.equal(names.some((name) => name.includes("private") || name.includes("hidden.txt")), false);

    assert.equal((await admin.delete(`/api/permissions/${visibleRule.json.id}`)).statusCode, 200);
    assert.equal((await member.get(`/api/tasks/${created.json.id}/download`, { accept: "*/*" })).statusCode, 403);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

function forgedStoredZip() {
  const name = Buffer.from("payload.bin");
  const data = Buffer.from("x");
  const declaredSize = 1_774_000_000;
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

function client(app) {
  let cookie = "";
  async function request(method, url, body, accept = "application/json") {
    const headers = { accept, ...(cookie ? { cookie } : {}) };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    if (method !== "GET") headers["x-kago-csrf"] = "1";
    const response = await app.inject({ method, url, headers, payload });
    const values = response.headers["set-cookie"];
    for (const value of Array.isArray(values) ? values : values ? [values] : []) {
      const pair = value.split(";", 1)[0];
      if (!pair) continue;
      const [name] = pair.split("=");
      cookie = cookie.split("; ").filter((item) => !item.startsWith(`${name}=`)).concat(pair).join("; ");
    }
    const json = String(response.headers["content-type"] ?? "").includes("application/json") && response.payload ? JSON.parse(response.payload) : null;
    return { statusCode: response.statusCode, payload: response.payload, raw: response.rawPayload, json };
  }
  return {
    get: (url, options = {}) => request("GET", url, undefined, options.accept),
    post: (url, body) => request("POST", url, body),
    delete: (url) => request("DELETE", url)
  };
}

async function waitTask(api, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await api.get(`/api/tasks/${taskId}`);
    if (["done", "failed", "cancelled", "interrupted"].includes(task.json.status)) return task.json;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Task ${taskId} did not finish`);
}
