import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { buildApp } from "../dist/app.js";

test("share links stay within the creator's current path permissions", async () => {
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

    const addRule = async (pathPrefix, level) => {
      const response = await admin.post("/api/permissions", { principalType: "user", principalId: ownerId, rootId: root.id, recursive: true, pathPrefix, level });
      assert.equal(response.statusCode, 200, JSON.stringify(response.json));
      return response.json.id;
    };
    const removeRule = async (ruleId) => {
      const response = await admin.delete(`/api/permissions/${ruleId}`);
      assert.equal(response.statusCode, 200);
    };
    const createShare = (pathName, mode) => owner.post("/api/shares", {
      rootSlug: "photos",
      path: pathName,
      mode
    });

    const withoutAnyRule = await createShare("/shared/readable.txt", "view_only");
    assert.equal(withoutAnyRule.statusCode, 403);
    assert.equal(withoutAnyRule.json.code, "FORBIDDEN");

    // Whoever can view a file can hand it out, and nothing next to it.
    const viewReadable = await addRule("/shared/readable.txt", "view");
    const viewShare = await createShare("/shared/readable.txt", "view_only");
    assert.equal(viewShare.statusCode, 200);
    assert.equal(JSON.parse(viewShare.json.permission_json).mode, "view_only");
    const unviewableDownload = await createShare("/shared/secret.txt", "download");
    assert.equal(unviewableDownload.statusCode, 403);
    assert.equal(unviewableDownload.json.code, "FORBIDDEN");
    assert.equal((await createShare("/shared/secret.txt", "view_only")).statusCode, 403);

    // Taking uploads changes the folder, so it takes edit.
    const viewFolder = await addRule("/shared", "view");
    const uploadWithoutEdit = await createShare("/shared", "upload_only");
    assert.equal(uploadWithoutEdit.statusCode, 403);
    assert.equal(uploadWithoutEdit.json.code, "FORBIDDEN");
    const folderDownload = await createShare("/shared", "download");
    assert.equal(folderDownload.statusCode, 400);
    assert.equal(folderDownload.json.code, "SHARE_TARGET_NOT_FILE");
    await removeRule(viewFolder);

    const editFolder = await addRule("/shared", "edit");
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
    await removeRule(editFolder);

    const revokedShare = await createShare("/shared/readable.txt", "download");
    assert.equal(revokedShare.statusCode, 200);
    await removeRule(viewReadable);
    const afterRevocation = await app.inject({ method: "GET", url: `/s/${revokedShare.json.token}/download` });
    assert.equal(afterRevocation.statusCode, 403);
    assert.equal(afterRevocation.json().code, "FORBIDDEN");
    assert.equal((await admin.get("/api/shares")).json.find((item) => item.id === revokedShare.json.id).download_count, 0);

    const restored = await addRule("/shared/readable.txt", "view");
    const reactivationShare = await createShare("/shared/readable.txt", "download");
    assert.equal(reactivationShare.statusCode, 200);
    assert.equal((await owner.patch(`/api/shares/${reactivationShare.json.id}`, { disabled: true })).statusCode, 200);
    await removeRule(restored);
    const reactivationWithoutView = await owner.patch(`/api/shares/${reactivationShare.json.id}`, { disabled: false });
    assert.equal(reactivationWithoutView.statusCode, 403);
    assert.equal(reactivationWithoutView.json.code, "FORBIDDEN");
    await addRule("/shared/readable.txt", "view");
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
