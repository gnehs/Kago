import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AttemptLimiter } from "../src/lib/attempts.ts";
import { AuthService } from "../src/services/auth.service.ts";

const password = "fake-throttle-password-123";

test("wrong passwords for one account from one address are cut off, the right one included", async () => {
  const auth = harness();
  await createUser(auth, "user@example.test");
  for (let attempt = 0; attempt < 5; attempt += 1) await assert.rejects(signIn(auth, "user@example.test", "wrong", "10.0.0.1"), { code: "INVALID_LOGIN" });
  await assert.rejects(signIn(auth, "user@example.test", "wrong", "10.0.0.1"), { code: "TOO_MANY_ATTEMPTS", statusCode: 429 });
  await assert.rejects(signIn(auth, "user@example.test", password, "10.0.0.1"), { code: "TOO_MANY_ATTEMPTS" });
});

test("someone else guessing does not keep the owner of the account out", async () => {
  const auth = harness();
  await createUser(auth, "user@example.test");
  for (let attempt = 0; attempt < 6; attempt += 1) await signIn(auth, "user@example.test", "wrong", "10.0.0.1").catch(() => {});
  assert.equal((await signIn(auth, "user@example.test", password, "10.0.0.2")).email, "user@example.test");
});

test("signing in clears the slips before it, and never counts against the address", async () => {
  const fresh = harness();
  await createUser(fresh, "user@example.test");
  for (let attempt = 0; attempt < 200; attempt += 1) await signIn(fresh, "user@example.test", password, "10.0.0.3");
  for (let attempt = 0; attempt < 4; attempt += 1) await signIn(fresh, "user@example.test", "wrong", "10.0.0.3").catch(() => {});
  await signIn(fresh, "user@example.test", password, "10.0.0.3");
  for (let attempt = 0; attempt < 4; attempt += 1) await assert.rejects(signIn(fresh, "user@example.test", "wrong", "10.0.0.3"), { code: "INVALID_LOGIN" });
});

test("one address trying many accounts is cut off as a whole", async () => {
  const auth = harness();
  let refused = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) await signIn(auth, `guess${attempt}@example.test`, "wrong", "10.0.0.4").catch((error) => (refused += error.code === "TOO_MANY_ATTEMPTS" ? 1 : 0));
  assert.equal(refused, 10);
});

test("guesses sent all at once are counted as many", async () => {
  const auth = harness();
  await createUser(auth, "user@example.test");
  const results = await Promise.allSettled(Array.from({ length: 40 }, () => signIn(auth, "user@example.test", "wrong", "10.0.0.5")));
  assert.equal(results.filter((result) => result.reason?.code === "INVALID_LOGIN").length, 5);
  assert.equal(results.filter((result) => result.reason?.code === "TOO_MANY_ATTEMPTS").length, 35);
});

test("a block is sat out, and the next one lasts longer", () => {
  let now = 1_000_000;
  const limiter = new AttemptLimiter(() => now);
  const limits = [{ key: "who", limit: 2 }];
  limiter.begin(limits);
  limiter.begin(limits);
  assert.throws(() => limiter.begin(limits), { code: "TOO_MANY_ATTEMPTS" });
  now += 31_000;
  limiter.begin(limits);
  limiter.begin(limits);
  now += 31_000;
  assert.throws(() => limiter.begin(limits), { code: "TOO_MANY_ATTEMPTS" });
  now += 30_000;
  limiter.begin(limits);
});

test("a flood of new names does not push out the count of the address behind it", () => {
  const limiter = new AttemptLimiter(() => 1_000_000);
  let refused = false;
  for (let attempt = 0; attempt < 30_000 && !refused; attempt += 1) {
    try {
      limiter.begin([{ key: `pair:${attempt}`, limit: 5 }, { key: "address", limit: 25_000 }]);
    } catch {
      refused = true;
    }
  }
  assert.equal(refused, true);
});

function harness() {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, display_name TEXT NOT NULL, role TEXT NOT NULL, disabled INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL);
  `);
  return new AuthService(db, {});
}

const createUser = (auth, email) => auth.createUser({ email, password, displayName: email, role: "USER" });

function signIn(auth, email, secret, ip) {
  return auth.login({ cookies: {}, protocol: "http", ip }, { setCookie() {}, clearCookie() {} }, email, secret);
}
