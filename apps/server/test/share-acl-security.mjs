import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildApp } from "../dist/app.js";

test("share links stay within what their creator may currently do in the location", async () => {
  const fixture = await createFixture();
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", {
      email: "admin@example.test",
      password: "fake-admin-password-123",
      displayName: "Security Test Admin"
    })).statusCode, 200);

    const root = (await admin.get("/api/roots")).json[0];
    const ownerResponse = await admin.post("/api/users", {
      email: "share-owner@example.test",
      password: "fake-owner-password-123",
      displayName: "Share Owner",
      role: "USER"
    });
    assert.equal(ownerResponse.statusCode, 200);
    const ownerId = ownerResponse.json.id;
    const owner = client(app);
    assert.equal((await owner.post("/api/auth/login", {
      email: "share-owner@example.test",
      password: "fake-owner-password-123"
    })).statusCode, 200);

    const setLevel = async (level) => {
      const response = await admin.put("/api/permissions", { principalType: "user", principalId: ownerId, rootId: root.id, level });
      assert.equal(response.statusCode, 200, JSON.stringify(response.json));
    };
    const createShare = (pathName, mode) => owner.post("/api/shares", {
      rootSlug: "photos",
      path: pathName,
      mode
    });

    const withoutAnyRule = await createShare("/shared/readable.txt", "view_only");
    assert.equal(withoutAnyRule.statusCode, 403);
    assert.equal(withoutAnyRule.json.code, "FORBIDDEN");

    // Whoever can view a location can hand out a file in it.
    await setLevel("view");
    const viewShare = await createShare("/shared/readable.txt", "view_only");
    assert.equal(viewShare.statusCode, 200);
    assert.equal(JSON.parse(viewShare.json.permission_json).mode, "view_only");

    // Taking uploads changes the folder, so it takes edit.
    const uploadWithoutEdit = await createShare("/shared", "upload_only");
    assert.equal(uploadWithoutEdit.statusCode, 403);
    assert.equal(uploadWithoutEdit.json.code, "FORBIDDEN");
    const folderDownload = await createShare("/shared", "download");
    assert.equal(folderDownload.statusCode, 400);
    assert.equal(folderDownload.json.code, "SHARE_TARGET_NOT_FILE");

    await setLevel("edit");
    const folderUpload = await createShare("/shared", "upload_only");
    assert.equal(folderUpload.statusCode, 200);
    const folderInfo = await app.inject({ method: "GET", url: `/s/${folderUpload.json.token}`, headers: { accept: "application/json" } });
    assert.equal(folderInfo.statusCode, 200);
    assert.equal(folderInfo.json().mode, "upload_only");
    assert.equal(folderInfo.json().path, "/shared");
    const folderDownloadAttempt = await app.inject({ method: "GET", url: `/s/${folderUpload.json.token}/download` });
    assert.equal(folderDownloadAttempt.statusCode, 403);
    assert.equal(folderDownloadAttempt.json().code, "SHARE_DOWNLOAD_FORBIDDEN");
    const folderPreviewAttempt = await app.inject({ method: "GET", url: `/s/${folderUpload.json.token}/preview` });
    assert.equal(folderPreviewAttempt.statusCode, 403);
    assert.equal(folderPreviewAttempt.json().code, "SHARE_PREVIEW_FORBIDDEN");

    // Whoever has the link may not leave a file under a name the folder's listing leaves out.
    const upload = (name) => {
      const boundary = "kago-test-boundary";
      const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\nhidden\r\n--${boundary}--\r\n`;
      return app.inject({ method: "POST", url: `/s/${folderUpload.json.token}/upload`, headers: { "content-type": `multipart/form-data; boundary=${boundary}`, "x-kago-csrf": "1" }, payload });
    };
    for (const name of ["._notes.txt", "Thumbs.db", "desktop.ini", ".KAGO-trash"]) {
      const hidden = await upload(name);
      assert.equal(hidden.statusCode, 400, name);
      assert.equal(hidden.json().code, "INVALID_FILENAME", name);
    }
    assert.equal((await upload("visible.txt")).statusCode, 200);

    // A link gives out no more than its maker may still see.
    const revokedShare = await createShare("/shared/readable.txt", "download");
    assert.equal(revokedShare.statusCode, 200);
    await setLevel(null);
    const afterRevocation = await app.inject({ method: "GET", url: `/s/${revokedShare.json.token}/download` });
    assert.equal(afterRevocation.statusCode, 403);
    assert.equal(afterRevocation.json().code, "FORBIDDEN");
    assert.equal((await admin.get("/api/shares")).json.find((item) => item.id === revokedShare.json.id).download_count, 0);

    await setLevel("view");
    const reactivationShare = await createShare("/shared/readable.txt", "download");
    assert.equal(reactivationShare.statusCode, 200);
    assert.equal((await owner.patch(`/api/shares/${reactivationShare.json.id}`, { disabled: true })).statusCode, 200);
    await setLevel(null);
    const reactivationWithoutView = await owner.patch(`/api/shares/${reactivationShare.json.id}`, { disabled: false });
    assert.equal(reactivationWithoutView.statusCode, 403);
    assert.equal(reactivationWithoutView.json.code, "FORBIDDEN");
    await setLevel("view");
    assert.equal((await owner.patch(`/api/shares/${reactivationShare.json.id}`, { disabled: false })).statusCode, 200);

    const disabledOwnerShare = await createShare("/shared/readable.txt", "download");
    assert.equal(disabledOwnerShare.statusCode, 200);
    assert.equal((await admin.patch(`/api/users/${ownerId}`, { disabled: true })).statusCode, 200);
    const afterDisable = await app.inject({ method: "GET", url: `/s/${disabledOwnerShare.json.token}/download` });
    assert.equal(afterDisable.statusCode, 403);
    assert.equal(afterDisable.json().code, "FORBIDDEN");
    assert.equal((await admin.get("/api/shares")).json.find((item) => item.id === disabledOwnerShare.json.id).download_count, 0);
    const disabledInfo = await app.inject({ method: "GET", url: `/s/${disabledOwnerShare.json.token}`, headers: { accept: "application/json" } });
    assert.equal(disabledInfo.statusCode, 403);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("a share password opens the link for twelve hours, and only until the password changes", async (t) => {
  const fixture = await createFixture();
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" });
    const share = await admin.post("/api/shares", { rootSlug: "photos", path: "/shared/readable.txt", mode: "download", password: "fake-share-password" });
    assert.equal(share.statusCode, 200);
    const token = share.json.token;
    const download = (cookie) => app.inject({ method: "GET", url: `/s/${token}/download`, headers: cookie ? { cookie } : {} });

    const auth = await app.inject({ method: "POST", url: `/s/${token}/auth`, headers: { "content-type": "application/json", "x-kago-csrf": "1" }, payload: JSON.stringify({ password: "fake-share-password" }) });
    assert.equal(auth.statusCode, 200);
    const cookie = String(auth.headers["set-cookie"]).split(";", 1)[0];
    assert.equal((await download(cookie)).payload, "share canary");

    const [name, value] = cookie.split("=");
    const [issuedAt, mac] = decodeURIComponent(value).split(".");
    assert.equal((await download(`${name}=${Number(issuedAt) - 1}.${mac}`)).statusCode, 401, "the time it was issued is part of what is signed");
    const flipped = `${mac.slice(0, -1)}${mac.endsWith("0") ? "1" : "0"}`;
    assert.equal((await download(`${name}=${issuedAt}.${flipped}`)).statusCode, 401);

    t.mock.timers.enable({ apis: ["Date"], now: Date.now() + (12 * 60 * 60 + 5) * 1000 });
    assert.equal((await download(cookie)).statusCode, 401, "twelve hours on, the password is asked for again");
    t.mock.timers.reset();
    assert.equal((await download(cookie)).statusCode, 200);

    const db = new DatabaseSync(path.join(fixture.appDataDir, "app.db"));
    db.prepare("UPDATE share_links SET password_hash = ? WHERE id = ?").run("scrypt:00:00", share.json.id);
    db.close();
    assert.equal((await download(cookie)).statusCode, 401, "a new password turns the old one's visitors away");
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("a share's link can be copied again by whoever manages it, and given a new one", async () => {
  const fixture = await createFixture();
  let app = await buildApp(testEnv(fixture));
  let admin = client(app);
  let owner = client(app);
  const other = client(app);

  try {
    await app.ready();
    await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" });
    const root = (await admin.get("/api/roots")).json[0];
    const userIds = {};
    for (const [name, browser] of [["owner", owner], ["other", other]]) {
      const created = await admin.post("/api/users", { email: `${name}@example.test`, password: `fake-${name}-password-123`, displayName: `Share ${name}`, role: "USER" });
      userIds[name] = created.json.id;
      assert.equal((await admin.put("/api/permissions", { principalType: "user", principalId: created.json.id, rootId: root.id, level: "view" })).statusCode, 200);
      assert.equal((await browser.post("/api/auth/login", { email: `${name}@example.test`, password: `fake-${name}-password-123` })).statusCode, 200);
    }
    const download = (token) => app.inject({ method: "GET", url: `/s/${token}/download` });
    const rawShare = (id) => {
      const db = new DatabaseSync(path.join(fixture.appDataDir, "app.db"));
      try {
        return db.prepare("SELECT token_hash, token_sealed FROM share_links WHERE id = ?").get(id);
      } finally {
        db.close();
      }
    };

    const created = await owner.post("/api/shares", { rootSlug: "photos", path: "/shared/readable.txt", mode: "download" });
    assert.equal(created.statusCode, 200);
    const { id, token } = created.json;
    assert.equal(typeof token, "string");
    const listed = (await owner.get("/api/shares")).json.find((item) => item.id === id);
    assert.equal(listed.token, token, "the link comes back on its creator's list");
    assert.deepEqual(listed.creator, { id: userIds.owner, email: "owner@example.test", display_name: "Share owner", avatar_at: null });
    assert.equal((await download(listed.token)).payload, "share canary");

    const stored = rawShare(id);
    assert.ok(stored.token_sealed.startsWith("v1:"));
    assert.ok(!stored.token_sealed.includes(token), "the database keeps the link sealed, not as it was handed out");
    assert.notEqual(stored.token_hash, token);

    const asAdmin = (await admin.get("/api/shares")).json.find((item) => item.id === id);
    assert.equal(asAdmin.token, token, "an admin manages every link, so is sent every one");
    assert.equal(asAdmin.creator.display_name, "Share owner");

    const otherList = await other.get("/api/shares");
    assert.equal(otherList.statusCode, 200);
    assert.ok(!otherList.payload.includes(token));
    for (const attempt of [other.post(`/api/shares/${id}/rotate`), other.patch(`/api/shares/${id}`, { maxDownloads: 5 }), other.patch(`/api/shares/${id}`, { disabled: false })]) {
      const response = await attempt;
      assert.equal(response.statusCode, 403);
      assert.ok(!response.payload.includes(token));
    }

    for (const body of [{ maxDownloads: 0 }, { maxDownloads: -1 }, { maxDownloads: 1.5 }, { maxDownloads: "3" }, { expiresAt: "tomorrow" }, { expiresAt: 1.5 }]) {
      assert.equal((await owner.patch(`/api/shares/${id}`, body)).statusCode, 400, JSON.stringify(body));
    }
    const past = Math.floor(Date.now() / 1000) - 60;
    const expired = await owner.patch(`/api/shares/${id}`, { expiresAt: past, maxDownloads: 7 });
    assert.equal(expired.statusCode, 200);
    assert.equal(expired.json.expires_at, past);
    assert.equal(expired.json.max_downloads, 7);
    assert.equal((await download(token)).statusCode, 410);
    const revived = await owner.patch(`/api/shares/${id}`, { expiresAt: null, maxDownloads: null });
    assert.equal(revived.json.expires_at, null);
    assert.equal(revived.json.max_downloads, null);
    assert.equal(revived.json.token, token, "an update leaves the link as it was");
    assert.equal((await download(token)).statusCode, 200);

    const rotated = await owner.post(`/api/shares/${id}/rotate`);
    assert.equal(rotated.statusCode, 200);
    assert.notEqual(rotated.json.token, token);
    assert.equal((await download(token)).statusCode, 404, "the old link stops working");
    assert.equal((await download(rotated.json.token)).payload, "share canary");
    assert.equal((await owner.get("/api/shares")).json.find((item) => item.id === id).token, rotated.json.token);

    const audit = await admin.get("/api/audit");
    const actions = audit.json.filter((entry) => entry.actor_id === userIds.owner).map((entry) => entry.action);
    for (const action of ["create_share", "update_share", "rotate_share"]) assert.ok(actions.includes(action), action);
    assert.ok(![token, rotated.json.token].some((value) => audit.payload.includes(value)), "no link is written to the audit log");

    // A link made before Kago kept them: the database is upgraded in place, and the link goes on working.
    const older = await owner.post("/api/shares", { rootSlug: "photos", path: "/shared/readable.txt", mode: "download" });
    await app.close();
    const db = new DatabaseSync(path.join(fixture.appDataDir, "app.db"));
    db.exec("ALTER TABLE share_links DROP COLUMN token_sealed");
    db.close();
    app = await buildApp(testEnv(fixture));
    await app.ready();
    admin = client(app);
    owner = client(app);
    assert.equal((await owner.post("/api/auth/login", { email: "owner@example.test", password: "fake-owner-password-123" })).statusCode, 200);
    const upgraded = (await owner.get("/api/shares")).json;
    assert.equal(upgraded.find((item) => item.id === older.json.id).token, null);
    assert.equal(upgraded.find((item) => item.id === id).token, null, "what the upgrade found had no column to come from");
    assert.equal((await download(older.json.token)).statusCode, 200);
    const renewed = await owner.post(`/api/shares/${older.json.id}/rotate`);
    assert.equal(typeof renewed.json.token, "string");
    assert.equal((await download(older.json.token)).statusCode, 404);
    assert.equal((await download(renewed.json.token)).payload, "share canary");

    assert.equal((await owner.delete(`/api/shares/${older.json.id}`)).statusCode, 200);
    assert.equal(rawShare(older.json.id), undefined, "nothing of a deleted link is kept");
    assert.equal((await download(renewed.json.token)).statusCode, 404);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

function testEnv(fixture) {
  return {
    port: 0,
    dataDir: fixture.dataDir,
    appDataDir: fixture.appDataDir,
    sessionSecret: "share-acl-test-session-secret",
    nodeEnv: "test"
  };
}

async function createFixture() {
  const baseDir = await mkdtemp(path.join(tmpdir(), "kago-share-acl."));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  const sharedDir = path.join(dataDir, "photos", "shared");
  await mkdir(sharedDir, { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(sharedDir, "secret.txt"), "private canary");
  await writeFile(path.join(sharedDir, "readable.txt"), "share canary");
  return { baseDir, dataDir, appDataDir };
}

function client(app) {
  let cookie = "";

  return {
    get: (url) => request("GET", url),
    post: (url, body) => request("POST", url, body),
    put: (url, body) => request("PUT", url, body),
    patch: (url, body) => request("PATCH", url, body),
    delete: (url) => request("DELETE", url),
  };

  async function request(method, url, body) {
    const headers = {
      accept: "application/json",
      ...(cookie ? { cookie } : {}),
      ...(method === "GET" ? {} : { "x-kago-csrf": "1" })
    };
    const payload = body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) headers["content-type"] = "application/json";
    const response = await app.inject({ method, url, headers, payload });
    const setCookies = response.headers["set-cookie"];
    for (const setCookie of Array.isArray(setCookies) ? setCookies : setCookies ? [setCookies] : []) {
      const pair = setCookie.split(";", 1)[0];
      const [name] = pair.split("=");
      cookie = cookie.split("; ").filter((value) => value && !value.startsWith(`${name}=`)).concat(pair).join("; ");
    }
    return {
      statusCode: response.statusCode,
      json: String(response.headers["content-type"] ?? "").includes("application/json") && response.payload
        ? JSON.parse(response.payload)
        : null,
      payload: response.payload
    };
  }
}
