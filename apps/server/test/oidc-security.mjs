import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync, sign as signData } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { verifyIdToken } from "../src/lib/id-token.ts";
import { SecretBox } from "../src/lib/secret-box.ts";
import { AuditService } from "../src/services/audit.service.ts";
import { AuthService } from "../src/services/auth.service.ts";
import { GroupService } from "../src/services/group.service.ts";
import { OidcService, safeReturnTo } from "../src/services/oidc.service.ts";

const password = "fake-oidc-password-123";
const clientId = "kago-client";
const clientSecret = "fake-client-secret";
const publicUrl = "http://kago.test";
const schema = readFileSync(new URL("../src/db/schema.sql", import.meta.url), "utf8");

const alice = { sub: "alice-subject", email: "alice@example.test", name: "Alice" };

test("an identity signs in only to the account it was linked to", async (t) => {
  const kago = await harness(t);
  const owner = await kago.auth.createUser({ email: "owner@example.test", password, displayName: "Owner", role: "USER" });

  // An email the provider has not verified belongs to an existing account, and that is not enough to get into it.
  for (const unverified of [{}, { email_verified: false }, { email_verified: "false" }, { email_verified: 1 }]) {
    const stranger = browser();
    await assert.rejects(kago.signIn(stranger, { ...alice, email: "owner@example.test", ...unverified }), { code: "OIDC_EMAIL_UNVERIFIED" });
    assert.equal(stranger.cookies.kago_session, undefined);
  }
  assert.deepEqual(kago.oidc.identitiesOf(owner.id), []);

  // The owner signs in with the password and links the identity; from then on it signs in as them.
  const own = browser();
  await kago.auth.login(own.request, own.reply, "owner@example.test", password);
  const linked = await kago.finish(own, await kago.oidc.begin(own.reply, { linkUserId: owner.id }), alice);
  assert.equal(linked.kind, "link");

  const later = browser();
  const signedIn = await kago.signIn(later, alice);
  assert.equal(signedIn.actor.id, owner.id);
  assert.equal(kago.auth.actorFromRequest(later.request).id, owner.id);
  // The provider was sent the code verifier and the client's secret, and nothing was kept in the address but the state.
  const exchange = kago.provider.exchanges.at(-1);
  assert.equal(exchange.authorization, `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`);
  assert.ok(exchange.params.get("code_verifier").length >= 43);
});

test("accounts are made only when that is turned on, never over an existing email, and never as administrators", async (t) => {
  const kago = await harness(t);
  await kago.auth.createUser({ email: "taken@example.test", password, displayName: "Taken", role: "ADMIN" });

  await assert.rejects(kago.signIn(browser(), alice), { code: "OIDC_NOT_LINKED" });
  await kago.configure({ autoCreate: true });
  // An address someone only claims does not get them an existing account, nor a second one beside it.
  await assert.rejects(kago.signIn(browser(), { ...alice, email: "taken@example.test" }), { code: "OIDC_EMAIL_UNVERIFIED" });
  await assert.rejects(kago.signIn(browser(), { sub: "no-email" }), { code: "OIDC_EMAIL_MISSING" });
  assert.equal(kago.db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);

  const created = await kago.signIn(browser(), { ...alice, groups: ["admins", "administrators"], role: "ADMIN" });
  assert.equal(created.created, true);
  assert.equal(created.actor.role, "USER");
  assert.equal(created.actor.email, "alice@example.test");
  // The new account has no password, and the sign-in form does not let anyone in without one.
  assert.equal(kago.auth.hasPassword(created.actor.id), false);
  for (const guess of ["", "none", password]) await assert.rejects(kago.auth.login(browser().request, browser().reply, "alice@example.test", guess || "x"), { code: "INVALID_LOGIN" });

  // Another person at the provider who only claims the same address does not get the account that now holds it.
  await assert.rejects(kago.signIn(browser(), { sub: "impostor", email: "alice@example.test" }), { code: "OIDC_EMAIL_UNVERIFIED" });
  // A disabled account stays shut whichever way it is entered.
  kago.auth.patchUser(created.actor.id, { disabled: true });
  await assert.rejects(kago.signIn(browser(), alice), { code: "ACCOUNT_DISABLED" });
});

