import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AuditService } from "../src/services/audit.service.ts";
import { AuthService } from "../src/services/auth.service.ts";

test("what a caller wrote is cut to size before it is kept", () => {
  const { db, audit } = harness();
  audit.write({ actorType: "system", action: "login_failed", target: { email: "a".repeat(100_000) }, result: "failure", ip: "10.0.0.1", userAgent: "u".repeat(50_000), path: "/".repeat(50_000) });
  const row = db.prepare("SELECT * FROM audit_logs").get();
  assert.ok(row.user_agent.length <= 513);
  assert.ok(row.path.length <= 2049);
  assert.ok(row.target_json.length <= 4096);
  assert.ok(JSON.parse(row.target_json).email.length <= 513);
});

test("a caller who is not signed in can only fill so many rows with failures", () => {
  const { db, audit } = harness();
  for (let attempt = 0; attempt < 1000; attempt += 1) audit.write({ actorType: "system", action: "request_failed", result: "failure", ip: "10.0.0.1" });
  audit.write({ actorType: "system", action: "request_failed", result: "failure", ip: "10.0.0.2" });
  audit.write({ actorType: "user", actorId: "user_1", action: "request_denied", result: "denied", ip: "10.0.0.1" });
  audit.write({ actorType: "system", action: "sync_failed", result: "failure" });
  audit.write({ actorType: "system", action: "login_success", result: "success", ip: "10.0.0.1" });
  const count = (where) => db.prepare(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${where}`).get().n;
  assert.equal(count("ip = '10.0.0.1' AND action = 'request_failed'"), 120);
  assert.equal(count("ip = '10.0.0.2'"), 1);
  assert.equal(count("actor_type = 'user'"), 1);
  assert.equal(count("action = 'sync_failed'"), 1);
  assert.equal(count("action = 'login_success'"), 1);
});

test("the log keeps its newest rows", () => {
  const { db, audit } = harness();
  const insert = db.prepare("INSERT INTO audit_logs (id, actor_type, action, result, created_at) VALUES (?, 'system', 'x', 'success', ?)");
  for (let index = 0; index < 50; index += 1) insert.run(`audit_${index}`, 1000 + index);
  assert.equal(audit.prune(20), 30);
  assert.deepEqual({ ...db.prepare("SELECT MIN(created_at) AS oldest, COUNT(*) AS n FROM audit_logs").get() }, { oldest: 1030, n: 20 });
  assert.equal(audit.prune(20), 0);
});

test("of two people setting Kago up at once, only one becomes its administrator", async () => {
  const { db } = harness();
  const auth = new AuthService(db, {});
  const setup = (email) => auth.setupAdmin({ cookies: {}, protocol: "http", ip: "10.0.0.1" }, { setCookie() {}, clearCookie() {} }, { email, password: "fake-setup-password-123", displayName: email, role: "ADMIN" });
  const results = await Promise.allSettled([setup("first@example.test"), setup("second@example.test")]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.find((result) => result.status === "rejected").reason.code, "SETUP_ALREADY_DONE");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users").get().n, 1);
});

test("the current password cannot be found out by trying from inside a session", async () => {
  const { db } = harness();
  const auth = new AuthService(db, {});
  const user = await auth.createUser({ email: "user@example.test", password: "fake-current-password-123", displayName: "User", role: "USER" });
  const request = { cookies: {}, protocol: "http", ip: "10.0.0.1" };
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(auth.changePassword(request, user, { currentPassword: "wrong", newPassword: "another-fake-password" }), { code: "INVALID_CURRENT_PASSWORD" });
  await assert.rejects(auth.changePassword(request, user, { currentPassword: "fake-current-password-123", newPassword: "another-fake-password" }), { code: "TOO_MANY_ATTEMPTS" });
});

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE audit_logs (id TEXT PRIMARY KEY, actor_type TEXT NOT NULL, actor_id TEXT, action TEXT NOT NULL, root_id TEXT, path TEXT, target_json TEXT, result TEXT NOT NULL, ip TEXT, user_agent TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
  `);
  return { db, audit: new AuditService(db) };
}
