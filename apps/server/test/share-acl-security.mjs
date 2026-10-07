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

    const addRule = async (rule) => {
      const response = await admin.post("/api/permissions", {
        principalType: "user",
        principalId: ownerId,
        rootId: root.id,
        recursive: true,
        allow: [],
        deny: [],
        ...rule
      });
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

    await addRule({ pathPrefix: "/shared", allow: ["share", "read", "download", "upload"] });

    const denyRead = await addRule({ pathPrefix: "/shared/secret.txt", deny: ["read"] });
    const downloadWithoutRead = await createShare("/shared/secret.txt", "download");
    assert.equal(downloadWithoutRead.statusCode, 403);
    assert.equal(downloadWithoutRead.json.code, "FORBIDDEN");
    const viewWithoutRead = await createShare("/shared/secret.txt", "view_only");
    assert.equal(viewWithoutRead.statusCode, 403);
    await removeRule(denyRead);

    const denyDownload = await addRule({ pathPrefix: "/shared/secret.txt", deny: ["download"] });
    const downloadWithoutDownload = await createShare("/shared/secret.txt", "download");
    assert.equal(downloadWithoutDownload.statusCode, 403);
    assert.equal(downloadWithoutDownload.json.code, "FORBIDDEN");
    const viewWithReadOnly = await createShare("/shared/secret.txt", "view_only");
    assert.equal(viewWithReadOnly.statusCode, 200);
    assert.equal(JSON.parse(viewWithReadOnly.json.permission_json).mode, "view_only");
    await removeRule(denyDownload);

    const denyUpload = await addRule({ pathPrefix: "/shared", deny: ["upload"] });
    const uploadWithoutUpload = await createShare("/shared", "upload_only");
    assert.equal(uploadWithoutUpload.statusCode, 403);
    assert.equal(uploadWithoutUpload.json.code, "FORBIDDEN");
    await removeRule(denyUpload);

    const denySecretRead = await addRule({ pathPrefix: "/shared/secret.txt", deny: ["read", "download"] });
    const folderDownload = await createShare("/shared", "download");
    assert.equal(folderDownload.statusCode, 400);
    assert.equal(folderDownload.json.code, "SHARE_TARGET_NOT_FILE");

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

    const deniedChildShare = await createShare("/shared/secret.txt", "download");
    assert.equal(deniedChildShare.statusCode, 403);
    assert.equal(deniedChildShare.json.code, "FORBIDDEN");
    await removeRule(denySecretRead);

    const revokedShare = await createShare("/shared/readable.txt", "download");
    assert.equal(revokedShare.statusCode, 200);
    const revokeRead = await addRule({ pathPrefix: "/shared/readable.txt", deny: ["read"] });
    const afterReadRevocation = await app.inject({ method: "GET", url: `/s/${revokedShare.json.token}/download` });
    assert.equal(afterReadRevocation.statusCode, 403);
    assert.equal(afterReadRevocation.json().code, "FORBIDDEN");
    assert.equal((await admin.get("/api/shares")).json.find((item) => item.id === revokedShare.json.id).download_count, 0);
    await removeRule(revokeRead);

    const downloadRevokedShare = await createShare("/shared/readable.txt", "download");
    assert.equal(downloadRevokedShare.statusCode, 200);
    const revokeDownload = await addRule({ pathPrefix: "/shared/readable.txt", deny: ["download"] });
    const afterDownloadRevocation = await app.inject({ method: "GET", url: `/s/${downloadRevokedShare.json.token}/download` });
    assert.equal(afterDownloadRevocation.statusCode, 403);
    assert.equal(afterDownloadRevocation.json().code, "FORBIDDEN");
    assert.equal((await admin.get("/api/shares")).json.find((item) => item.id === downloadRevokedShare.json.id).download_count, 0);
    await removeRule(revokeDownload);

    const reactivationShare = await createShare("/shared/readable.txt", "download");
    assert.equal(reactivationShare.statusCode, 200);
    assert.equal((await owner.patch(`/api/shares/${reactivationShare.json.id}`, { disabled: true })).statusCode, 200);
    const denyReactivation = await addRule({ pathPrefix: "/shared/readable.txt", deny: ["download"] });
    const reactivationWithoutDownload = await owner.patch(`/api/shares/${reactivationShare.json.id}`, { disabled: false });
    assert.equal(reactivationWithoutDownload.statusCode, 403);
    assert.equal(reactivationWithoutDownload.json.code, "FORBIDDEN");
    await removeRule(denyReactivation);
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
