import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildApp } from "../dist/app.js";
import { openDb } from "../src/db/db.ts";
import { auditActions, auditCategories, classify, retiredActions } from "../src/lib/audit-actions.ts";
import { AuditService, auditQuerySchema, auditRunMembersSchema, placeAuditRows } from "../src/services/audit.service.ts";

const T = 1_700_000_000;

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), "kago-audit."));
  await mkdir(path.join(dir, "app-data"), { recursive: true });
  const db = openDb({ appDataDir: path.join(dir, "app-data") });
  return { dir, db, done: () => { db.close(); return rm(dir, { recursive: true, force: true }); } };
}

/** Rows as they were written before runs existed, then placed the way a startup places them, so their times are the test's own. */
function seed(db, rows) {
  const insert = db.prepare("INSERT INTO audit_logs (id, actor_type, actor_id, action, root_id, path, target_json, result, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
  rows.forEach((row, index) => {
    insert.run(row.id ?? `audit_${String(index).padStart(4, "0")}`, row.type ?? "user", row.actor ?? null, row.action, row.root ?? null, row.path ?? null, row.target ? JSON.stringify(row.target) : null, row.result ?? "success", row.at);
  });
  placeAuditRows(db);
}

function people(db) {
  const user = db.prepare("INSERT INTO users (id, email, password_hash, display_name, role, disabled, created_at, updated_at) VALUES (?, ?, 'x', ?, 'USER', 0, 1, 1)");
  user.run("user_ann", "ann@example.test", "Ann Lee");
  user.run("user_bob", "bob@example.test", "Bob Ray");
  const root = db.prepare("INSERT INTO roots (id, slug, name, base_path, created_at, updated_at) VALUES (?, ?, ?, '/x', 1, 1)");
  root.run("root_docs", "docs", "Documents");
  root.run("root_pics", "pics", "Pictures");
  db.prepare("INSERT INTO groups (id, name, created_at, updated_at) VALUES ('group_fin', 'Finance', 1, 1)").run();
}

function story(db) {
  people(db);
  const rows = [
    { actor: "user_ann", action: "login_success", at: T },
    { type: "system", action: "login_failed", target: { email: "bob@example.test" }, result: "failure", at: T + 1 },
    { actor: "user_ann", action: "create_share", root: "root_docs", path: "/Contracts/NDA.docx", target: { shareId: "share_abc123" }, at: T + 10 },
    ...[0, 1, 2, 3, 4].map((n) => ({ actor: "user_ann", action: "thumbnail", root: "root_pics", path: `/Trip/${n % 2 ? "a" : "b"}/${n}.jpg`, at: T + 20 + n })),
    { actor: "user_bob", action: "request_denied", target: { method: "GET", route: "/api/fs/thumbnail", code: "FORBIDDEN", statusCode: 403 }, result: "denied", at: T + 30 },
    { actor: "user_bob", action: "permission_denied", root: "root_docs", path: "/Secret", target: { level: "view", reason: "No permission" }, result: "denied", at: T + 40 },
    { actor: "user_bob", action: "request_denied", target: { method: "POST", route: "/api/tasks", code: "FORBIDDEN", statusCode: 403 }, result: "denied", at: T + 41 },
    ...[0, 1, 2].map((n) => ({ actor: "user_bob", action: "upload", root: "root_docs", path: `/Inbox/file${n}.txt`, at: T + 50 + n })),
    { actor: "user_ann", action: "upload", root: "root_docs", path: "/Inbox/ann.txt", at: T + 51 },
    { actor: "user_ann", action: "group_create", target: { id: "group_fin", name: "Finance" }, at: T + 60 },
    { actor: "user_ann", action: "group_member_add", target: { groupId: "group_fin", userId: "user_bob" }, at: T + 61 },
    { type: "share_link", actor: "share_abc123", action: "download_via_share", root: "root_docs", path: "/Contracts/NDA.docx", at: T + 70 },
    { type: "system", action: "task_failed", target: { taskId: "task_1", type: "copy" }, result: "failure", at: T + 80 },
    { actor: "user_ann", action: "thumbnail", root: "root_pics", path: "/Trip/late.jpg", at: T + 500 }
  ];
  seed(db, rows);
  return new AuditService(db);
}

const list = (audit, query = "") => audit.list(auditQuerySchema.parse(Object.fromEntries(new URLSearchParams(query))));
const ids = (entries) => entries.map((entry) => `${entry.action}@${entry.created_at - T}`);

function actionsWritten() {
  const dir = new URL("../src/", import.meta.url).pathname;
  const files = [];
  const walk = (folder) => {
    for (const item of readdirSync(folder, { withFileTypes: true })) {
      if (item.isDirectory()) walk(path.join(folder, item.name));
      else if (item.name.endsWith(".ts") && item.name !== "audit-actions.ts") files.push(path.join(folder, item.name));
    }
  };
  walk(dir);
  const source = files.map((file) => readFileSync(file, "utf8")).join("\n");
  const written = new Set();
  // `action: "x"` as a written row has it, not as a target names one; `auditAs(actor, "x"` and the recovery tool's `audit("x"`.
  for (const line of source.split("\n")) {
    for (const match of line.matchAll(/action: "([a-z_]+)"/g)) if (!line.slice(0, match.index).includes("target:")) written.add(match[1]);
    for (const match of line.matchAll(/auditAs\([\w.]+, "([a-z_]+)"/g)) written.add(match[1]);
    for (const match of line.matchAll(/\baudit\("([a-z_]+)"/g)) written.add(match[1]);
    for (const match of line.matchAll(/action: [^"\n]*\? "([a-z_]+)" : "([a-z_]+)"/g)) { written.add(match[1]); written.add(match[2]); }
  }
  return { written, source };
}

test("every action the server writes has a category, and the table holds nothing it does not write unless retired", () => {
  const { written, source } = actionsWritten();
  for (const action of written) assert.ok(auditActions[action], `${action} is written but has no category`);
  for (const action of Object.keys(auditActions)) {
    assert.ok(auditCategories.includes(auditActions[action].category), `${action} has a category that does not exist`);
    if (retiredActions.has(action)) assert.equal(written.has(action), false, `${action} is retired but something still writes it`);
    else assert.ok(source.includes(`"${action}"`), `${action} is in the table but nothing writes it`);
  }
  for (const action of retiredActions) assert.ok(auditActions[action], `${action} is retired but its old rows would have no class`);
  for (const category of auditCategories) assert.ok(Object.values(auditActions).some((kind) => kind.category === category), `${category} holds no action`);
  assert.deepEqual(classify("an_action_since_removed"), { category: "system", signal: "normal" });
});

test("a refused request is as quiet as the thing it asked for, a failed sign-in and a denied delete are not", () => {
  assert.equal(classify("request_denied", { route: "/api/fs/thumbnail" }).signal, "low");
  assert.equal(classify("request_failed", { route: "/api/media/storyboard/sheet" }).signal, "low");
  assert.equal(classify("request_denied", { route: "/api/tasks" }).signal, "normal");
  assert.equal(classify("request_failed", { route: "/api/tasks", statusCode: 404 }).signal, "low", "a request that failed says nothing of what was wanted");
  assert.equal(classify("request_failed", { route: "/api/tasks", statusCode: 500 }).signal, "normal", "unless the fault was the server's");
  assert.equal(classify("permission_denied").signal, "normal");
  assert.equal(classify("login_failed").signal, "normal");
  assert.equal(classify("thumbnail").signal, "low");
});

test("each filter narrows the list alone, and together", async (t) => {
  const { db, done } = await scratch();
  t.after(done);
  const audit = story(db);

  assert.equal(list(audit, "limit=500").length, 14, "a run is one row: 20 rows were written");
  assert.deepEqual(list(audit, "category=sign_in").map((entry) => entry.action).sort(), ["login_failed", "login_success"]);
  assert.deepEqual(list(audit, "category=share").map((entry) => entry.action).sort(), ["create_share", "download_via_share"]);
  assert.equal(list(audit, "important=true").some((entry) => entry.signal === "low"), false);
  assert.equal(list(audit, "important=true").length, 11);
  assert.deepEqual(list(audit, "result=failure,denied&important=true").map((entry) => entry.action).sort(), ["login_failed", "permission_denied", "request_denied", "task_failed"]);
  assert.equal(list(audit, "result=denied").length, 3);
  assert.deepEqual(list(audit, "result=failure").map((entry) => entry.action).sort(), ["login_failed", "task_failed"]);
  assert.equal(list(audit, "action=upload").length, 2, "one run each for Bob and Ann");
  assert.equal(list(audit, "actor=user_bob").length, 4);
  assert.deepEqual(list(audit, "actor=system").map((entry) => entry.action).sort(), ["login_failed", "task_failed"]);
  assert.deepEqual(list(audit, "actor=share_link").map((entry) => entry.action), ["download_via_share"]);
  assert.deepEqual(list(audit, "actor=share_abc123").map((entry) => entry.action), ["download_via_share"]);
  assert.deepEqual(list(audit, `from=${T + 60}&to=${T + 80}`).map((entry) => entry.action).sort(), ["download_via_share", "group_create", "group_member_add"]);
  assert.deepEqual(ids(list(audit, `from=${T + 400}`)), ["thumbnail@500"]);

  // Together: Bob, failures and denials, nothing quiet, in a window.
  assert.deepEqual(ids(list(audit, `actor=user_bob&result=denied&important=true&from=${T + 35}&to=${T + 45}`)), ["request_denied@41", "permission_denied@40"]);
  assert.deepEqual(ids(list(audit, `category=file&actor=user_ann&important=true`)), ["upload@51"]);
  assert.equal(list(audit, "category=file&actor=user_ann").length, 3);
  assert.equal(list(audit, "category=sign_in&result=success&q=ann").length, 1);

  assert.equal(auditQuerySchema.safeParse({ result: "bogus" }).success, false);
  assert.equal(auditQuerySchema.safeParse({ category: "bogus" }).success, false);
  assert.equal(auditQuerySchema.safeParse({ important: "yes" }).success, false);
});

test("a text is found in a name, an email, a path and what a row carries, and only where it is", async (t) => {
  const { db, done } = await scratch();
  t.after(done);
  const audit = story(db);
  const found = (q) => ids(list(audit, `q=${encodeURIComponent(q)}`)).sort();

  assert.deepEqual(found("Bob Ray"), ["group_member_add@61", "permission_denied@40", "request_denied@30", "request_denied@41", "upload@52"].sort(), "what Bob did, and what was done to him");
  assert.deepEqual(found("bob@example"), [...found("Bob Ray"), "login_failed@1"].sort(), "and a sign-in that typed his email");
  assert.ok(!found("bob").includes("login_success@0"), "Ann's sign-in is not Bob's");
  assert.deepEqual(found("ann@example.test").filter((item) => item.startsWith("login_failed")), []);
  assert.deepEqual(found("NDA.docx"), ["create_share@10", "download_via_share@70"]);
  assert.deepEqual(found("Documents/Contracts/NDA.docx"), ["create_share@10", "download_via_share@70"]);
  assert.deepEqual(found("documents/inbox"), ["upload@51", "upload@52"], "a path as it is shown, in either case");
  assert.deepEqual(found("share_abc123"), ["create_share@10", "download_via_share@70"], "the share's own id, and what was done through it");
  assert.deepEqual(found("Finance"), ["group_create@60", "group_member_add@61"]);
  assert.deepEqual(found("2.jpg"), ["thumbnail@24"], "a run is found by one of the files folded into it");
  assert.deepEqual(found("Pictures").length, 2);
  assert.deepEqual(found("nothing like this"), []);
  assert.deepEqual(found("%"), [], "a wildcard is read as itself");
  assert.deepEqual(found("_"), ["create_share@10", "group_create@60", "group_member_add@61", "task_failed@80"], "an underscore is read as itself");
});

test("rows close together fold into one that says how many, when and where", async (t) => {
  const { db, done } = await scratch();
  t.after(done);
  const audit = story(db);
  const rows = list(audit, "action=thumbnail");
  assert.equal(rows.length, 2);
  const [late, run] = rows;
  assert.equal(late.burst, null);
  assert.equal(late.path, "/Trip/late.jpg");
  assert.equal(run.burst.count, 5);
  assert.equal(run.created_at, T + 24);
  assert.equal(run.burst.first_at, T + 20);
  assert.equal(run.path, "/Trip/0/4.jpg".replace("/0/", "/b/"), "the row stands for the newest file");
  assert.deepEqual(run.burst.folders.map((folder) => folder.path), ["/Trip/b", "/Trip/a"]);
  assert.equal(run.burst.folders_truncated, false);
  assert.equal(run.category, "file");
  assert.equal(run.signal, "low");
  assert.equal(run.root_name, "Pictures");

  const members = audit.runMembers(run.burst.id, auditRunMembersSchema.parse({}));
  assert.equal(members.length, 5);
  assert.deepEqual(members.map((member) => member.created_at), [T + 24, T + 23, T + 22, T + 21, T + 20]);
  assert.equal(members.every((member) => member.burst === null), true);
  assert.equal(audit.runMembers(run.burst.id, auditRunMembersSchema.parse({ limit: "2" })).length, 2);
  const next = audit.runMembers(run.burst.id, auditRunMembersSchema.parse({ limit: "2", before: `${members[1].created_at}:${members[1].id}` }));
  assert.deepEqual(next.map((member) => member.id), members.slice(2, 4).map((member) => member.id));
  assert.equal(audit.runMembers("audit_nope", auditRunMembersSchema.parse({})), null);

  const bob = list(audit, "action=upload&actor=user_bob")[0];
  assert.equal(bob.burst.count, 3, "another person's upload in the same seconds is not part of the run");
});

test("a run ends after a pause of a minute and after an hour, and runs of different people do not meet", async (t) => {
  const { db, done } = await scratch();
  t.after(done);
  people(db);
  const steady = Array.from({ length: 130 }, (_, n) => ({ actor: "user_ann", action: "thumbnail", path: `/a/${n}.jpg`, at: T + n * 60 }));
  seed(db, [...steady, { actor: "user_ann", action: "thumbnail", path: "/pause.jpg", at: T + 129 * 60 + 61 }, { actor: "user_ann", action: "thumbnail", result: "failure", path: "/failed.jpg", at: T + 5 }]);
  const audit = new AuditService(db);
  const runs = list(audit, "action=thumbnail&limit=500");
  assert.deepEqual(runs.map((row) => row.burst?.count ?? 1).sort((a, b) => a - b), [1, 1, 8, 61, 61], "a failure is its own run; an hour cuts the unbroken one twice; a pause of 61 seconds starts a new one");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE head = 1").get().n, 5);
});

test("a run that is written live is joined as it grows and listed once", async (t) => {
  const { db, done } = await scratch();
  t.after(done);
  const audit = new AuditService(db);
  const folder = (n) => ({ actorType: "user", actorId: "user_ann", action: "thumbnail", rootId: "root_pics", path: `/f${n % 3}/${n}.jpg`, result: "success" });
  for (let n = 0; n < 7; n += 1) audit.write(folder(n));
  audit.write({ actorType: "user", actorId: "user_bob", action: "thumbnail", rootId: "root_pics", path: "/b.jpg", result: "success" });
  const rows = list(audit, "limit=500");
  assert.equal(rows.length, 2);
  const ann = rows.find((row) => row.actor_id === "user_ann");
  assert.equal(ann.burst.count, 7);
  assert.equal(ann.burst.folders.length, 3);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE run_id = ?").get(ann.burst.id).n, 7);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE run_id = ? AND head = 1").get(ann.burst.id).n, 1);
  assert.equal(audit.runMembers(ann.burst.id, auditRunMembersSchema.parse({})).length, 7);
});

test("paging never splits a run or counts one twice, across a boundary in the middle of one", async (t) => {
  const { db, done } = await scratch();
  t.after(done);
  people(db);
  const rows = [];
  let at = T;
  for (let block = 0; block < 6; block += 1) {
    // Six blocks: a run of five thumbnails then three sign-ins, each a minute and a half apart so none joins another.
    for (let n = 0; n < 5; n += 1) rows.push({ actor: "user_ann", action: "thumbnail", path: `/${block}/${n}.jpg`, at: (at += 1) });
    at += 90;
    for (let n = 0; n < 3; n += 1) {
      rows.push({ actor: "user_ann", action: "login_success", at });
      at += 90;
    }
  }
  seed(db, rows);
  const audit = new AuditService(db);
  const total = rows.length;
  for (const limit of [1, 2, 3, 5, 7]) {
    const seen = [];
    let before;
    for (let guard = 0; guard < 100; guard += 1) {
      const page = audit.list(auditQuerySchema.parse({ limit: String(limit), ...(before ? { before } : {}) }));
      if (page.length === 0) break;
      seen.push(...page);
      before = `${page.at(-1).created_at}:${page.at(-1).id}`;
    }
    assert.equal(new Set(seen.map((row) => row.id)).size, seen.length, `no row twice at limit ${limit}`);
    assert.equal(seen.length, 24, `six runs and eighteen sign-ins at limit ${limit}`);
    assert.equal(seen.reduce((sum, row) => sum + (row.burst?.count ?? 1), 0), total, `every written row is counted once at limit ${limit}`);
    assert.deepEqual(seen.map((row) => row.created_at), [...seen.map((row) => row.created_at)].sort((a, b) => b - a));
  }
});

test("a log of rows from before runs is placed once, and again with no change", async (t) => {
  const { db, done } = await scratch();
  t.after(done);
  const audit = story(db);
  const before = JSON.stringify(db.prepare("SELECT id, head, run_id, run_count, run_first_at, category, signal FROM audit_logs ORDER BY id").all());
  assert.equal(placeAuditRows(db), 0);
  assert.equal(JSON.stringify(db.prepare("SELECT id, head, run_id, run_count, run_first_at, category, signal FROM audit_logs ORDER BY id").all()), before);
  assert.equal(list(audit, "limit=500").length, 14);
});

test("only an administrator can read the log, and a share link's token is not in it", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "kago-audit-http."));
  const dataDir = path.join(dir, "data");
  const appDataDir = path.join(dir, "app-data");
  await mkdir(path.join(dataDir, "photos"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  const app = await buildApp({ port: 0, dataDir, appDataDir, sessionSecret: "audit-log-test-session-secret", nodeEnv: "test" });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  await app.ready();
  const send = async (cookie, method, url, body) => {
    const response = await app.inject({ method, url, headers: { accept: "application/json", ...(cookie ? { cookie } : {}), ...(method === "GET" ? {} : { "x-kago-csrf": "1", "content-type": "application/json" }) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { response, json: response.payload && String(response.headers["content-type"]).includes("json") ? JSON.parse(response.payload) : null };
  };
  const session = (response) => [response.headers["set-cookie"]].flat().map((value) => value.split(";", 1)[0]).join("; ");
  const admin = await send(undefined, "POST", "/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" });
  assert.equal(admin.response.statusCode, 200);
  const adminCookie = session(admin.response);
  assert.equal((await send(adminCookie, "POST", "/api/users", { email: "plain@example.test", password: "fake-plain-password-123", displayName: "Plain", role: "USER" })).response.statusCode, 200);
  const plain = await send(undefined, "POST", "/api/auth/login", { email: "plain@example.test", password: "fake-plain-password-123" });
  const plainCookie = session(plain.response);

  for (const url of ["/api/audit", "/api/audit?category=file", "/api/audit/runs/audit_x"]) {
    assert.equal((await send(plainCookie, "GET", url)).response.statusCode, 403, `${url} is not for a plain user`);
    assert.equal((await send(undefined, "GET", url)).response.statusCode, 401, `${url} is not for a stranger`);
  }
  const all = await send(adminCookie, "GET", "/api/audit");
  assert.equal(all.response.statusCode, 200);
  const sample = all.json.find((entry) => entry.action === "request_denied" || entry.action === "permission_denied");
  assert.ok(sample, "the refusals of the plain user are in the log");
  assert.deepEqual(Object.keys(all.json[0]).sort(), ["action", "actor_email", "actor_id", "actor_name", "actor_type", "burst", "category", "created_at", "id", "ip", "path", "result", "root_id", "root_name", "root_slug", "signal", "target_json", "user_agent"]);
  assert.equal((await send(adminCookie, "GET", "/api/audit/runs/audit_x")).response.statusCode, 404);
  assert.equal((await send(adminCookie, "GET", "/api/audit?q=plain%40example&category=sign_in")).json.every((entry) => entry.category === "sign_in"), true);
  assert.equal((await send(adminCookie, "GET", "/api/audit?limit=9999")).response.statusCode, 400);
});

test("a log from before runs, opened by the server, is placed on the way in", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "kago-audit-old."));
  const appDataDir = path.join(dir, "app-data");
  await mkdir(appDataDir, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const old = new DatabaseSync(path.join(appDataDir, "app.db"));
  old.exec(readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8").replace(/CREATE TABLE IF NOT EXISTS audit_logs \([\s\S]*?\);/, "CREATE TABLE audit_logs (id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, root_id TEXT, path TEXT, target_json TEXT, result TEXT NOT NULL, ip TEXT, user_agent TEXT, created_at INTEGER NOT NULL);").replace(/CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at[^;]*;/, "CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at);"));
  old.exec("INSERT INTO audit_logs (id, actor_type, action, result, created_at) VALUES ('audit_a', 'system', 'login_failed', 'failure', 10), ('audit_b', 'system', 'login_failed', 'failure', 20)");
  old.close();
  const db = openDb({ appDataDir });
  const rows = db.prepare("SELECT id, head, run_count, category FROM audit_logs ORDER BY id").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ id: "audit_a", head: 0, run_count: 1, category: "sign_in" }, { id: "audit_b", head: 1, run_count: 2, category: "sign_in" }]);
  db.close();
});

