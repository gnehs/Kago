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