test("an answer is accepted only by the browser that began the sign-in, and only once", async (t) => {
  const kago = await harness(t);
  await kago.configure({ autoCreate: true });

  // Someone else's code, brought to a browser that never began a sign-in.
  const victim = browser();
  const attacker = browser();
  const attackerUrl = await kago.oidc.begin(attacker.reply, {});
  const stolen = kago.provider.authorize(attackerUrl, alice);
  victim.request.query = stolen;
  await assert.rejects(kago.oidc.finish(victim.request, victim.reply), { code: "OIDC_FLOW_INVALID" });

  // A browser in the middle of its own sign-in is handed a code that belongs to another one.
  const own = browser();
  await kago.oidc.begin(own.reply, {});
  own.request.query = stolen;
  await assert.rejects(kago.oidc.finish(own.request, own.reply), { code: "OIDC_FLOW_INVALID" });
  // Whichever way it ended, what the browser was carrying is spent.
  assert.equal(own.cookies.kago_oidc, undefined);

  // The provider says no, or the person backs out.
  const refused = browser();
  const refusedUrl = await kago.oidc.begin(refused.reply, {});
  refused.request.query = { state: new URL(refusedUrl).searchParams.get("state"), error: "access_denied" };
  await assert.rejects(kago.oidc.finish(refused.request, refused.reply), { code: "OIDC_PROVIDER_REFUSED" });

  // A sign-in that went through cannot be played back.
  const done = browser();
  const url = await kago.oidc.begin(done.reply, {});
  const carried = done.cookies.kago_oidc;
  const answer = kago.provider.authorize(url, alice);
  done.request.query = answer;
  await kago.oidc.finish(done.request, done.reply);
  const replay = browser();
  replay.cookies.kago_oidc = carried;
  replay.request.query = answer;
  await assert.rejects(kago.oidc.finish(replay.request, replay.reply), { code: "OIDC_TOKEN_FAILED" });
});

test("a token the provider did not sign for this sign-in is turned down", async (t) => {
  const kago = await harness(t);
  await kago.configure({ autoCreate: true });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicPem = kago.provider.publicKey.export({ type: "spki", format: "pem" });
  const forgeries = {
    "signed by another key": (claims) => jwt(claims, other.privateKey, { alg: "RS256", kid: "k1" }),
    "not signed at all": (claims) => `${part({ alg: "none" })}.${part(claims)}.`,
    "signed with the public key as a shared secret": (claims) => {
      const head = `${part({ alg: "HS256", kid: "k1" })}.${part(claims)}`;
      return `${head}.${createHmac("sha256", publicPem).update(head).digest("base64url")}`;
    },
    "for another sign-in": (claims) => kago.provider.sign({ ...claims, nonce: "someone-else" }),
    "without a nonce": ({ nonce: _nonce, ...claims }) => kago.provider.sign(claims),
    "for another client": (claims) => kago.provider.sign({ ...claims, aud: "another-client" }),
    "for several clients without naming this one": (claims) => kago.provider.sign({ ...claims, aud: [clientId, "another-client"] }),
    "from another issuer": (claims) => kago.provider.sign({ ...claims, iss: "https://evil.example.test" }),
    "expired": (claims) => kago.provider.sign({ ...claims, exp: claims.iat - 3600 }),
    "dated in the future": (claims) => kago.provider.sign({ ...claims, iat: claims.iat + 3600 }),
    "changed after signing": (claims) => {
      const [head, , signature] = kago.provider.sign(claims).split(".");
      return `${head}.${part({ ...claims, sub: "someone-else" })}.${signature}`;
    },
    "missing": () => undefined
  };
  for (const [name, mint] of Object.entries(forgeries)) {
    kago.provider.mint = mint;
    const visitor = browser();
    await assert.rejects(kago.signIn(visitor, alice), { code: "OIDC_TOKEN_INVALID" }, name);
    assert.equal(visitor.cookies.kago_session, undefined, name);
  }
  assert.equal(kago.db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 0);

  // The real thing still works afterwards, with several audiences when this client is the one named.
  kago.provider.mint = (claims) => kago.provider.sign({ ...claims, aud: [clientId, "another-client"], azp: clientId });
  assert.equal((await kago.signIn(browser(), alice)).actor.email, "alice@example.test");
});

