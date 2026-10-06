import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, mkdir, readdir, readFile, rm, symlink, truncate, writeFile } from "node:fs/promises";
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

    // Folders directly under the data dir are mounted as roots by default.
    const roots = await admin.get("/api/roots");
    assert.deepEqual(roots.json.map((item) => item.slug), ["photos"]);
    const root = { json: roots.json[0] };

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
    assert.deepEqual((await admin.get("/api/groups")).json.map((item) => ({ name: item.name, members: item.members })), [
      { name: "public-readers", members: [{ id: reader.json.id, email: "reader@example.test", display_name: "Reader" }] }
    ]);
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

    assert.equal((await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/public", name: "to-empty" })).statusCode, 200);
    const emptyTask = await admin.post("/api/tasks", {
      type: "delete_to_trash",
      sources: [{ rootSlug: "photos", path: "/public/to-empty" }]
    });
    assert.equal((await waitTask(admin, emptyTask.json.id)).status, "done");
    assert.equal((await readdir(path.join(fixture.appDataDir, "trash"))).length, 1);
    assert.deepEqual((await admin.delete("/api/trash")).json, { deleted: 1 });
    assert.deepEqual((await admin.get("/api/trash")).json, []);
    assert.deepEqual(await readdir(path.join(fixture.appDataDir, "trash")), []);
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

    // Range requests let browsers seek media instead of refetching the whole file.
    const previewPath = "/api/fs/preview?rootSlug=photos&path=/public/readme.txt";
    const whole = await admin.get(previewPath);
    assert.equal(whole.statusCode, 200);
    assert.equal(whole.headers["accept-ranges"], "bytes");
    const partial = await admin.get(previewPath, { headers: { range: "bytes=1-3" } });
    assert.equal(partial.statusCode, 206);
    assert.equal(partial.payload, "ubl");
    assert.equal(partial.headers["content-range"], "bytes 1-3/6");
    assert.equal(partial.headers["content-length"], "3");
    assert.equal((await admin.get(previewPath, { headers: { range: "bytes=4-" } })).payload, "ic");
    assert.equal((await admin.get(previewPath, { headers: { range: "bytes=-2" } })).payload, "ic");
    assert.equal((await admin.get(previewPath, { headers: { range: "bytes=2-999" } })).headers["content-range"], "bytes 2-5/6");
    const unsatisfiable = await admin.get(previewPath, { headers: { range: "bytes=6-" } });
    assert.equal(unsatisfiable.statusCode, 416);
    assert.equal(unsatisfiable.headers["content-range"], "bytes */6");
    assert.equal((await admin.get(previewPath, { headers: { range: "bytes=0-1,3-4" } })).statusCode, 200);
    assert.equal((await admin.get(previewPath, { headers: { range: "bytes=1-3", "if-range": '"stale"' } })).statusCode, 200);
    assert.equal((await admin.get(previewPath, { headers: { range: "bytes=1-3", "if-range": whole.headers["last-modified"] } })).statusCode, 206);

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
    // Folders directly under the data dir are mounted as roots by default.
    const roots = await admin.get("/api/roots");
    assert.deepEqual(roots.json.map((item) => item.slug), ["photos"]);
    const root = { json: roots.json[0] };

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
      // Roots cannot be added by hand; new folders under the data dir show up on their own.
      assert.equal((await admin.post("/api/roots", { slug: "manual", name: "Manual" })).statusCode, 404);
      await mkdir(path.join(fixture.dataDir, "相片"));
      await mkdir(path.join(fixture.dataDir, ".hidden"));
      const mounted = (await admin.get("/api/roots")).json;
      assert.deepEqual(mounted.map((item) => item.name).sort(), ["photos", "相片"]);
      assert.match(mounted.find((item) => item.name === "相片").slug, /^folder-[0-9a-f]{8}$/);
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

test("download archives stay out of the data dir and running tasks can be cancelled", async () => {
  const fixture = await createFixture("kago-smoke-tasks.");
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Smoke Admin" })).statusCode, 200);

    await writeFile(path.join(fixture.dataDir, "photos", "public", "相片.txt"), "unicode");
    const before = await readdir(path.join(fixture.dataDir, "photos", "public"));
    const zipTask = await admin.post("/api/tasks", {
      type: "download_zip",
      sources: [{ rootSlug: "photos", path: "/public/readme.txt" }, { rootSlug: "photos", path: "/public/相片.txt" }]
    });
    assert.equal(zipTask.statusCode, 200);
    assert.equal((await waitTask(admin, zipTask.json.id)).status, "done");
    assert.deepEqual(await readdir(path.join(fixture.dataDir, "photos", "public")), before);
    const archive = await admin.get(`/api/tasks/${zipTask.json.id}/download`);
    assert.equal(archive.statusCode, 200);
    assert.match(String(archive.headers["content-disposition"]), /^attachment; filename="Kago-[\d-]+\.zip"/);
    assert.deepEqual(new AdmZip(archive.raw).getEntries().map((entry) => entry.entryName).sort(), ["readme.txt", "相片.txt"].sort());

    const folderTask = await admin.post("/api/tasks", { type: "download_zip", sources: [{ rootSlug: "photos", path: "/public" }] });
    assert.equal((await waitTask(admin, folderTask.json.id)).status, "done");
    const folderArchive = await admin.get(`/api/tasks/${folderTask.json.id}/download`);
    assert.match(String(folderArchive.headers["content-disposition"]), /filename="public\.zip"/);

    // A plain compress task is not downloadable through the task endpoint.
    const copyTask = await admin.post("/api/tasks", {
      type: "copy",
      sources: [{ rootSlug: "photos", path: "/2026/demo.txt" }],
      destination: { rootSlug: "photos", path: "/public" }
    });
    assert.equal((await waitTask(admin, copyTask.json.id)).status, "done");
    assert.equal((await admin.get(`/api/tasks/${copyTask.json.id}/download`)).statusCode, 409);

    const unicodeDownload = await admin.get(`/api/fs/download?rootSlug=photos&path=${encodeURIComponent("/public/相片.txt")}`);
    assert.equal(unicodeDownload.statusCode, 200);
    assert.equal(unicodeDownload.payload, "unicode");

    const member = await admin.post("/api/users", { email: "member@example.test", password: "fake-member-password-1", displayName: "Member", role: "USER" });
    const firstSession = client(app);
    const secondSession = client(app);
    for (const session of [firstSession, secondSession]) {
      assert.equal((await session.post("/api/auth/login", { email: "member@example.test", password: "fake-member-password-1" })).statusCode, 200);
    }
    assert.deepEqual((await firstSession.get("/api/admins")).json, [{ displayName: "Smoke Admin", email: "admin@example.test" }]);
    assert.equal((await client(app).get("/api/admins")).statusCode, 401);
    assert.equal((await firstSession.post("/api/auth/password", { currentPassword: "not-the-password", newPassword: "fake-member-password-2" })).statusCode, 403);
    assert.equal((await firstSession.post("/api/auth/password", { currentPassword: "fake-member-password-1", newPassword: "short" })).statusCode, 400);
    assert.equal((await firstSession.post("/api/auth/password", { currentPassword: "fake-member-password-1", newPassword: "fake-member-password-2" })).statusCode, 200);
    // The session that changed the password stays signed in; every other one is dropped.
    assert.ok((await firstSession.get("/api/auth/me")).json.user);
    assert.equal((await secondSession.get("/api/auth/me")).json.user, null);
    assert.equal((await client(app).post("/api/auth/login", { email: "member@example.test", password: "fake-member-password-1" })).statusCode, 401);
    assert.equal((await firstSession.post(`/api/users/${member.json.id}/password`, { password: "fake-member-password-3" })).statusCode, 403);
    assert.equal((await admin.post(`/api/users/${member.json.id}/password`, { password: "fake-member-password-3" })).statusCode, 200);
    assert.equal((await firstSession.get("/api/auth/me")).json.user, null);
    assert.equal((await client(app).post("/api/auth/login", { email: "member@example.test", password: "fake-member-password-3" })).statusCode, 200);

    // Sparse on most filesystems, but the copy still has to stream every byte.
    await truncate(path.join(fixture.dataDir, "photos", "src", "file.txt"), 1024 * 1024 * 1024);
    const bigCopy = await admin.post("/api/tasks", {
      type: "copy",
      sources: [{ rootSlug: "photos", path: "/src/file.txt" }],
      destination: { rootSlug: "photos", path: "/private" }
    });
    let running = null;
    for (let attempt = 0; attempt < 200 && !running; attempt += 1) {
      const task = (await admin.get(`/api/tasks/${bigCopy.json.id}`)).json;
      if (task.status === "running" && task.processed_bytes > 0) running = task;
      else {
        assert.ok(["queued", "running"].includes(task.status), `copy finished before it could be cancelled: ${task.status}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    assert.ok(running, "copy never reported progress");
    const cancelled = await admin.post(`/api/tasks/${bigCopy.json.id}/cancel`);
    assert.equal(cancelled.statusCode, 200);
    assert.equal(cancelled.json.status, "cancelled");
    const partial = path.join(fixture.dataDir, "photos", "private", "file.txt");
    for (let attempt = 0; attempt < 100 && (await pathExists(partial)); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await pathExists(partial), false);
    assert.equal(await pathExists(path.join(fixture.dataDir, "photos", "src", "file.txt")), true);
    assert.equal((await admin.get(`/api/tasks/${bigCopy.json.id}`)).json.status, "cancelled");

    // The worker moves on to the next task after a cancellation.
    const afterCancel = await admin.post("/api/tasks", {
      type: "copy",
      sources: [{ rootSlug: "photos", path: "/public/readme.txt" }],
      destination: { rootSlug: "photos", path: "/2026" }
    });
    assert.equal((await waitTask(admin, afterCancel.json.id)).status, "done");
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("filenames are written in NFC while existing names keep their on-disk form", async () => {
  const fixture = await createFixture("kago-smoke-nfc.");
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);
  const publicDir = path.join(fixture.dataDir, "photos", "public");
  const nfd = (value) => value.normalize("NFD");
  const names = async () => readdir(publicDir);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Smoke Admin" })).statusCode, 200);

    // New names arrive decomposed (as macOS sends them) and land composed.
    const folder = await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/public", name: nfd("ガイド") });
    assert.equal(folder.statusCode, 200);
    assert.equal(folder.json.path, "/public/ガイド");
    const upload = await admin.multipart("/api/fs/upload", { rootSlug: "photos", path: "/public", filename: nfd("café.txt"), content: "nfc" });
    assert.equal(upload.statusCode, 200);
    assert.ok((await names()).includes("ガイド"));
    assert.ok((await names()).includes("café.txt"));

    // A file that already exists as NFD is not renamed by reading it: display is NFC, the path stays as stored.
    const stored = nfd("が.txt");
    await writeFile(path.join(publicDir, stored), "legacy");
    const listed = (await admin.get("/api/fs/list?rootSlug=photos&path=/public")).json.items.find((item) => item.name === "が.txt");
    assert.equal(listed.path, `/public/${stored}`);
    assert.ok((await names()).includes(stored));

    // Either spelling reaches it, and the answer names the stored one.
    const typed = await admin.get(`/api/fs/meta?${new URLSearchParams({ rootSlug: "photos", path: "/public/が.txt" })}`);
    assert.equal(typed.statusCode, 200);
    assert.equal(typed.json.name, "が.txt");

    // Creating its NFC twin is a collision, not a second file.
    assert.equal((await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/public", name: "が.txt" })).statusCode, 409);
    assert.equal((await admin.multipart("/api/fs/upload", { rootSlug: "photos", path: "/public", filename: "が.txt", content: "twin" })).statusCode, 409);

    // Renaming it to its own display name normalises it in place.
    const renamed = await admin.post("/api/fs/rename", { rootSlug: "photos", path: listed.path, name: "が.txt" });
    assert.equal(renamed.statusCode, 200);
    assert.equal(renamed.json.path, "/public/が.txt");
    assert.deepEqual((await names()).filter((name) => name.normalize("NFC") === "が.txt"), ["が.txt"]);
    assert.equal((await readFile(path.join(publicDir, "が.txt"), "utf8")), "legacy");

    // Extracting merges into a folder stored as NFD instead of creating its NFC twin, and refuses to shadow a file in it.
    const storedDir = nfd("プロジェクト");
    await mkdir(path.join(publicDir, storedDir));
    const zip = new AdmZip();
    zip.addFile(`${nfd("プロジェクト")}/${nfd("メモ.txt")}`, Buffer.from("memo"));
    zip.writeZip(path.join(publicDir, "nfd.zip"));
    const extract = () => admin.post("/api/tasks", { type: "extract", sources: [{ rootSlug: "photos", path: "/public/nfd.zip" }], destination: { rootSlug: "photos", path: "/public" } });
    assert.equal((await waitTask(admin, (await extract()).json.id)).status, "done");
    assert.deepEqual((await names()).filter((name) => name.normalize("NFC") === "プロジェクト"), [storedDir]);
    assert.deepEqual(await readdir(path.join(publicDir, storedDir)), ["メモ.txt"]);
    const again = await waitTask(admin, (await extract()).json.id);
    assert.equal(again.status, "failed");
    assert.equal(again.error_message, "Target already exists");

    // Renaming onto another entry is still refused.
    assert.equal((await admin.post("/api/fs/rename", { rootSlug: "photos", path: "/public/が.txt", name: nfd("café.txt") })).statusCode, 409);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("videos are probed and transcoded to HLS on demand", { skip: spawnSync("ffmpeg", ["-version"]).status !== 0 && "ffmpeg is not installed" }, async () => {
  const fixture = await createFixture("kago-smoke-media.");
  const clip = path.join(fixture.dataDir, "photos", "public", "clip.avi");
  const encoded = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x480:rate=24", "-f", "lavfi", "-i", "sine", "-t", "14", "-c:v", "mpeg4", "-c:a", "mp3", clip]);
  assert.equal(encoded.status, 0, String(encoded.stderr));
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Smoke Admin" });

    const info = await admin.get("/api/media/info?rootSlug=photos&path=/public/clip.avi");
    assert.equal(info.statusCode, 200);
    assert.equal(info.json.transcode, true);
    assert.equal(info.json.video.codec, "mpeg4");
    assert.match(info.json.encoder, /^(software|nvenc|vaapi|vaapi-cqp|videotoolbox)$/);
    assert.deepEqual(info.json.qualities, [480, 360]);
    assert.equal((await admin.get("/api/media/info?rootSlug=photos&path=/public/readme.txt")).statusCode, 422);

    // Subtitles are matched to the video by name; the rest of the name gives the language and flags.
    const publicDir = path.join(fixture.dataDir, "photos", "public");
    for (const name of ["clip.ass", "clip.zh.ass", "clip.en.srt", "clip.Commentary.en.sdh.srt", "clip.cht.default.ssa", "clip.final.srt", "clip2.en.srt", "clip.en.txt"]) await writeFile(path.join(publicDir, name), "");
    const subtitles = await admin.get("/api/media/subtitles?rootSlug=photos&path=/public/clip.avi");
    assert.equal(subtitles.statusCode, 200);
    assert.deepEqual(
      subtitles.json.tracks.map((item) => [item.id, item.format, item.language, item.title, item.default, item.sdh]),
      [
        ["file:/public/clip.cht.default.ssa", "ass", "zh-Hant", "", true, false],
        ["file:/public/clip.ass", "ass", "", "", false, false],
        ["file:/public/clip.Commentary.en.sdh.srt", "srt", "en", "Commentary", false, true],
        ["file:/public/clip.en.srt", "srt", "en", "", false, false],
        ["file:/public/clip.final.srt", "srt", "", "final", false, false],
        ["file:/public/clip.zh.ass", "ass", "zh", "", false, false]
      ]
    );
    assert.equal((await admin.get(subtitles.json.tracks[0].url)).statusCode, 200);

    // Subtitles and fonts inside the container are listed too, and read out on request.
    await writeFile(path.join(publicDir, "inner.srt"), "1\n00:00:01,000 --> 00:00:02,000\n內嵌字幕\n");
    await writeFile(path.join(publicDir, "inner.ttf"), "not really a font");
    const muxed = spawnSync("ffmpeg", [
      "-loglevel", "error", "-i", clip, "-i", path.join(publicDir, "inner.srt"), "-map", "0", "-map", "1", "-c", "copy", "-c:s", "ass",
      "-metadata:s:s:0", "language=chi", "-metadata:s:s:0", "title=繁體中文", "-attach", path.join(publicDir, "inner.ttf"), "-metadata:s:t:0", "mimetype=font/ttf",
      path.join(publicDir, "muxed.mkv")
    ]);
    assert.equal(muxed.status, 0, String(muxed.stderr));
    const inner = await admin.get("/api/media/subtitles?rootSlug=photos&path=/public/muxed.mkv");
    assert.deepEqual(inner.json.tracks.map((item) => [item.id, item.embedded, item.format, item.language, item.title]), [["stream:0", true, "ass", "zh-Hant", "繁體中文"]]);
    const innerBody = await admin.get(inner.json.tracks[0].url);
    assert.equal(innerBody.statusCode, 200);
    assert.match(innerBody.payload, /Dialogue: .*內嵌字幕/);
    assert.equal(inner.json.fonts.length, 1);
    assert.equal((await admin.get(inner.json.fonts[0])).payload, "not really a font");
    assert.equal((await admin.get("/api/media/subtitle?rootSlug=photos&path=/public/muxed.mkv&index=3")).statusCode, 404);

    assert.equal((await admin.post("/api/media/sessions", { rootSlug: "photos", path: "/public/clip.avi", height: 1080 })).statusCode, 400);
    const session = await admin.post("/api/media/sessions", { rootSlug: "photos", path: "/public/clip.avi", height: 360 });
    assert.equal(session.statusCode, 200);

    const playlist = await admin.get(session.json.playlistUrl);
    assert.equal(playlist.statusCode, 200);
    assert.deepEqual(playlist.payload.split("\n").filter((line) => line.endsWith(".ts")), ["0.ts", "1.ts", "2.ts"]);

    // Asking for the last segment first is a seek: ffmpeg starts there rather than at the beginning.
    const base = `/api/media/sessions/${session.json.id}`;
    for (const index of [2, 0, 1]) {
      const segment = await admin.get(`${base}/${index}.ts`);
      assert.equal(segment.statusCode, 200);
      assert.equal(segment.raw[0], 0x47, "segments are MPEG-TS");
    }
    assert.equal((await admin.get(`${base}/3.ts`)).statusCode, 404);
    assert.equal((await admin.get(`${base}/../../fs/list`)).statusCode !== 200, true);

    // Sessions belong to whoever opened them.
    await admin.post("/api/users", { email: "viewer@example.test", password: "fake-viewer-password-123", displayName: "Viewer", role: "USER" });
    const viewer = client(app);
    await viewer.post("/api/auth/login", { email: "viewer@example.test", password: "fake-viewer-password-123" });
    assert.equal((await viewer.get(`${base}/index.m3u8`)).statusCode, 404);
    assert.equal((await viewer.post("/api/media/sessions", { rootSlug: "photos", path: "/public/clip.avi", height: 360 })).statusCode, 403);

    assert.equal((await admin.delete(base)).statusCode, 200);
    assert.equal((await admin.get(`${base}/index.m3u8`)).statusCode, 404);
    const transcodeDir = path.join(fixture.appDataDir, "temp", "transcode");
    for (let tries = 0; tries < 40 && (await readdir(transcodeDir)).length > 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await readdir(transcodeDir), []);
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
    raw: response.rawPayload,
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