test("a thumbnail is drawn without a row, a refused one leaves its denial, and an old thumbnail row still reads as quiet", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "kago-audit-thumb."));
  const dataDir = path.join(dir, "data");
  const appDataDir = path.join(dir, "app-data");
  await mkdir(path.join(dataDir, "photos"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(dataDir, "photos", "note.txt"), "a note");
  const app = await buildApp({ port: 0, dataDir, appDataDir, sessionSecret: "audit-log-test-session-secret", nodeEnv: "test" });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  await app.ready();
  const send = async (cookie, method, url, body) =>
    app.inject({ method, url, headers: { accept: "application/json", ...(cookie ? { cookie } : {}), ...(method === "GET" ? {} : { "x-kago-csrf": "1", "content-type": "application/json" }) }, payload: body === undefined ? undefined : JSON.stringify(body) });
  const session = (response) => [response.headers["set-cookie"]].flat().map((value) => value.split(";", 1)[0]).join("; ");
  const admin = session(await send(undefined, "POST", "/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" }));
  await send(admin, "POST", "/api/users", { email: "plain@example.test", password: "fake-plain-password-123", displayName: "Plain", role: "USER" });
  const plain = session(await send(undefined, "POST", "/api/auth/login", { email: "plain@example.test", password: "fake-plain-password-123" }));
  const read = async (action) => JSON.parse((await send(admin, "GET", `/api/audit?action=${action}&limit=200`)).payload);

  const url = "/api/fs/thumbnail?rootSlug=photos&path=/note.txt";
  for (let n = 0; n < 3; n++) assert.equal((await send(admin, "GET", url)).statusCode, 200, "the thumbnail is still drawn");
  assert.equal((await read("thumbnail")).length, 0, "drawing one writes no row");

  assert.equal((await send(plain, "GET", url)).statusCode, 403, "a refused thumbnail is still refused");
  const denied = await read("permission_denied");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].path, "/note.txt");
  assert.equal((await read("request_denied")).length, 0, "the refusal is said once, by whoever refused");
  // A refusal nobody else wrote down is still the request's to record.
  assert.equal((await app.inject({ method: "POST", url: "/api/tasks", headers: { cookie: plain, "content-type": "application/json" }, payload: "{}" })).statusCode, 403);
  const refused = await read("request_denied");
  assert.equal(refused.length, 1);
  assert.equal(JSON.parse(refused[0].target_json).code, "CSRF_REQUIRED");
  assert.equal(refused[0].signal, "normal");
  assert.equal((await read("thumbnail")).length, 0, "nor does the refusal write one");

  // A row from before thumbnails were left out is in a log that is not ours to thin.
  const db = new DatabaseSync(path.join(appDataDir, "app.db"));
  db.exec("INSERT INTO audit_logs (id, actor_type, actor_id, action, result, created_at) VALUES ('audit_old_thumb', 'user', 'user_gone', 'thumbnail', 'success', 5)");
  placeAuditRows(db);
  db.close();
  const old = await read("thumbnail");
  assert.deepEqual(old.map((entry) => [entry.id, entry.signal, entry.category]), [["audit_old_thumb", "low", "file"]]);
  const important = JSON.parse((await send(admin, "GET", "/api/audit?important=true&limit=200")).payload);
  assert.equal(important.some((entry) => entry.action === "thumbnail"), false, "and it is left out of what an admin reads first");
});