test("each signing algorithm is checked against its own kind of key", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: "https://id.example.test", sub: "subject", aud: clientId, iat: now, exp: now + 300, nonce: "n" };
  const expected = { issuer: claims.iss, audience: clientId, nonce: "n" };
  const pairs = {
    RS256: generateKeyPairSync("rsa", { modulusLength: 2048 }),
    PS256: generateKeyPairSync("rsa", { modulusLength: 2048 }),
    ES256: generateKeyPairSync("ec", { namedCurve: "P-256" }),
    ES384: generateKeyPairSync("ec", { namedCurve: "P-384" }),
    ES512: generateKeyPairSync("ec", { namedCurve: "P-521" }),
    EdDSA: generateKeyPairSync("ed25519")
  };
  for (const [alg, pair] of Object.entries(pairs)) {
    const keys = [{ ...pair.publicKey.export({ format: "jwk" }), kid: alg }];
    assert.equal(verifyIdToken(jwt(claims, pair.privateKey, { alg, kid: alg }), keys, expected).sub, "subject", alg);
    // Only the algorithms the provider says it signs with, when it says.
    assert.throws(() => verifyIdToken(jwt(claims, pair.privateKey, { alg, kid: alg }), keys, { ...expected, algorithms: ["none"] }), /not accepted/, alg);
    // A key of another kind published under the same name does not make the signature good.
    const wrong = Object.entries(pairs).find(([name]) => name !== alg && name[0] !== alg[0])[1];
    assert.throws(() => verifyIdToken(jwt(claims, pair.privateKey, { alg, kid: alg }), [{ ...wrong.publicKey.export({ format: "jwk" }), kid: alg }], expected), alg);
  }
  // RSA keys too short to be trusted are not.
  const weak = generateKeyPairSync("rsa", { modulusLength: 1024 });
  assert.throws(() => verifyIdToken(jwt(claims, weak.privateKey, { alg: "RS256", kid: "weak" }), [{ ...weak.publicKey.export({ format: "jwk" }), kid: "weak" }], expected), /signature/);
});

test("linking needs the session that asked for it, and an identity belongs to one account", async (t) => {
  const kago = await harness(t);
  const first = await kago.auth.createUser({ email: "first@example.test", password, displayName: "First", role: "USER" });
  const second = await kago.auth.createUser({ email: "second@example.test", password, displayName: "Second", role: "USER" });

  // Asked for by one account, answered in a browser signed in to another: nothing is linked.
  const mixed = browser();
  const url = await kago.oidc.begin(mixed.reply, { linkUserId: first.id });
  await kago.auth.login(mixed.request, mixed.reply, "second@example.test", password);
  await assert.rejects(kago.finish(mixed, url, alice), { code: "OIDC_LINK_SESSION" });
  // And not in a browser that is not signed in at all.
  const anonymous = browser();
  await assert.rejects(kago.finish(anonymous, await kago.oidc.begin(anonymous.reply, { linkUserId: first.id }), alice), { code: "OIDC_LINK_SESSION" });
  assert.deepEqual(kago.oidc.identitiesOf(first.id), []);
  assert.deepEqual(kago.oidc.identitiesOf(second.id), []);

  const one = browser();
  await kago.auth.login(one.request, one.reply, "first@example.test", password);
  await kago.finish(one, await kago.oidc.begin(one.reply, { linkUserId: first.id }), alice);
  const two = browser();
  await kago.auth.login(two.request, two.reply, "second@example.test", password);
  await assert.rejects(kago.finish(two, await kago.oidc.begin(two.reply, { linkUserId: second.id }), alice), { code: "OIDC_IDENTITY_TAKEN" });
  assert.equal(kago.oidc.identitiesOf(first.id).length, 1);
  assert.equal(kago.oidc.identitiesOf(first.id)[0].issuer, kago.provider.issuer);
});

