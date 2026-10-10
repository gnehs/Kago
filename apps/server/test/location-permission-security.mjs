import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { buildApp } from "../dist/app.js";

test("a rule covers a whole location, and a location without one cannot be reached", async () => {
  const fixture = await createFixture("kago-location-acl.");
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Test Admin" })).statusCode, 200);
    const roots = Object.fromEntries((await admin.get("/api/roots")).json.map((root) => [root.slug, root]));
    const user = await admin.post("/api/users", { email: "member@example.test", password: "fake-user-password-123", displayName: "Member", role: "USER" });
    assert.equal(user.statusCode, 200);
    const grant = (principalType, principalId, slug, level) => admin.put("/api/permissions", { principalType, principalId, rootId: roots[slug].id, level });
    assert.equal((await grant("user", user.json.id, "family", "edit")).statusCode, 200);
    assert.equal((await grant("user", user.json.id, "movies", "view")).statusCode, 200);

    const member = client(app);
    assert.equal((await member.post("/api/auth/login", { email: "member@example.test", password: "fake-user-password-123" })).statusCode, 200);
    const list = (slug, logicalPath) => member.get(`/api/fs/list?rootSlug=${slug}&path=${encodeURIComponent(logicalPath)}`);
    const preview = (slug, logicalPath) => member.get(`/api/fs/preview?rootSlug=${slug}&path=${encodeURIComponent(logicalPath)}`, { accept: "*/*" });
    const task = async (type, source, destination) => {
      const created = await member.post("/api/tasks", { type, sources: [source], destination });
      return created.statusCode === 200 ? (await waitTask(member, created.json.id)).status : created.statusCode;
    };

    // Only the locations with a rule are there at all.
    assert.deepEqual((await member.get("/api/roots")).json.map((root) => root.slug).sort(), ["family", "movies"]);
    assert.equal((await list("private", "/")).statusCode, 403);
    assert.equal((await preview("private", "/diary.txt")).statusCode, 403);

    // Nothing inside a location is set apart from the rest of it.
    assert.deepEqual((await list("family", "/")).json.items.map((item) => item.name).sort(), ["inbox", "kids", "note.txt"]);
    assert.equal((await preview("family", "/kids/deep/drawing.txt")).statusCode, 200);
    assert.equal((await preview("movies", "/film.txt")).statusCode, 200);

    // Viewing is not changing.
    assert.equal((await member.post("/api/fs/mkdir", { rootSlug: "movies", path: "/", name: "new" })).statusCode, 403);
    assert.equal((await member.post("/api/fs/rename", { rootSlug: "movies", path: "/film.txt", name: "mine.txt" })).statusCode, 403);
    assert.notEqual(await task("move", { rootSlug: "movies", path: "/film.txt" }, { rootSlug: "family", path: "/inbox" }), "done");
    assert.equal(await readFile(path.join(fixture.dataDir, "movies", "film.txt"), "utf8"), "film canary");
    assert.notEqual(await task("copy", { rootSlug: "family", path: "/note.txt" }, { rootSlug: "movies", path: "/" }), "done");
    assert.notEqual(await task("copy", { rootSlug: "private", path: "/diary.txt" }, { rootSlug: "family", path: "/inbox" }), "done");
    await assert.rejects(readFile(path.join(fixture.dataDir, "family", "inbox", "diary.txt")));

    // What may be seen may be copied out whole, to where the actor may write.
    assert.equal(await task("copy", { rootSlug: "movies", path: "/film.txt" }, { rootSlug: "family", path: "/inbox" }), "done");
    assert.equal(await readFile(path.join(fixture.dataDir, "family", "inbox", "film.txt"), "utf8"), "film canary");
    assert.equal(await task("copy", { rootSlug: "family", path: "/kids" }, { rootSlug: "family", path: "/inbox" }), "done");
    assert.equal(await readFile(path.join(fixture.dataDir, "family", "inbox", "kids", "deep", "drawing.txt"), "utf8"), "drawing canary");

    // Moving and renaming leave the rules as they are: they were never about the path.
    const rulesBefore = (await admin.get("/api/permissions")).json;
    assert.equal(await task("move", { rootSlug: "family", path: "/note.txt" }, { rootSlug: "family", path: "/kids" }), "done");
    assert.equal((await member.post("/api/fs/rename", { rootSlug: "family", path: "/kids", name: "children" })).statusCode, 200);
    assert.equal((await preview("family", "/children/note.txt")).statusCode, 200);
    assert.deepEqual((await admin.get("/api/permissions")).json, rulesBefore);

    // A group's rule and the user's own add up, and the higher of the two holds.
    const group = await admin.post("/api/groups", { name: "editors" });
    assert.equal((await admin.post(`/api/groups/${group.json.id}/members`, { userId: user.json.id })).statusCode, 200);
    assert.equal((await grant("group", group.json.id, "movies", "edit")).statusCode, 200);
    assert.equal((await member.post("/api/fs/mkdir", { rootSlug: "movies", path: "/", name: "new" })).statusCode, 200);
    assert.equal((await grant("group", group.json.id, "movies", null)).statusCode, 200);
    assert.equal((await member.post("/api/fs/mkdir", { rootSlug: "movies", path: "/", name: "newer" })).statusCode, 403);
    assert.equal((await list("movies", "/")).statusCode, 200);

    // One rule for each principal in each location, and none once it is taken away.
    assert.equal((await grant("user", user.json.id, "movies", "edit")).json.rule.level, "edit");
    assert.equal((await admin.get(`/api/permissions?rootId=${roots.movies.id}`)).json.length, 1);
    assert.equal((await grant("user", user.json.id, "movies", null)).json.rule, null);
    assert.equal((await list("movies", "/")).statusCode, 403);
    assert.deepEqual((await member.get("/api/roots")).json.map((root) => root.slug), ["family"]);

    // A rule cannot be asked to cover less than its location, and only an administrator writes them.
    assert.equal((await member.put("/api/permissions", { principalType: "user", principalId: user.json.id, rootId: roots.private.id, level: "edit" })).statusCode, 403);
    assert.equal((await grant("user", "user_missing", "family", "view")).statusCode, 400);

    // A tag is its maker's own, also on a file both can reach.
    const tag = await admin.post("/api/tags", { name: "Admin only" });
    assert.equal((await admin.put("/api/tags/file", { rootSlug: "family", path: "/inbox/film.txt", tagIds: [tag.json.id] })).statusCode, 200);
    assert.deepEqual((await member.get("/api/tags/file?rootSlug=family&path=/inbox/film.txt")).json, []);
    assert.equal((await member.put("/api/tags/file", { rootSlug: "family", path: "/inbox/film.txt", tagIds: [tag.json.id] })).statusCode, 400);
    assert.equal((await member.put("/api/tags/file", { rootSlug: "family", path: "/inbox/film.txt", tagIds: [] })).statusCode, 200);
    assert.equal((await admin.get("/api/tags/file?rootSlug=family&path=/inbox/film.txt")).json.length, 1);

    // A sync is a copy by another name: it takes nothing out of a location a copy could not.
    const sync = (source, destination) => member.post("/api/sync-jobs", { name: "Sync", source, destination });
    assert.equal((await sync({ kind: "location", rootSlug: "private", path: "/" }, { kind: "location", rootSlug: "family", path: "/inbox" })).statusCode, 403);

    // A sync joins two locations and nothing else.
    assert.equal((await admin.post("/api/sync-jobs", { name: "Backup", source: { kind: "location", rootSlug: "family", path: "/inbox" }, destination: { kind: "rsync", remote: "user@example.test:/backup" } })).statusCode, 400);
    assert.equal((await admin.post("/api/tasks", { type: "rsync_push", sources: [{ rootSlug: "family", path: "/inbox" }], remote: "user@example.test:/backup" })).statusCode, 400);

    // The server's SSH key is the administrator's to use, and stays the same key once made.
    assert.equal((await member.get("/api/storage/ssh-key")).statusCode, 403);
    const key = (await admin.get("/api/storage/ssh-key")).json.publicKey;
    assert.match(key, /^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/]{43} kago$/);
    assert.equal((await admin.get("/api/storage/ssh-key")).json.publicKey, key);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("rules once written for a folder are dropped, not widened to its location", async () => {
  const fixture = await createFixture("kago-location-acl-migration.");
  const dbPath = path.join(fixture.appDataDir, "app.db");
  // A first start lays the tables out; the rules are then put back the way an older Kago kept them.
  await (await buildApp(testEnv(fixture))).close();
  const old = new DatabaseSync(dbPath);
  const family = old.prepare("SELECT id FROM roots WHERE slug = 'family'").get().id;
  const movies = old.prepare("SELECT id FROM roots WHERE slug = 'movies'").get().id;
  old.exec(`
    DROP TABLE permission_rules;
    CREATE TABLE permission_rules (
      id TEXT PRIMARY KEY,
      principal_type TEXT NOT NULL,
      principal_id TEXT NOT NULL,
      root_id TEXT NOT NULL,
      path_prefix TEXT NOT NULL,
      level TEXT NOT NULL,
      recursive INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (root_id) REFERENCES roots(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_permission_rules_lookup ON permission_rules(principal_type, principal_id, root_id, path_prefix);
  `);
  const insert = old.prepare("INSERT INTO permission_rules VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)");
  insert.run("whole-view", "user", "user-a", family, "/", "view", 1);
  insert.run("whole-edit", "user", "user-a", family, "/", "edit", 1);
  insert.run("subfolder", "user", "user-b", family, "/kids", "edit", 1);
  insert.run("top-only", "group", "group-a", family, "/", "view", 0);
  insert.run("other-location", "group", "group-a", movies, "/", "view", 1);
  old.close();

  const app = await buildApp(testEnv(fixture));
  try {
    await app.ready();
    const db = new DatabaseSync(dbPath);
    const columns = db.prepare("PRAGMA table_info(permission_rules)").all().map((column) => column.name);
    assert.deepEqual(columns, ["id", "principal_type", "principal_id", "root_id", "level", "created_at", "updated_at"]);
    const kept = db.prepare("SELECT id, level FROM permission_rules ORDER BY id").all().map((rule) => ({ ...rule }));
    assert.deepEqual(kept, [{ id: "other-location", level: "view" }, { id: "whole-edit", level: "edit" }]);
    const dropped = db.prepare("SELECT path, target_json FROM audit_logs WHERE action = 'permission_change' AND actor_type = 'system' ORDER BY path, target_json").all();
    assert.deepEqual(dropped.map((entry) => [entry.path, JSON.parse(entry.target_json).principalId]), [["/", "group-a"], ["/kids", "user-b"]]);
    // The index named a column that is gone; nothing of it may be left to trip the next start.
    assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'idx_permission_rules_lookup'").get().n, 0);
    db.close();
  } finally {
    await app.close();
  }
  // A second start finds nothing left to do.
  await (await buildApp(testEnv(fixture))).close();
  await rm(fixture.baseDir, { recursive: true, force: true });
});

test("an account that was a guest becomes a standard user, and no new one can be made", async () => {
  const fixture = await createFixture("kago-guest-role.");
  const dbPath = path.join(fixture.appDataDir, "app.db");
  const first = await buildApp(testEnv(fixture));
  assert.equal((await client(first).post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Test Admin" })).statusCode, 200);
  await first.close();
  const old = new DatabaseSync(dbPath);
  old.prepare("INSERT INTO users (id, email, password_hash, display_name, role, disabled, created_at, updated_at) VALUES ('user-guest', 'guest@example.test', 'x', 'Guest', 'GUEST', 0, 1, 1)").run();
  old.close();

  const app = await buildApp(testEnv(fixture));
  const admin = client(app);
  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/login", { email: "admin@example.test", password: "fake-admin-password-123" })).statusCode, 200);
    assert.equal((await admin.get("/api/users")).json.find((user) => user.id === "user-guest").role, "USER");
    assert.equal((await admin.post("/api/users", { email: "new@example.test", password: "fake-user-password-123", displayName: "New", role: "GUEST" })).statusCode, 400);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

function testEnv(fixture) {
  return { port: 0, dataDir: fixture.dataDir, appDataDir: fixture.appDataDir, sessionSecret: "location-acl-test-session-secret", nodeEnv: "test" };
}

async function createFixture(prefix) {
  const baseDir = await mkdtemp(path.join(tmpdir(), prefix));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  await mkdir(path.join(dataDir, "family", "kids", "deep"), { recursive: true });
  await mkdir(path.join(dataDir, "family", "inbox"), { recursive: true });
  await mkdir(path.join(dataDir, "movies"), { recursive: true });
  await mkdir(path.join(dataDir, "private"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(dataDir, "family", "note.txt"), "note canary");
  await writeFile(path.join(dataDir, "family", "kids", "deep", "drawing.txt"), "drawing canary");
  await writeFile(path.join(dataDir, "movies", "film.txt"), "film canary");
  await writeFile(path.join(dataDir, "private", "diary.txt"), "diary canary");
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
