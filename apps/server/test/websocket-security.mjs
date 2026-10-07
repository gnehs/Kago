import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AuthService } from "../src/services/auth.service.ts";
import { EventHub } from "../src/ws/events.ts";

const password = "fake-websocket-password-123";

test("a demoted admin loses admin-wide events on the existing socket", async (t) => {
  const { auth } = harness(t);
  await createUser(auth, "admin@example.test", "ADMIN");
  await createUser(auth, "backup-admin@example.test", "ADMIN");
  const signedIn = await signIn(auth, "admin@example.test");
  const socket = new FakeSocket();
  const events = new EventHub();
  events.add(socket, () => auth.actorForSession(signedIn.token));

  auth.patchUser(signedIn.actor.id, { role: "USER" });
  assert.equal(auth.actorForSession(signedIn.token).role, "USER");
  events.publish(taskCreated("another-user"));
  events.publish(taskCreated(signedIn.actor.id));

  assert.deepEqual(socket.messages, [taskCreated(signedIn.actor.id)]);
  assert.equal(socket.closeCode, undefined);
});

test("a disabled account loses events on the existing socket", async (t) => {
  const { auth } = harness(t);
  await createUser(auth, "admin@example.test", "ADMIN");
  await createUser(auth, "backup-admin@example.test", "ADMIN");
  const signedIn = await signIn(auth, "admin@example.test");
  const socket = new FakeSocket();
  const events = new EventHub();
  events.add(socket, () => auth.actorForSession(signedIn.token));

  auth.patchUser(signedIn.actor.id, { disabled: true });
  assert.equal(auth.actorForSession(signedIn.token), null);
  events.publish(taskCreated("another-user"));

  assert.deepEqual(socket.messages, []);
  assert.equal(socket.closeCode, 1008);
});

test("logout revokes the existing socket session", async (t) => {
  const { auth } = harness(t);
  await createUser(auth, "user@example.test", "USER");
  const signedIn = await signIn(auth, "user@example.test");
  const socket = new FakeSocket();
  const events = new EventHub();
  events.add(socket, () => auth.actorForSession(signedIn.token));

  auth.logout(signedIn.request, signedIn.reply);
  events.publish(taskCreated(signedIn.actor.id));

  assert.deepEqual(socket.messages, []);
  assert.equal(socket.closeCode, 1008);
});

test("changing a password revokes another session's socket", async (t) => {
  const { auth } = harness(t);
  await createUser(auth, "user@example.test", "USER");
  const current = await signIn(auth, "user@example.test");
  const other = await signIn(auth, "user@example.test");
  const socket = new FakeSocket();
  const events = new EventHub();
  events.add(socket, () => auth.actorForSession(other.token));

  await auth.changePassword(current.request, current.actor, {
    currentPassword: password,
    newPassword: "fake-websocket-password-456"
  });
  assert.ok(auth.actorForSession(current.token));
  assert.equal(auth.actorForSession(other.token), null);
  events.publish(taskCreated(current.actor.id));

  assert.deepEqual(socket.messages, []);
  assert.equal(socket.closeCode, 1008);
});

test("a user still receives their own events but not another user's", async (t) => {
  const { auth } = harness(t);
  await createUser(auth, "user@example.test", "USER");
  const signedIn = await signIn(auth, "user@example.test");
  const socket = new FakeSocket();
  const events = new EventHub();
  events.add(socket, () => auth.actorForSession(signedIn.token));

  events.publish(taskCreated(signedIn.actor.id));
  events.publish(taskCreated("another-user"));

  assert.deepEqual(socket.messages, [taskCreated(signedIn.actor.id)]);
  assert.equal(socket.closeCode, undefined);
});

function harness(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL,
      disabled INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );
  `);
  t.after(() => db.close());
  return { auth: new AuthService(db, {}) };
}

async function createUser(auth, email, role) {
  return auth.createUser({ email, password, displayName: email, role });
}

async function signIn(auth, email) {
  const cookies = {};
  const request = { cookies, protocol: "http" };
  const reply = {
    setCookie(name, value) {
      cookies[name] = value;
    },
    clearCookie() {}
  };
  const actor = await auth.login(request, reply, email, password);
  return { actor, token: cookies.kago_session, request, reply };
}

function taskCreated(userId) {
  return { type: "task.created", userId, task: { sources_json: "[]" } };
}

class FakeSocket extends EventEmitter {
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  readyState = this.OPEN;
  messages = [];
  closeCode;

  send(message) {
    this.messages.push(JSON.parse(message));
  }

  close(code) {
    this.closeCode = code;
    this.readyState = this.CLOSED;
    this.emit("close");
  }
}