test("unlinking ends the sessions the identity began and never leaves an account without a way in", async (t) => {
  const kago = await harness(t);
  await kago.configure({ autoCreate: true });
  const phone = browser();
  const laptop = browser();
  const { actor } = await kago.signIn(phone, alice);
  await kago.signIn(laptop, alice);
  const [identity] = kago.oidc.identitiesOf(actor.id);

  assert.throws(() => kago.oidc.unlink(actor.id, identity.id, { keepWayIn: true, request: laptop.request }), { code: "OIDC_LAST_SIGN_IN" });
  // Someone else's identity is not theirs to unlink.
  const other = await kago.auth.createUser({ email: "other@example.test", password, displayName: "Other", role: "USER" });
  assert.throws(() => kago.oidc.unlink(other.id, identity.id, { keepWayIn: true }), { code: "IDENTITY_NOT_FOUND" });

  // With no password yet, the first is set without asking for one; after that the current one is asked for.
  await kago.auth.changePassword(laptop.request, actor, { newPassword: password });
  await assert.rejects(kago.auth.changePassword(laptop.request, actor, { newPassword: "another-password-123" }), { code: "INVALID_CURRENT_PASSWORD" });
  await kago.signIn(phone, alice);
  kago.oidc.unlink(actor.id, identity.id, { keepWayIn: true, request: laptop.request });
  assert.equal(kago.auth.actorFromRequest(phone.request), null);
  assert.equal(kago.auth.actorFromRequest(laptop.request).id, actor.id);
  await assert.rejects(kago.signIn(browser(), alice), { code: "OIDC_EMAIL_UNVERIFIED" });
});

test("an identity seen for the first time joins the account with its verified email address", async (t) => {
  const kago = await harness(t);
  const owner = await kago.auth.createUser({ email: "Alice@Example.test", password, displayName: "Alice", role: "ADMIN" });
  const verified = { ...alice, email: "alice@example.TEST", email_verified: true };

  // Nobody has to be let in from scratch for this: the account is already Kago's own.
  const first = await kago.signIn(browser(), verified);
  assert.deepEqual([first.actor.id, first.merged, first.created, first.actor.role], [owner.id, true, false, "ADMIN"]);
  assert.equal(kago.auth.hasPassword(owner.id), true);
  assert.equal(kago.db.prepare("SELECT COUNT(*) AS count FROM users").get().count, 1);

  // From then on it is the link that counts: the same person under a new address is still them,
  const moved = await kago.signIn(browser(), { ...alice, email: "elsewhere@example.test", email_verified: true });
  assert.deepEqual([moved.actor.id, moved.merged], [owner.id, false]);
  assert.equal(kago.oidc.identitiesOf(owner.id).length, 1);
  // and an identity that is already someone's is not moved to whoever has its address now.
  const other = await kago.auth.createUser({ email: "elsewhere@example.test", password, displayName: "Other", role: "USER" });
  assert.equal((await kago.signIn(browser(), { ...alice, email: "elsewhere@example.test", email_verified: true })).actor.id, owner.id);
  assert.deepEqual(kago.oidc.identitiesOf(other.id), []);

  // A second person at the provider with the same verified address is linked to the same account, as the provider vouches.
  const second = await kago.signIn(browser(), { sub: "alice-second-device", email: "alice@example.test", email_verified: "true" });
  assert.deepEqual([second.actor.id, second.merged], [owner.id, true]);

  // A disabled account is not joined, and nothing is left linked to it.
  const closed = await kago.auth.createUser({ email: "closed@example.test", password, displayName: "Closed", role: "USER" });
  kago.auth.patchUser(closed.id, { disabled: true });
  await assert.rejects(kago.signIn(browser(), { sub: "closed-subject", email: "closed@example.test", email_verified: true }), { code: "ACCOUNT_DISABLED" });
  assert.deepEqual(kago.oidc.identitiesOf(closed.id), []);
});

