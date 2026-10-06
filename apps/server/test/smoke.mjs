import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import AdmZip from "adm-zip";
import { buildApp } from "../dist/app.js";
import { loadEnv } from "../dist/config/env.js";

test("minimum file-manager demo flow", async () => {
  const fixture = await createFixture("kago-smoke-demo.");
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();

    const setup = await admin.post("/api/auth/setup", {
      email: "admin@example.test",
      password: "fake-admin-password-123",
      displayName: "Smoke Admin"
    });
    assert.equal(setup.statusCode, 200);

    const root = await admin.post("/api/roots", {
      slug: "photos",
      name: "Photos",
      basePath: "/data/photos",
      readonly: false
    });
    assert.equal(root.statusCode, 200);

    const emptyWorkspace = await admin.get("/api/workspace");
    assert.deepEqual(emptyWorkspace.json.windows, []);

    const workspace = {
      activeWindowId: "win_photos",
      windows: [{
        id: "win_photos",
        rootSlug: "photos",
        logicalPath: "/2026",
        title: "2026",
        x: 320,
        y: 120,
        width: 820,
        height: 520,
        zIndex: 120,
        minimized: false,
        maximized: false,
        focused: true,
        viewMode: "list",
        sortBy: "name",
        sortDirection: "asc",
        selectedItems: []
      }],
      sidebar: { collapsed: false },
      inspector: { open: false, width: 320 },
      shelf: { collapsed: false, x: 320, y: 720 }
    };
    assert.equal((await admin.put("/api/workspace", workspace)).statusCode, 200);
    assert.equal((await admin.get("/api/workspace")).json.windows[0].logicalPath, "/2026");

    assert.equal((await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/public", name: "new-folder" })).statusCode, 200);
    const upload = await admin.multipart("/api/fs/upload", {
      rootSlug: "photos",
      path: "/public",
      filename: "uploaded.txt",
      content: "uploaded"
    });
    assert.equal(upload.statusCode, 200);
    const thumbnail = await admin.get("/api/fs/thumbnail?rootSlug=photos&path=/public/uploaded.txt");
    assert.equal(thumbnail.statusCode, 200);
    assert.match(String(thumbnail.headers["content-type"]), /image\/svg\+xml/);

    const tag = await admin.post("/api/tags", { name: "Reviewed", color: "lavender" });
    assert.equal(tag.statusCode, 200);
    const setTags = await admin.put("/api/tags/file", {
      rootSlug: "photos",
      path: "/public/uploaded.txt",
      tagIds: [tag.json.id]
    });
    assert.equal(setTags.statusCode, 200);
    const fileTags = await admin.get("/api/tags/file?rootSlug=photos&path=/public/uploaded.txt");
    assert.deepEqual(fileTags.json.map((item) => item.id), [tag.json.id]);

    const reader = await admin.post("/api/users", {
      email: "reader@example.test",
      password: "fake-reader-password-123",
      displayName: "Reader",
      role: "USER"
    });
    const group = await admin.post("/api/groups", { name: "public-readers" });
    assert.equal((await admin.post(`/api/groups/${group.json.id}/members`, { userId: reader.json.id })).statusCode, 200);
    assert.equal((await admin.post("/api/permissions", {
      principalType: "group",
      principalId: group.json.id,
      rootId: root.json.id,
      pathPrefix: "/public",
      allow: ["list", "read", "download"],
      deny: [],
      recursive: true
    })).statusCode, 200);

    const copyTask = await admin.post("/api/tasks", {
      type: "copy",
      sources: [{ rootSlug: "photos", path: "/2026/demo.txt" }],
      destination: { rootSlug: "photos", path: "/public" }
    });
    assert.equal((await waitTask(admin, copyTask.json.id)).status, "done");

    const compressTask = await admin.post("/api/tasks", {
      type: "compress",
      sources: [{ rootSlug: "photos", path: "/public/readme.txt" }],
      destination: { rootSlug: "photos", path: "/2026/readme-bundle.zip" }
    });
    assert.equal((await waitTask(admin, compressTask.json.id)).status, "done");
    assert.equal((await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/2026", name: "extracted" })).statusCode, 200);
    const extractTask = await admin.post("/api/tasks", {
      type: "extract",
      sources: [{ rootSlug: "photos", path: "/2026/readme-bundle.zip" }],
      destination: { rootSlug: "photos", path: "/2026/extracted" }
    });
    assert.equal((await waitTask(admin, extractTask.json.id)).status, "done");
    assert.equal((await admin.get("/api/fs/download?rootSlug=photos&path=/2026/extracted/readme.txt")).payload, "public");

    const thumbnailTask = await admin.post("/api/tasks", {
      type: "thumbnail",
      sources: [{ rootSlug: "photos", path: "/public/uploaded.txt" }]
    });
    assert.equal((await waitTask(admin, thumbnailTask.json.id)).status, "done");

    const trashTask = await admin.post("/api/tasks", {
      type: "delete_to_trash",
      sources: [{ rootSlug: "photos", path: "/public/uploaded.txt" }]
    });
    assert.equal((await waitTask(admin, trashTask.json.id)).status, "done");
    assert.equal((await admin.get("/api/fs/download?rootSlug=photos&path=/public/uploaded.txt")).statusCode, 404);
    const trash = await admin.get("/api/trash");
    const trashedUpload = trash.json.find((item) => item.original_path === "/public/uploaded.txt");
    assert.ok(trashedUpload);
    const restoreTask = await admin.post(`/api/trash/${trashedUpload.id}/restore`);
    assert.equal((await waitTask(admin, restoreTask.json.id)).status, "done");
    assert.equal((await admin.get("/api/fs/download?rootSlug=photos&path=/public/uploaded.txt")).payload, "uploaded");

    const shelf = await admin.post("/api/shelves", { name: "Smoke shelf" });
    assert.equal((await admin.post(`/api/shelves/${shelf.json.id}/items`, { rootSlug: "photos", path: "/public/readme.txt" })).statusCode, 200);
    const shelfTask = await admin.post(`/api/shelves/${shelf.json.id}/tasks`, {
      type: "copy",
      destination: { rootSlug: "photos", path: "/2026" }
    });
    assert.equal((await waitTask(admin, shelfTask.json.id)).status, "done");

    const download = await admin.get("/api/fs/download?rootSlug=photos&path=/public/readme.txt", { accept: "text/plain" });
    assert.equal(download.payload, "public");

    const share = await admin.post("/api/shares", {
      rootSlug: "photos",
      path: "/public/readme.txt",
      mode: "download"
    });
    const sharedDownload = await app.inject({ method: "GET", url: `/s/${share.json.token}/download` });
    assert.equal(sharedDownload.statusCode, 200);
    assert.equal(sharedDownload.payload, "public");

    const uploadShare = await admin.post("/api/shares", {
      rootSlug: "photos",
      path: "/public",
      mode: "upload_only"
    });
    const publicShareClient = client(app);
    assert.equal((await publicShareClient.multipart(`/s/${uploadShare.json.token}/upload`, {
      rootSlug: "photos",
      path: "/public",
      filename: "share-upload.txt",
      content: "shared upload"
    })).statusCode, 200);
    assert.equal((await admin.get("/api/fs/download?rootSlug=photos&path=/public/share-upload.txt")).payload, "shared upload");

    const scopedUser = client(app);
    assert.equal((await scopedUser.post("/api/auth/login", {
      email: "reader@example.test",
      password: "fake-reader-password-123"
    })).statusCode, 200);
    const publicList = await scopedUser.get("/api/fs/list?rootSlug=photos&path=/public");
    assert.equal(publicList.statusCode, 200);
    assert.ok(publicList.json.items.some((item) => item.name === "readme.txt"));
    assert.equal((await scopedUser.get("/api/fs/list?rootSlug=photos&path=/private")).statusCode, 403);

    const audit = await admin.get("/api/audit");
    const actions = new Set(audit.json.map((entry) => entry.action));
    for (const action of [
      "login_success",
      "download",
      "download_via_share",
      "upload_via_share",
      "create_task",
      "task_start",
      "delete_to_trash",
      "restore_trash",
      "compress",
      "extract",
      "tag_create",
      "tag_update",
      "thumbnail",
      "permission_denied"
    ]) {
      assert.ok(actions.has(action), `audit should include ${action}`);
    }
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("security boundaries reject unsafe requests", async () => {
  const fixture = await createFixture("kago-smoke-security.");
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();

    const missingCsrf = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ email: "admin@example.test", password: "fake-admin-password-123" })
    });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(JSON.parse(missingCsrf.payload).code, "CSRF_REQUIRED");

    assert.equal((await admin.post("/api/auth/setup", {
      email: "admin@example.test",
      password: "fake-admin-password-123",
      displayName: "Smoke Admin"
    })).statusCode, 200);
    const root = await admin.post("/api/roots", {
      slug: "photos",
      name: "Photos",
      basePath: "/data/photos",
      readonly: false
    });
    assert.equal(root.statusCode, 200);

    const traversal = await admin.get(`/api/fs/list?rootSlug=photos&path=${encodeURIComponent("/../private")}`);
    assert.equal(traversal.statusCode, 400);
    assert.equal(traversal.json.code, "INVALID_PATH");

    const physicalPath = await admin.get(`/api/fs/list?rootSlug=photos&path=${encodeURIComponent("/data/photos")}`);
    assert.equal(physicalPath.statusCode, 400);
    assert.equal(physicalPath.json.code, "PHYSICAL_PATH_REJECTED");

    await symlink(
      path.join(fixture.dataDir, "photos", "private", "secret.txt"),
      path.join(fixture.dataDir, "photos", "public", "secret-link.txt")
    );
    const symlinkDownload = await admin.get(`/api/fs/download?rootSlug=photos&path=${encodeURIComponent("/public/secret-link.txt")}`);
    assert.equal(symlinkDownload.statusCode, 403);
    assert.equal(symlinkDownload.json.code, "SYMLINK_FORBIDDEN");

    const invalidUpload = await admin.multipart("/api/fs/upload", {
      rootSlug: "photos",
      path: "/public",
      filename: "bad..txt",
      content: "bad"
    });
    assert.equal(invalidUpload.statusCode, 400);
    assert.equal(invalidUpload.json.code, "INVALID_FILENAME");

    const zip = new AdmZip();
    const evilZipPath = path.join(fixture.dataDir, "photos", "public", "evil.zip");
    zip.addFile("aa/escape.txt", Buffer.from("owned"));
    zip.writeZip(evilZipPath);
    await replaceAsciiInFile(evilZipPath, "aa/escape.txt", "../escape.txt");
    assert.equal((await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/public", name: "zip-out" })).statusCode, 200);
    const extractTask = await admin.post("/api/tasks", {
      type: "extract",
      sources: [{ rootSlug: "photos", path: "/public/evil.zip" }],
      destination: { rootSlug: "photos", path: "/public/zip-out" }
    });
    const extractResult = await waitTask(admin, extractTask.json.id);
    assert.equal(extractResult.status, "failed");
    assert.equal(extractResult.error_message, "Unsafe zip entry");
    assert.equal(await pathExists(path.join(fixture.dataDir, "photos", "escape.txt")), false);

    const uploadShare = await admin.post("/api/shares", {
      rootSlug: "photos",
      path: "/public",
      mode: "upload_only"
    });
    const uploadOnlyDownload = await app.inject({ method: "GET", url: `/s/${uploadShare.json.token}/download` });
    assert.equal(uploadOnlyDownload.statusCode, 403);
    assert.equal(JSON.parse(uploadOnlyDownload.payload).code, "SHARE_DOWNLOAD_FORBIDDEN");

    const limitedShare = await admin.post("/api/shares", {
      rootSlug: "photos",
      path: "/public/readme.txt",
      mode: "download",
      maxDownloads: 1
    });
    assert.equal((await app.inject({ method: "GET", url: `/s/${limitedShare.json.token}/download` })).statusCode, 200);
    const limitedAgain = await app.inject({ method: "GET", url: `/s/${limitedShare.json.token}/download` });
    assert.equal(limitedAgain.statusCode, 410);
    assert.equal(JSON.parse(limitedAgain.payload).code, "SHARE_LIMIT_REACHED");

    const disabledShare = await admin.post("/api/shares", {
      rootSlug: "photos",
      path: "/public/readme.txt",
      mode: "download"
    });
    assert.equal((await admin.patch(`/api/shares/${disabledShare.json.id}`, { disabled: true })).statusCode, 200);
    const disabledDownload = await app.inject({ method: "GET", url: `/s/${disabledShare.json.token}/download` });
    assert.equal(disabledDownload.statusCode, 404);
    assert.equal(JSON.parse(disabledDownload.payload).code, "SHARE_NOT_FOUND");

    const audit = await admin.get("/api/audit");
    const actions = new Set(audit.json.map((entry) => entry.action));
    for (const action of ["request_denied", "request_failed", "task_failed", "disable_share"]) {
      assert.ok(actions.has(action), `audit should include ${action}`);
    }
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("production startup creates a persisted session secret and rejects recursive copy targets", async () => {
  const fixture = await createFixture("kago-smoke-prod.");
  const previousEnv = snapshotEnv(["NODE_ENV", "DATA_DIR", "APP_DATA_DIR", "PORT", "SESSION_SECRET", "WEB_DIST_DIR"]);

  try {
    process.env.NODE_ENV = "production";
    process.env.DATA_DIR = fixture.dataDir;
    process.env.APP_DATA_DIR = fixture.appDataDir;
    process.env.PORT = "0";
    delete process.env.SESSION_SECRET;
    delete process.env.WEB_DIST_DIR;

    const env = loadEnv();
    assert.equal(env.nodeEnv, "production");
    assert.ok(env.sessionSecret.length >= 32);
    assert.equal((await readFile(path.join(fixture.appDataDir, "session.secret"), "utf8")).trim(), env.sessionSecret);

    const app = await buildApp(env);
    const admin = client(app);
    try {
      await app.ready();
      assert.equal((await admin.post("/api/auth/setup", {
        email: "admin@example.test",
        password: "fake-admin-password-123",
        displayName: "Smoke Admin"
      })).statusCode, 200);
      assert.equal((await admin.post("/api/roots", {
        slug: "photos",
        name: "Photos",
        basePath: "/data/photos",
        readonly: false
      })).statusCode, 200);
      const rejected = await admin.post("/api/tasks", {
        type: "copy",
        sources: [{ rootSlug: "photos", path: "/src" }],
        destination: { rootSlug: "photos", path: "/src/child" }
      });
      assert.equal(rejected.statusCode, 409);
      assert.equal(rejected.json.code, "TARGET_INSIDE_SOURCE");
    } finally {
      await app.close();
    }
  } finally {
    restoreEnv(previousEnv);
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

function testEnv(fixture) {
  return {
    port: 0,
    dataDir: fixture.dataDir,
    appDataDir: fixture.appDataDir,
    sessionSecret: "smoke-test-session-secret",
    nodeEnv: "test"
  };
}

async function createFixture(prefix) {
  const baseDir = await mkdtemp(path.join(tmpdir(), prefix));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  await mkdir(path.join(dataDir, "photos", "public"), { recursive: true });
  await mkdir(path.join(dataDir, "photos", "private"), { recursive: true });
  await mkdir(path.join(dataDir, "photos", "2026"), { recursive: true });
  await mkdir(path.join(dataDir, "photos", "src", "child"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(dataDir, "photos", "public", "readme.txt"), "public");
  await writeFile(path.join(dataDir, "photos", "private", "secret.txt"), "private");
  await writeFile(path.join(dataDir, "photos", "2026", "demo.txt"), "demo");
  await writeFile(path.join(dataDir, "photos", "src", "file.txt"), "demo");
  return { baseDir, dataDir, appDataDir };
}

function client(app) {
  let cookie = "";

  async function request(method, url, body, options = {}) {
    const headers = {
      accept: options.accept ?? "application/json",
      ...(cookie ? { cookie } : {}),
      ...options.headers
    };
    let payload;
    if (body !== undefined) {
      payload = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      headers["content-type"] = options.contentType ?? "application/json";
    }
    if (method !== "GET") headers["x-kago-csrf"] = "1";
    const response = await app.inject({ method, url, headers, payload });
    captureCookies(response.headers["set-cookie"]);
    return responseOf(response);
  }

  return {
    get: (url, options) => request("GET", url, undefined, options),
    post: (url, body, options) => request("POST", url, body, options),
    patch: (url, body, options) => request("PATCH", url, body, options),
    put: (url, body, options) => request("PUT", url, body, options),
    delete: (url, options) => request("DELETE", url, undefined, options),
    multipart: (url, fields) => {
      const boundary = `kago-smoke-${Date.now()}`;
      const payload = multipartPayload(boundary, fields);
      return request("POST", url, payload, { contentType: `multipart/form-data; boundary=${boundary}` });
    }
  };

  function captureCookies(values) {
    const setCookies = Array.isArray(values) ? values : values ? [values] : [];
    for (const value of setCookies) {
      const pair = value.split(";", 1)[0];
      if (!pair) continue;
      const [name] = pair.split("=");
      cookie = cookie.split("; ").filter((item) => item && !item.startsWith(`${name}=`)).concat(pair).join("; ");
    }
  }
}

function responseOf(response) {
  const contentType = String(response.headers["content-type"] ?? "");
  return {
    statusCode: response.statusCode,
    headers: response.headers,
    payload: response.payload,
    json: contentType.includes("application/json") && response.payload ? JSON.parse(response.payload) : null
  };
}

function multipartPayload(boundary, fields) {
  const chunks = [];
  for (const [name, value] of Object.entries({ rootSlug: fields.rootSlug, path: fields.path })) {
    chunks.push(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  }
  chunks.push(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${fields.filename}"\r\n` +
    "Content-Type: text/plain\r\n\r\n" +
    `${fields.content}\r\n`
  );
  chunks.push(`--${boundary}--\r\n`);
  return Buffer.from(chunks.join(""), "utf8");
}

async function waitTask(api, taskId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const task = await api.get(`/api/tasks/${taskId}`);
    if (["done", "failed", "cancelled", "interrupted"].includes(task.json.status)) return task.json;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Task ${taskId} did not finish`);
}

function snapshotEnv(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function pathExists(targetPath) {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function replaceAsciiInFile(targetPath, from, to) {
  assert.equal(Buffer.byteLength(from), Buffer.byteLength(to));
  const fromBytes = Buffer.from(from, "ascii");
  const toBytes = Buffer.from(to, "ascii");
  const data = await readFile(targetPath);
  let offset = data.indexOf(fromBytes);
  let replacements = 0;
  while (offset !== -1) {
    toBytes.copy(data, offset);
    replacements += 1;
    offset = data.indexOf(fromBytes, offset + toBytes.length);
  }
  assert.equal(replacements, 2);
  await writeFile(targetPath, data);
}
