import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildApp } from "../dist/app.js";

test("a move carries its rules along and a copy refuses a folder with an unreadable file in it", async () => {
  const fixture = await createFixture("kago-move-copy-acl.");
  const publicDir = path.join(fixture.dataDir, "photos", "public");
  await mkdir(path.join(publicDir, "inbox"), { recursive: true });
  await mkdir(path.join(publicDir, "folder", "private"), { recursive: true });
  await writeFile(path.join(publicDir, "secret.txt"), "moved canary");
  await writeFile(path.join(publicDir, "folder", "visible.txt"), "visible canary");
  await writeFile(path.join(publicDir, "folder", "private", "hidden.txt"), "hidden canary");
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Test Admin" })).statusCode, 200);
    const root = (await admin.get("/api/roots")).json.find((item) => item.slug === "photos");
    const user = await admin.post("/api/users", { email: "move-user@example.test", password: "fake-user-password-123", displayName: "Move User", role: "USER" });
    assert.equal(user.statusCode, 200);
    const rule = (pathPrefix, level, recursive = true) => admin.post("/api/permissions", { principalType: "user", principalId: user.json.id, rootId: root.id, pathPrefix, level, recursive });
    assert.equal((await rule("/public/inbox", "edit")).statusCode, 200);
    assert.equal((await rule("/public/secret.txt", "edit")).statusCode, 200);
    assert.equal((await rule("/public/folder", "view", false)).statusCode, 200);
    assert.equal((await rule("/public/folder/visible.txt", "view")).statusCode, 200);

    const member = client(app);
    assert.equal((await member.post("/api/auth/login", { email: "move-user@example.test", password: "fake-user-password-123" })).statusCode, 200);
    const preview = (logicalPath) => member.get(`/api/fs/preview?rootSlug=photos&path=${encodeURIComponent(logicalPath)}`, { accept: "*/*" });
    assert.equal((await preview("/public/folder/visible.txt")).statusCode, 200);
    assert.equal((await preview("/public/folder/private/hidden.txt")).statusCode, 403);

    const moved = await member.post("/api/tasks", { type: "move", sources: [{ rootSlug: "photos", path: "/public/secret.txt" }], destination: { rootSlug: "photos", path: "/public/inbox" } });
    assert.equal(moved.statusCode, 200);
    assert.equal((await waitTask(member, moved.json.id)).status, "done");
    assert.equal(await readFile(path.join(publicDir, "inbox", "secret.txt"), "utf8"), "moved canary");
    const prefixes = (await admin.get(`/api/permissions?rootId=${root.id}`)).json.map((item) => item.path_prefix);
    assert.ok(prefixes.includes("/public/inbox/secret.txt"));
    assert.ok(!prefixes.includes("/public/secret.txt"));

    const copied = await member.post("/api/tasks", { type: "copy", sources: [{ rootSlug: "photos", path: "/public/folder" }], destination: { rootSlug: "photos", path: "/public/inbox" } });
    assert.equal(copied.statusCode, 200);
    assert.equal((await waitTask(member, copied.json.id)).status, "failed");
    await assert.rejects(readFile(path.join(publicDir, "inbox", "folder", "private", "hidden.txt")));

    // Viewing a folder is not enough to take it away.
    const movedFolder = await member.post("/api/tasks", { type: "move", sources: [{ rootSlug: "photos", path: "/public/folder" }], destination: { rootSlug: "photos", path: "/public/inbox" } });
    assert.ok(movedFolder.statusCode === 403 || (await waitTask(member, movedFolder.json.id)).status === "failed");
    assert.equal(await readFile(path.join(publicDir, "folder", "visible.txt"), "utf8"), "visible canary");

    // A tag is its maker's own, also on a file both can reach.
    const tag = await admin.post("/api/tags", { name: "Admin only" });
    assert.equal((await admin.put("/api/tags/file", { rootSlug: "photos", path: "/public/inbox/secret.txt", tagIds: [tag.json.id] })).statusCode, 200);
    assert.deepEqual((await member.get("/api/tags/file?rootSlug=photos&path=/public/inbox/secret.txt")).json, []);
    assert.equal((await member.put("/api/tags/file", { rootSlug: "photos", path: "/public/inbox/secret.txt", tagIds: [tag.json.id] })).statusCode, 400);
    assert.equal((await member.put("/api/tags/file", { rootSlug: "photos", path: "/public/inbox/secret.txt", tagIds: [] })).statusCode, 200);
    assert.equal((await admin.get("/api/tags/file?rootSlug=photos&path=/public/inbox/secret.txt")).json.length, 1);

    // A sync is a copy by another name: it takes no more out of a folder than a copy would.
    const sync = (source, destination) => member.post("/api/sync-jobs", { name: "Sync", source, destination });
    assert.equal((await sync({ kind: "location", rootSlug: "photos", path: "/public/folder" }, { kind: "location", rootSlug: "photos", path: "/public/inbox" })).statusCode, 403);

    // The server's SSH key is the administrator's to use.
    assert.equal((await sync({ kind: "location", rootSlug: "photos", path: "/public/inbox" }, { kind: "rsync", remote: "user@example.test:/backup" })).statusCode, 403);
    assert.equal((await member.post("/api/tasks", { type: "rsync_push", sources: [{ rootSlug: "photos", path: "/public/inbox" }], remote: "user@example.test:/backup" })).statusCode, 403);
    assert.equal((await member.post("/api/tasks", { type: "rsync_pull", remote: "user@example.test:/backup", destination: { rootSlug: "photos", path: "/public/inbox" } })).statusCode, 403);
    assert.equal((await member.get("/api/storage/ssh-key")).statusCode, 403);
    assert.equal((await admin.post("/api/sync-jobs", { name: "Backup", source: { kind: "location", rootSlug: "photos", path: "/public/inbox" }, destination: { kind: "rsync", remote: "user@example.test:/backup" } })).statusCode, 200);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

function testEnv(fixture) {
  return { port: 0, dataDir: fixture.dataDir, appDataDir: fixture.appDataDir, sessionSecret: "move-copy-test-session-secret", nodeEnv: "test" };
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
    put: (url, body) => request("PUT", url, body)
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