test("the provider's groups fill only the groups mapped to them, and take back only what they gave", async (t) => {
  const kago = await harness(t);
  const groups = new GroupService(kago.db);
  const family = groups.create("Family");
  const media = groups.create("Media");
  const staff = groups.create("Staff");
  await kago.configure({ autoCreate: true, syncGroups: true, groupMappings: [{ external: "family", groupId: family.id }, { external: "kin", groupId: family.id }, { external: "media", groupId: media.id }, { external: "gone", groupId: "group_missing" }] });
  const memberships = (userId) => kago.db.prepare("SELECT group_id FROM group_members WHERE user_id = ? ORDER BY group_id").all(userId).map((entry) => entry.group_id).sort();

  const { actor } = await kago.signIn(browser(), { ...alice, groups: ["kin", "media", "staff", "admins"] });
  assert.deepEqual(memberships(actor.id), [family.id, media.id].sort());
  assert.equal(kago.auth.getUser(actor.id).role, "USER");

  // Staff was given by hand; media, also held by hand from here on, is no longer the provider's to take away.
  groups.addMember(staff.id, actor.id);
  groups.addMember(media.id, actor.id);
  await kago.signIn(browser(), { ...alice, groups: [] });
  assert.deepEqual(memberships(actor.id), [media.id, staff.id].sort());

  // A provider that says nothing about groups changes nothing.
  await kago.signIn(browser(), { ...alice, groups: ["family"] });
  await kago.signIn(browser(), alice);
  assert.deepEqual(memberships(actor.id), [family.id, media.id, staff.id].sort());

  // With syncing off the provider's groups are not looked at.
  await kago.configure({ autoCreate: true, syncGroups: false, groupMappings: [{ external: "family", groupId: family.id }] });
  await kago.signIn(browser(), { ...alice, groups: [] });
  assert.deepEqual(memberships(actor.id), [family.id, media.id, staff.id].sort());
});

test("a session is ended when the provider no longer stands behind it, and kept when the provider cannot be asked", async (t) => {
  const kago = await harness(t);
  const groups = new GroupService(kago.db);
  const family = groups.create("Family");
  await kago.configure({ autoCreate: true, syncGroups: true, groupMappings: [{ external: "family", groupId: family.id }] });
  kago.provider.refreshTokens = true;
  const person = { ...alice, groups: [] };
  kago.provider.people.set(person.sub, person);
  const overdue = (visitor) => kago.db.prepare("UPDATE sessions SET oidc_checked_at = 0").run() && kago.auth.actorFromRequest(visitor.request);
  const stored = () => kago.db.prepare("SELECT oidc_refresh, oidc_checked_at FROM sessions").get();

  const visitor = browser();
  const { actor } = await kago.signIn(visitor, person);
  const first = stored().oidc_refresh;
  // Sealed where it is kept: a copy of the database does not hold a token the provider would take.
  assert.match(first, /^v1:/);
  assert.ok(![...kago.provider.refresh.keys()].some((token) => first.includes(token)));

  // Still good: the token is traded for the next one, and what the provider now says about groups is applied.
  person.groups = ["family"];
  assert.equal(overdue(visitor).id, actor.id);
  await until(() => stored().oidc_checked_at > 0);
  assert.notEqual(stored().oidc_refresh, first);
  assert.equal(kago.db.prepare("SELECT COUNT(*) AS count FROM group_members WHERE user_id = ?").get(actor.id).count, 1);
  assert.deepEqual(kago.published, [{ type: "permission.updated", userId: actor.id }]);

  // The provider is down: it was asked, got no answer, and nobody is signed out for that.
  const patient = browser();
  await kago.signIn(patient, person);
  const asked = kago.provider.hits;
  kago.provider.down = true;
  overdue(patient);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(kago.auth.actorForSession(patient.cookies.kago_session).id, actor.id);
  assert.equal(kago.db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE oidc_checked_at = 0").get().count, 2);
  assert.ok(kago.provider.hits > asked);
  kago.provider.down = false;

  // The provider takes the sign-in back: the session ends, and the log says why.
  kago.provider.refresh.clear();
  const again = browser();
  await kago.signIn(again, person);
  kago.provider.refresh.clear();
  overdue(again);
  await until(() => kago.auth.actorForSession(again.cookies.kago_session) === null);
  assert.equal(kago.db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action = 'session_revoked'").get().count >= 1, true);
});

test("the settings keep the secret sealed, and a provider is only believed about itself", async (t) => {
  const kago = await harness(t);
  assert.equal(JSON.stringify(kago.oidc.adminView()).includes(clientSecret), false);
  assert.equal(kago.db.prepare("SELECT value_json FROM app_settings WHERE key = 'oidc'").get().value_json.includes(clientSecret), false);
  assert.equal(kago.oidc.adminView().hasClientSecret, true);
  assert.equal(kago.oidc.adminView().redirectUri, `${publicUrl}/api/auth/oidc/callback`);
  assert.deepEqual(kago.oidc.publicInfo(), { name: "Test ID", autoRedirect: false });

  // Left out, the secret stays; with `null` it goes, and the client then proves itself by PKCE alone.
  await kago.configure({ autoCreate: true });
  assert.equal(kago.oidc.adminView().hasClientSecret, true);
  await kago.configure({ autoCreate: true, clientSecret: null });
  await kago.signIn(browser(), alice);
  assert.equal(kago.provider.exchanges.at(-1).authorization, undefined);
  assert.equal(kago.provider.exchanges.at(-1).params.get("client_id"), clientId);

  // A provider that claims to be another issuer, or that cannot do PKCE, is not taken on.
  kago.provider.metadata = { issuer: "https://someone-else.example.test" };
  await assert.rejects(kago.configure({}), { code: "OIDC_ISSUER_MISMATCH" });
  kago.provider.metadata = { code_challenge_methods_supported: ["plain"] };
  await assert.rejects(kago.configure({}), { code: "OIDC_PKCE_UNSUPPORTED" });
  kago.provider.metadata = { authorization_endpoint: "javascript:alert(1)" };
  await assert.rejects(kago.configure({}), { code: "OIDC_DISCOVERY_FAILED" });
  kago.provider.metadata = {};
  await assert.rejects(kago.oidc.save({ ...kago.settings, clientId: "" }), { code: "OIDC_CONFIG_INCOMPLETE" });

  // Turned off, nothing can be begun or finished, and the sign-in page is told nothing.
  await kago.oidc.save({ ...kago.settings, enabled: false });
  assert.equal(kago.oidc.publicInfo(), null);
  await assert.rejects(kago.oidc.begin(browser().reply, {}), { code: "OIDC_DISABLED" });
});

test("after signing in nobody is sent anywhere but a page of Kago's own", () => {
  for (const safe of ["/", "/_kago/settings", "/_kago/play?rootSlug=photos&path=%2Fa.mp4"]) assert.equal(safeReturnTo(safe), safe);
  for (const unsafe of [undefined, "", "https://evil.example.test", "//evil.example.test", "/\\evil.example.test", "evil", "/api/auth/oidc/start", "/a b", `/${"a".repeat(600)}`, "javascript:alert(1)"]) {
    assert.equal(safeReturnTo(unsafe), "/", String(unsafe));
  }
});

const part = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

function jwt(claims, privateKey, header) {
  const head = `${part(header)}.${part(claims)}`;
  const options = { RS256: ["sha256", privateKey], PS256: ["sha256", { key: privateKey, padding: 6, saltLength: 32 }], ES256: ["sha256", { key: privateKey, dsaEncoding: "ieee-p1363" }], ES384: ["sha384", { key: privateKey, dsaEncoding: "ieee-p1363" }], ES512: ["sha512", { key: privateKey, dsaEncoding: "ieee-p1363" }], EdDSA: [null, privateKey] }[header.alg];
  return `${head}.${signData(options[0], Buffer.from(head), options[1]).toString("base64url")}`;
}

async function until(condition) {
  for (let waited = 0; waited < 3000; waited += 10) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("timed out waiting");
}

/** A browser as the services see it: one jar of cookies that requests read and replies write. */
function browser() {
  const cookies = {};
  return {
    cookies,
    request: { cookies, query: {}, ip: "10.0.0.1", protocol: "http", headers: {} },
    reply: {
      setCookie(name, value) {
        cookies[name] = value;
      },
      clearCookie(name) {
        delete cookies[name];
      }
    }
  };
}

/** An identity provider good enough to sign in at, whose answers a test can bend. */
async function startProvider(t) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const provider = {
    publicKey,
    issuer: "",
    codes: new Map(),
    refresh: new Map(),
    people: new Map(),
    exchanges: [],
    /** Every request that reached it, answered or not. */
    hits: 0,
    refreshTokens: false,
    down: false,
    metadata: {},
    sign: (claims) => jwt(claims, privateKey, { alg: "RS256", kid: "k1" }),
    mint: (claims) => provider.sign(claims),
    /** Plays the person signing in at the provider: returns what it sends the browser back with. */
    authorize(url, person) {
      const params = new URL(url).searchParams;
      assert.equal(params.get("response_type"), "code");
      assert.equal(params.get("client_id"), clientId);
      assert.equal(params.get("code_challenge_method"), "S256");
      assert.ok(params.get("scope").split(" ").includes("openid"));
      const code = `code-${provider.codes.size}-${Math.random().toString(36).slice(2)}`;
      provider.codes.set(code, { person, challenge: params.get("code_challenge"), nonce: params.get("nonce"), redirectUri: params.get("redirect_uri") });
      return { code, state: params.get("state") };
    }
  };
  const claimsFor = (person, nonce) => {
    const now = Math.floor(Date.now() / 1000);
    return { iss: provider.issuer, aud: clientId, iat: now, exp: now + 300, ...(nonce ? { nonce } : {}), ...person };
  };
  const issue = (person, nonce) => {
    const answer = { access_token: `access-${Math.random().toString(36).slice(2)}`, token_type: "Bearer", id_token: provider.mint(claimsFor(person, nonce)) };
    if (provider.refreshTokens) {
      answer.refresh_token = `refresh-${Math.random().toString(36).slice(2)}`;
      provider.refresh.set(answer.refresh_token, person.sub);
    }
    return answer;
  };
  const server = createServer(async (request, response) => {
    const send = (status, body) => response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    provider.hits += 1;
    if (provider.down) return void request.socket.destroy();
    if (request.url === "/.well-known/openid-configuration") {
      return send(200, { issuer: provider.issuer, authorization_endpoint: `${provider.issuer}/authorize`, token_endpoint: `${provider.issuer}/token`, jwks_uri: `${provider.issuer}/jwks`, code_challenge_methods_supported: ["S256"], id_token_signing_alg_values_supported: ["RS256"], ...provider.metadata });
    }
    if (request.url === "/jwks") return send(200, { keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" }] });
    if (request.url === "/token" && request.method === "POST") {
      let text = "";
      for await (const chunk of request) text += chunk;
      const params = new URLSearchParams(text);
      provider.exchanges.push({ params, authorization: request.headers.authorization });
      if (params.get("grant_type") === "refresh_token") {
        const sub = provider.refresh.get(params.get("refresh_token"));
        provider.refresh.delete(params.get("refresh_token"));
        return sub ? send(200, issue(provider.people.get(sub))) : send(400, { error: "invalid_grant" });
      }
      const entry = provider.codes.get(params.get("code"));
      provider.codes.delete(params.get("code"));
      const proven = entry && createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url") === entry.challenge && params.get("redirect_uri") === entry.redirectUri;
      return proven ? send(200, issue(entry.person, entry.nonce)) : send(400, { error: "invalid_grant" });
    }
    send(404, {});
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  provider.issuer = `http://127.0.0.1:${server.address().port}`;
  t.after(() => server.close());
  return provider;
}

async function harness(t) {
  const provider = await startProvider(t);
  const dir = mkdtempSync(path.join(tmpdir(), "kago-oidc-"));
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(schema);
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const published = [];
  const auth = new AuthService(db, {});
  const oidc = new OidcService(db, new SecretBox(dir), auth, new AuditService(db), { publish: (event) => published.push(event) });
  const settings = { enabled: true, name: "Test ID", issuer: provider.issuer, clientId, publicUrl, scopes: "openid profile email", autoCreate: false, autoRedirect: false, syncGroups: false, groupsClaim: "groups", groupMappings: [] };
  const kago = {
    db,
    auth,
    oidc,
    provider,
    published,
    settings,
    configure: (patch) => oidc.save({ ...settings, ...patch }),
    /** The way back from the provider, for a sign-in begun at `url`. */
    async finish(visitor, url, person) {
      visitor.request.query = provider.authorize(url, person);
      return oidc.finish(visitor.request, visitor.reply);
    },
    async signIn(visitor, person) {
      return kago.finish(visitor, await oidc.begin(visitor.reply, {}), person);
    }
  };
  await oidc.save({ ...settings, clientSecret });
  return kago;
}
