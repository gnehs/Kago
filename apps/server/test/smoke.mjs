import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createCipheriv, createHmac, pbkdf2Sync } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, chmod, mkdtemp, mkdir, readdir, readFile, rm, stat, symlink, truncate, utimes, writeFile } from "node:fs/promises";
import { availableParallelism, loadavg, tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import AdmZip from "adm-zip";
import { buildApp } from "../dist/app.js";
import { loadEnv } from "../dist/config/env.js";
import { MediaService } from "../dist/services/media.service.js";

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
        selectedItems: [],
        sidebarOpen: false,
        tabs: [{ id: "tab_a", rootSlug: "photos", logicalPath: "/2026" }, { id: "tab_b", rootSlug: "photos", logicalPath: "//public" }],
        activeTabId: "tab_a"
      }],
      sidebar: { collapsed: false },
      inspector: { open: false, width: 320 },
      shelf: { collapsed: false, x: 320, y: 720 }
    };
    assert.equal((await admin.put("/api/workspace", workspace)).statusCode, 200);
    assert.equal((await admin.get("/api/workspace")).json.windows[0].logicalPath, "/2026");
    // A window's tabs and its sidebar come back with it, each tab's path tidied like the window's own.
    const savedWindow = (await admin.get("/api/workspace")).json.windows[0];
    assert.deepEqual(savedWindow.tabs.map((tab) => tab.logicalPath), ["/2026", "/public"]);
    assert.equal(savedWindow.activeTabId, "tab_a");
    assert.equal(savedWindow.sidebarOpen, false);

    // Settings follow the account, and a request changes only what it names.
    assert.deepEqual((await admin.get("/api/settings")).json, { settings: {}, folderViews: [] });
    assert.equal((await admin.patch("/api/settings", { motion: "off", defaultView: { viewMode: "grid" } })).statusCode, 200);
    const settings = await admin.patch("/api/settings", { locale: "ja", defaultView: { sortBy: "mtime", sortDirection: "desc" } });
    assert.deepEqual(settings.json.settings, { motion: "off", locale: "ja", defaultView: { viewMode: "grid", sortBy: "mtime", sortDirection: "desc" } });
    assert.equal((await admin.patch("/api/settings", { theme: "sepia" })).statusCode, 400);

    // The tags a person keeps at hand are a list of their own, replaced whole and never two of one name.
    const handy = [{ name: "Work", color: "red", shape: "star" }, { name: "Later", color: null }];
    assert.deepEqual((await admin.patch("/api/settings", { tags: handy })).json.settings.tags, handy);
    assert.equal((await admin.patch("/api/settings", { tags: [...handy, { name: "Work", color: "blue" }] })).statusCode, 400);
    assert.equal((await admin.patch("/api/settings", { tags: [{ name: "Work", color: "pink" }] })).statusCode, 400);
    assert.equal((await admin.patch("/api/settings", { tags: [{ name: "Work", color: "red", shape: "blob" }] })).statusCode, 400);
    assert.equal((await admin.patch("/api/settings", { tags: [] })).statusCode, 200);

    // A folder's view is kept part by part, and goes with the folder when Kago renames or moves it.
    await mkdir(path.join(fixture.dataDir, "photos", "views", "inner"), { recursive: true });
    await mkdir(path.join(fixture.dataDir, "photos", "views-kept"), { recursive: true });
    const folderView = (pathName, view) => admin.put("/api/folder-views", { rootSlug: "photos", path: pathName, view });
    assert.equal((await folderView("/views", { viewMode: "grid", recursive: true })).statusCode, 200);
    assert.equal((await folderView("/views", { sortBy: "size", sortDirection: "desc" })).statusCode, 200);
    assert.equal((await folderView("/views/inner", { autoMode: "grid" })).statusCode, 200);
    assert.equal((await folderView("/views-kept", { viewMode: "columns" })).statusCode, 200);
    assert.equal((await folderView("/views", { viewMode: "gallery" })).statusCode, 400);
    assert.equal((await folderView("/../etc", { viewMode: "grid" })).statusCode, 400);
    assert.equal((await admin.post("/api/fs/rename", { rootSlug: "photos", path: "/views", name: "views-renamed" })).statusCode, 200);
    const moveViews = await admin.post("/api/tasks", { type: "move", sources: [{ rootSlug: "photos", path: "/views-renamed" }], destination: { rootSlug: "photos", path: "/views-kept" } });
    assert.equal((await waitTask(admin, moveViews.json.id)).status, "done");
    const byPath = (list) => Object.fromEntries(list.map(({ rootSlug, path: pathName, ...view }) => [pathName, view]));
    assert.deepEqual(byPath((await admin.get("/api/settings")).json.folderViews), {
      "/views-kept": { viewMode: "columns", recursive: false },
      "/views-kept/views-renamed": { viewMode: "grid", sortBy: "size", sortDirection: "desc", recursive: true },
      "/views-kept/views-renamed/inner": { autoMode: "grid", recursive: false }
    });
    const afterReset = await admin.delete(`/api/folder-views?rootSlug=photos&path=${encodeURIComponent("/views-kept/views-renamed")}`);
    assert.deepEqual(Object.keys(byPath(afterReset.json.folderViews)).sort(), ["/views-kept", "/views-kept/views-renamed/inner"]);
    await rm(path.join(fixture.dataDir, "photos", "views-kept"), { recursive: true });

    // A folder is counted by the files in it, whether they are copied one by one or it is renamed into place in one go.
    await mkdir(path.join(fixture.dataDir, "photos", "counted", "inner", "empty"), { recursive: true });
    await mkdir(path.join(fixture.dataDir, "photos", "counted-to", "hollow"), { recursive: true });
    for (const name of ["a.txt", "b.txt", "inner/c.txt"]) await writeFile(path.join(fixture.dataDir, "photos", "counted", name), name);
    const counted = async (type, source, destination) => {
      const task = await admin.post("/api/tasks", { type, sources: [{ rootSlug: "photos", path: source }], destination: { rootSlug: "photos", path: destination } });
      const { status, total_files, processed_files } = await waitTask(admin, task.json.id);
      return { status, total_files, processed_files };
    };
    assert.deepEqual(await counted("copy", "/counted", "/counted-to"), { status: "done", total_files: 3, processed_files: 3 });
    assert.deepEqual(await counted("move", "/counted-to/counted", "/counted-to/hollow"), { status: "done", total_files: 3, processed_files: 3 });
    // One with no file in it is still one thing to carry.
    assert.deepEqual(await counted("copy", "/counted/inner/empty", "/counted-to"), { status: "done", total_files: 1, processed_files: 1 });
    await rm(path.join(fixture.dataDir, "photos", "counted"), { recursive: true });
    await rm(path.join(fixture.dataDir, "photos", "counted-to"), { recursive: true });

    // A name the destination already has stops a copy or move, unless the task says what to do with it.
    const clashDir = path.join(fixture.dataDir, "photos", "clash");
    const lay = async (files) => {
      for (const [name, text] of Object.entries(files)) {
        await mkdir(path.dirname(path.join(clashDir, name)), { recursive: true });
        await writeFile(path.join(clashDir, name), text);
      }
    };
    const tree = async (dir, prefix = "") => {
      const found = {};
      for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (entry.isDirectory()) Object.assign(found, { [`${prefix}${entry.name}/`]: "" }, await tree(path.join(dir, entry.name), `${prefix}${entry.name}/`));
        else found[`${prefix}${entry.name}`] = await readFile(path.join(dir, entry.name), "utf8");
      }
      return found;
    };
    const clashing = async (type, names, conflicts, to = "/clash/to") => {
      const task = await admin.post("/api/tasks", { type, sources: names.map((name) => ({ rootSlug: "photos", path: `/clash/from/${name}` })), destination: { rootSlug: "photos", path: to }, options: { conflicts } });
      return waitTask(admin, task.json.id);
    };
    const relay = async () => {
      await rm(clashDir, { recursive: true, force: true });
      await lay({ "from/a.txt": "new a", "from/b.txt": "new b", "from/box/one.txt": "new one", "from/box/two.txt": "new two", "from/box/deep/x.txt": "new x", "to/a.txt": "old a", "to/a 2.txt": "old a 2", "to/box/one.txt": "old one", "to/box/old.txt": "old", "to/box/deep/x.txt": "old x" });
    };
    await relay();
    // Each comes with what tells it from the one there: a file's size, and when either was last changed.
    await utimes(path.join(clashDir, "from", "a.txt"), 1_700_000_100, 1_700_000_100);
    await utimes(path.join(clashDir, "to", "a.txt"), 1_700_000_000, 1_700_000_000);
    const asked = await admin.post("/api/tasks/conflicts", { sources: ["a.txt", "b.txt", "box"].map((name) => ({ rootSlug: "photos", path: `/clash/from/${name}` })), destination: { rootSlug: "photos", path: "/clash/to" } });
    assert.deepEqual(asked.json.conflicts.map(({ mtime, existing, ...conflict }) => ({ ...conflict, existing: { kind: existing.kind, size: existing.size } })), [
      { rootSlug: "photos", path: "/clash/from/a.txt", name: "a.txt", kind: "file", size: 5, existing: { kind: "file", size: 5 }, same: false },
      { rootSlug: "photos", path: "/clash/from/box", name: "box", kind: "folder", size: 0, existing: { kind: "folder", size: 0 }, same: false }
    ]);
    assert.deepEqual([asked.json.conflicts[0].mtime, asked.json.conflicts[0].existing.mtime], [1_700_000_100_000, 1_700_000_000_000]);
    const inPlace = await admin.post("/api/tasks/conflicts", { sources: [{ rootSlug: "photos", path: "/clash/from/a.txt" }], destination: { rootSlug: "photos", path: "/clash/from" } });
    assert.equal(inPlace.json.conflicts[0].same, true);
    // Without an answer for every name nothing is carried.
    assert.equal((await clashing("copy", ["a.txt", "b.txt", "box"], { "a.txt": "skip" })).error_message, "Target already exists");
    assert.equal((await tree(path.join(clashDir, "to")))["b.txt"], undefined);
    // Skipped, the one there stays; kept, the new one gets the first name that is free; replaced, the one there goes whole.
    assert.deepEqual(await clashing("copy", ["a.txt", "b.txt", "box"], { "a.txt": "keep", box: "skip" }).then((task) => [task.status, task.total_files, task.processed_files]), ["done", 5, 5]);
    assert.deepEqual(await tree(path.join(clashDir, "to")), { "a 2.txt": "old a 2", "a 3.txt": "new a", "a.txt": "old a", "b.txt": "new b", "box/": "", "box/deep/": "", "box/deep/x.txt": "old x", "box/old.txt": "old", "box/one.txt": "old one" });
    await relay();
    assert.equal((await clashing("copy", ["a.txt", "box"], { "a.txt": "replace", box: "replace" })).status, "done");
    assert.deepEqual(await tree(path.join(clashDir, "to")), { "a 2.txt": "old a 2", "a.txt": "new a", "box/": "", "box/deep/": "", "box/deep/x.txt": "new x", "box/one.txt": "new one", "box/two.txt": "new two" });
    assert.equal((await tree(path.join(clashDir, "from")))["box/one.txt"], "new one");
    // Merged, a folder takes what it lacks, and what both have goes the way that was chosen for it.
    await relay();
    assert.equal((await clashing("copy", ["box"], { box: "merge_skip" })).status, "done");
    assert.deepEqual(await tree(path.join(clashDir, "to", "box")), { "deep/": "", "deep/x.txt": "old x", "old.txt": "old", "one.txt": "old one", "two.txt": "new two" });
    await relay();
    assert.equal((await clashing("copy", ["box"], { box: "merge_replace" })).status, "done");
    assert.deepEqual(await tree(path.join(clashDir, "to", "box")), { "deep/": "", "deep/x.txt": "new x", "old.txt": "old", "one.txt": "new one", "two.txt": "new two" });
    await relay();
    assert.equal((await clashing("copy", ["box"], { box: "merge_keep" })).status, "done");
    assert.deepEqual(await tree(path.join(clashDir, "to", "box")), { "deep/": "", "deep/x 2.txt": "new x", "deep/x.txt": "old x", "old.txt": "old", "one 2.txt": "new one", "one.txt": "old one", "two.txt": "new two" });
    // Moved, the source folder goes once it is empty, and stays with whatever was skipped.
    await relay();
    assert.deepEqual(await clashing("move", ["a.txt", "box"], { "a.txt": "replace", box: "merge_replace" }).then((task) => [task.status, task.total_files, task.processed_files]), ["done", 4, 4]);
    assert.deepEqual(await tree(path.join(clashDir, "from")), { "b.txt": "new b" });
    assert.deepEqual(await tree(path.join(clashDir, "to")), { "a 2.txt": "old a 2", "a.txt": "new a", "box/": "", "box/deep/": "", "box/deep/x.txt": "new x", "box/old.txt": "old", "box/one.txt": "new one", "box/two.txt": "new two" });
    await relay();
    assert.equal((await clashing("move", ["box"], { box: "merge_skip" })).status, "done");
    assert.deepEqual(await tree(path.join(clashDir, "from", "box")), { "deep/": "", "deep/x.txt": "new x", "one.txt": "new one" });
    assert.equal((await tree(path.join(clashDir, "to", "box")))["two.txt"], "new two");
    await relay();
    assert.equal((await clashing("move", ["a.txt", "box"], { "a.txt": "keep", box: "replace" })).status, "done");
    assert.deepEqual(await tree(path.join(clashDir, "to")), { "a 2.txt": "old a 2", "a 3.txt": "new a", "a.txt": "old a", "box/": "", "box/deep/": "", "box/deep/x.txt": "new x", "box/one.txt": "new one", "box/two.txt": "new two" });
    assert.deepEqual(await tree(path.join(clashDir, "from")), { "b.txt": "new b" });
    // A file and a folder of one name are not merged: the choice made for files inside decides.
    await relay();
    await lay({ "from/mixed/in.txt": "new in", "to/mixed": "old file" });
    assert.equal((await clashing("copy", ["mixed"], { mixed: "merge_keep" })).status, "done");
    assert.equal((await tree(path.join(clashDir, "to")))["mixed 2/in.txt"], "new in");
    assert.equal((await clashing("copy", ["mixed"], { mixed: "merge_replace" })).status, "done");
    assert.equal((await tree(path.join(clashDir, "to")))["mixed/in.txt"], "new in");
    // Copied where it already is, an item is doubled when both are to be kept, and otherwise left alone.
    assert.equal((await clashing("copy", ["a.txt", "box"], { "a.txt": "keep", box: "keep" }, "/clash/from")).status, "done");
    assert.equal((await tree(path.join(clashDir, "from")))["a 2.txt"], "new a");
    assert.equal((await tree(path.join(clashDir, "from")))["box 2/deep/x.txt"], "new x");
    assert.equal((await clashing("copy", ["a.txt"], { "a.txt": "replace" }, "/clash/from")).status, "done");
    assert.equal((await tree(path.join(clashDir, "from")))["a.txt"], "new a");
    // A folder cannot make way for something it holds itself.
    await lay({ "from/box/box/inner.txt": "inner" });
    assert.equal((await clashing("copy", ["box/box"], { box: "replace" }, "/clash/from")).error_message, "Cannot replace or merge into a folder that holds the source");
    assert.equal((await tree(path.join(clashDir, "from")))["box/box/inner.txt"], "inner");
    await rm(clashDir, { recursive: true });

    // A folder of many files is copied several at a time, and still arrives whole, each file with its own time.
    const manyDir = path.join(fixture.dataDir, "photos", "many");
    const manyNames = Array.from({ length: 240 }, (_, index) => `d${index % 6}/deep${index % 4}/f${index}.txt`);
    for (const name of manyNames) {
      await mkdir(path.dirname(path.join(manyDir, name)), { recursive: true });
      await writeFile(path.join(manyDir, name), name);
      await utimes(path.join(manyDir, name), 1_700_000_000, 1_700_000_000 + manyNames.indexOf(name));
    }
    await mkdir(path.join(fixture.dataDir, "photos", "many-to"));
    assert.deepEqual(await counted("copy", "/many", "/many-to"), { status: "done", total_files: 240, processed_files: 240 });
    for (const name of manyNames) {
      const copied = path.join(fixture.dataDir, "photos", "many-to", "many", name);
      assert.equal(await readFile(copied, "utf8"), name);
      assert.equal((await stat(copied)).mtimeMs, (1_700_000_000 + manyNames.indexOf(name)) * 1000);
    }
    // Many picked at once are each checked against what the folder holds: one name taken stops them all before any is copied.
    await mkdir(path.join(fixture.dataDir, "photos", "many-flat"));
    await writeFile(path.join(fixture.dataDir, "photos", "many-flat", "f3.txt"), "taken");
    const picked = manyNames.filter((name) => name.startsWith("d3/deep3/")).map((name) => ({ rootSlug: "photos", path: `/many/${name}` }));
    const clash = await admin.post("/api/tasks", { type: "copy", sources: picked, destination: { rootSlug: "photos", path: "/many-flat" } });
    assert.equal((await waitTask(admin, clash.json.id)).status, "failed");
    assert.deepEqual(await readdir(path.join(fixture.dataDir, "photos", "many-flat")), ["f3.txt"]);
    await rm(path.join(fixture.dataDir, "photos", "many-flat", "f3.txt"));
    const pickedTask = await admin.post("/api/tasks", { type: "move", sources: picked, destination: { rootSlug: "photos", path: "/many-flat" } });
    assert.equal((await waitTask(admin, pickedTask.json.id)).processed_files, picked.length);
    assert.equal((await readdir(path.join(fixture.dataDir, "photos", "many-flat"))).length, picked.length);
    assert.deepEqual(await readdir(path.join(manyDir, "d3", "deep3")), []);
    for (const name of ["many", "many-to", "many-flat"]) await rm(path.join(fixture.dataDir, "photos", name), { recursive: true });

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
    assert.match(String(thumbnail.headers["content-type"]), /text\/plain/);
    assert.equal(thumbnail.payload, "uploaded");
    assert.equal((await admin.get("/api/fs/thumbnail?rootSlug=photos&path=/public")).statusCode, 404);
    // The medium one is a picture or nothing: a file that is not one has none, whatever its small one falls back on.
    assert.equal((await admin.get("/api/fs/thumbnail?rootSlug=photos&path=/public/uploaded.txt&size=medium")).statusCode, 404);
    assert.equal((await admin.get("/api/fs/thumbnail?rootSlug=photos&path=/public/uploaded.txt&size=huge")).statusCode, 400);

    // Only a picture can become the desktop background, and without one there is nothing to show or to take away.
    assert.equal((await admin.get("/api/wallpaper")).statusCode, 404);
    const notPicture = await admin.post("/api/wallpaper", { rootSlug: "photos", path: "/public/uploaded.txt" });
    assert.equal(notPicture.statusCode, 422);
    assert.equal(notPicture.json.code, "NOT_A_PICTURE");
    assert.equal((await admin.delete("/api/wallpaper")).json.settings.wallpaper, null);
    assert.equal((await admin.patch("/api/settings", { wallpaper: 1 })).statusCode, 400);

    // A profile picture is kept the same way, on the account rather than among its settings.
    const me = (await admin.get("/api/auth/me")).json.user;
    assert.equal(me.avatar, null);
    assert.equal((await admin.get(`/api/users/${me.id}/avatar`)).statusCode, 404);
    assert.equal((await admin.get("/api/users/..%2Fwallpapers%2Fx/avatar")).statusCode, 400);
    const notPortrait = await admin.post("/api/avatar", { rootSlug: "photos", path: "/public/uploaded.txt" });
    assert.equal(notPortrait.statusCode, 422);
    assert.equal(notPortrait.json.code, "NOT_A_PICTURE");
    // Which square of it to keep is named in parts of the picture, and nothing else is taken for one.
    assert.equal((await admin.post("/api/avatar", { rootSlug: "photos", path: "/public/uploaded.txt", crop: { x: 0.25, y: 0, size: 0.5 } })).json.code, "NOT_A_PICTURE");
    assert.equal((await admin.post("/api/avatar", { rootSlug: "photos", path: "/public/uploaded.txt", crop: { x: 0, y: 0, size: 0 } })).statusCode, 400);
    assert.equal((await admin.post("/api/avatar", { rootSlug: "photos", path: "/public/uploaded.txt", crop: { x: 2, y: 0, size: 1 } })).statusCode, 400);
    assert.equal((await admin.delete("/api/avatar")).json.user.avatar, null);
    assert.equal((await admin.get("/api/users")).json[0].avatar_at, null);

    // The editor saves a file's text back in place, and refuses to save over a copy that has changed since it was read.
    const uploadedFile = path.join(fixture.dataDir, "photos", "public", "uploaded.txt");
    const beforeEdit = await admin.get("/api/fs/meta?rootSlug=photos&path=/public/uploaded.txt");
    const edited = await admin.put("/api/fs/content", { rootSlug: "photos", path: "/public/uploaded.txt", content: "edited\r\n", mtime: beforeEdit.json.mtime });
    assert.equal(edited.statusCode, 200);
    assert.equal(edited.json.size, 8);
    assert.equal(await readFile(uploadedFile, "utf8"), "edited\r\n");
    const staleEdit = await admin.put("/api/fs/content", { rootSlug: "photos", path: "/public/uploaded.txt", content: "stale", mtime: beforeEdit.json.mtime - 5000 });
    assert.equal(staleEdit.statusCode, 409);
    assert.equal(staleEdit.json.code, "FILE_CHANGED");
    assert.equal((await admin.put("/api/fs/content", { rootSlug: "photos", path: "/public/uploaded.txt", content: "uploaded" })).statusCode, 200);
    assert.equal(await readFile(uploadedFile, "utf8"), "uploaded");
    assert.equal((await admin.put("/api/fs/content", { rootSlug: "photos", path: "/public", content: "" })).statusCode, 400);
    assert.equal((await admin.put("/api/fs/content", { rootSlug: "photos", path: "/public/missing.txt", content: "" })).statusCode, 404);

    // Only pictures a browser cannot decode are converted; anything else is refused before a converter is started.
    const notConverted = await admin.get("/api/fs/image?rootSlug=photos&path=/public/uploaded.txt");
    assert.equal(notConverted.statusCode, 422);
    assert.equal(notConverted.json.code, "IMAGE_NOT_CONVERTIBLE");

    // A SQLite database is read on the server, page by page, without leaving anything beside the file.
    const sampleDb = path.join(fixture.dataDir, "photos", "public", "sample.db");
    const sample = new DatabaseSync(sampleDb);
    sample.exec(`
      CREATE TABLE "odd ""name" (id INTEGER PRIMARY KEY, title TEXT NOT NULL, payload BLOB, big INTEGER);
      INSERT INTO "odd ""name" (title, payload, big) VALUES ('first', x'00ff10', 9007199254740993), ('second', NULL, 2), ('third', NULL, 3);
      CREATE VIEW titles AS SELECT title, title FROM "odd ""name";
    `);
    sample.close();
    const overview = await admin.get("/api/fs/sqlite?rootSlug=photos&path=/public/sample.db");
    assert.equal(overview.statusCode, 200);
    assert.deepEqual(overview.json.tables.map((table) => [table.name, table.type]), [['odd "name', "table"], ["titles", "view"]]);
    assert.deepEqual(overview.json.tables[0].columns[0], { name: "id", type: "INTEGER", pk: true, notNull: false });
    const sqlitePage = await admin.get(`/api/fs/sqlite/rows?rootSlug=photos&path=/public/sample.db&table=${encodeURIComponent('odd "name')}&limit=2`);
    assert.equal(sqlitePage.statusCode, 200);
    assert.deepEqual(sqlitePage.json.columns, ["id", "title", "payload", "big"]);
    assert.deepEqual(sqlitePage.json.rows, [[1, "first", { blob: 3 }, "9007199254740993"], [2, "second", null, 2]]);
    assert.equal(sqlitePage.json.hasMore, true);
    assert.equal(sqlitePage.json.total, 3);
    const sqliteView = await admin.get("/api/fs/sqlite/rows?rootSlug=photos&path=/public/sample.db&table=titles&offset=2");
    assert.deepEqual(sqliteView.json.rows, [["third", "third"]]);
    assert.equal(sqliteView.json.hasMore, false);
    assert.equal((await admin.get("/api/fs/sqlite/rows?rootSlug=photos&path=/public/sample.db&table=sqlite_schema")).statusCode, 404);
    assert.equal((await admin.get("/api/fs/sqlite?rootSlug=photos&path=/public/uploaded.txt")).json.code, "NOT_SQLITE");
    assert.deepEqual((await readdir(path.dirname(sampleDb))).filter((name) => name.startsWith("sample.db")), ["sample.db"]);
    await rm(sampleDb);

    const reader = await admin.post("/api/users", {
      email: "reader@example.test",
      password: "fake-reader-password-123",
      displayName: "Reader",
      role: "USER"
    });
    const group = await admin.post("/api/groups", { name: "public-readers" });
    assert.equal((await admin.post(`/api/groups/${group.json.id}/members`, { userId: reader.json.id })).statusCode, 200);
    assert.deepEqual((await admin.get("/api/groups")).json.map((item) => ({ name: item.name, members: item.members })), [
      { name: "public-readers", members: [{ id: reader.json.id, email: "reader@example.test", display_name: "Reader", avatar_at: null }] }
    ]);
    assert.equal((await admin.put("/api/permissions", { principalType: "group", principalId: group.json.id, rootId: root.json.id, level: "view" })).statusCode, 200);

    // The permissions page ticks one principal in one location: each tick replaces the rule there, and no tick leaves none.
    const tick = (level) => admin.put("/api/permissions", { principalType: "user", principalId: reader.json.id, rootId: root.json.id, level });
    const ticked = async () => (await admin.get(`/api/permissions?rootId=${root.json.id}`)).json.filter((item) => item.principal_type === "user").map((item) => item.level);
    assert.equal((await tick("view")).json.rule.level, "view");
    assert.equal((await tick("edit")).json.rule.level, "edit");
    assert.deepEqual(await ticked(), ["edit"]);
    assert.equal((await tick(null)).json.rule, null);
    assert.deepEqual(await ticked(), []);

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
    // A location throws into a folder at its own top, which stays on its disk and is never listed or reached by path.
    const ownTrash = path.join(fixture.dataDir, "photos", ".kago-trash");
    assert.equal((await readdir(ownTrash)).length, 1);
    assert.deepEqual(await readdir(path.join(fixture.appDataDir, "trash")).catch(() => []), []);
    assert.ok(!(await admin.get("/api/fs/list?rootSlug=photos&path=/")).json.items.some((item) => item.name === ".kago-trash"));
    assert.equal((await admin.get("/api/fs/list?rootSlug=photos&path=/.kago-trash")).statusCode, 404);
    assert.equal((await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/.kago-trash", name: "inside" })).statusCode, 404);
    assert.deepEqual((await admin.delete("/api/trash")).json, { deleted: 1 });
    assert.deepEqual((await admin.get("/api/trash")).json, []);
    assert.deepEqual(await readdir(ownTrash), []);

    // Nothing has to be copied to get there, so nothing is asked; deleting for good skips the trash altogether.
    assert.equal((await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/public", name: "to-delete" })).statusCode, 200);
    assert.deepEqual((await admin.post("/api/trash/cost", { sources: [{ rootSlug: "photos", path: "/public/to-delete" }] })).json, { copyBytes: 0 });
    const deleteTask = await admin.post("/api/tasks", { type: "delete", sources: [{ rootSlug: "photos", path: "/public/to-delete" }] });
    assert.equal((await waitTask(admin, deleteTask.json.id)).status, "done");
    assert.equal((await admin.get("/api/fs/list?rootSlug=photos&path=/public/to-delete")).statusCode, 404);
    assert.deepEqual((await admin.get("/api/trash")).json, []);
    assert.deepEqual(await readdir(ownTrash), []);
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

// A view-only link shows what a browser can display and refuses the rest, which a browser would save instead.
    const viewShare = await admin.post("/api/shares", { rootSlug: "photos", path: "/public/readme.txt", mode: "view_only" });
    assert.equal((await app.inject({ method: "GET", url: `/s/${viewShare.json.token}`, headers: { accept: "application/json" } })).json().previewable, true);
    const sharedView = await app.inject({ method: "GET", url: `/s/${viewShare.json.token}/preview` });
    assert.equal(sharedView.statusCode, 200);
    assert.equal(sharedView.payload, "public");
    assert.equal(sharedView.headers["x-content-type-options"], "nosniff");
    await writeFile(path.join(fixture.dataDir, "photos", "public", "bundle.zip"), "zip");
    await writeFile(path.join(fixture.dataDir, "photos", "public", "drawing.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const zipShare = await admin.post("/api/shares", { rootSlug: "photos", path: "/public/bundle.zip", mode: "view_only" });
    assert.equal((await app.inject({ method: "GET", url: `/s/${zipShare.json.token}`, headers: { accept: "application/json" } })).json().previewable, false);
    const refusedView = await app.inject({ method: "GET", url: `/s/${zipShare.json.token}/preview` });
    assert.equal(refusedView.statusCode, 415);
    assert.equal(refusedView.json().code, "PREVIEW_UNSUPPORTED");
    const svgShare = await admin.post("/api/shares", { rootSlug: "photos", path: "/public/drawing.svg", mode: "view_only" });
    assert.match((await app.inject({ method: "GET", url: `/s/${svgShare.json.token}/preview` })).headers["content-security-policy"], /sandbox/);
    // An uploaded script or stylesheet comes back as plain bytes, so no page of Kago's origin can load it as its own.
    await writeFile(path.join(fixture.dataDir, "photos", "public", "evil.js"), "alert(1)");
    const scriptShare = await admin.post("/api/shares", { rootSlug: "photos", path: "/public/evil.js", mode: "download" });
    const scriptLoads = [
      await app.inject({ method: "GET", url: `/s/${scriptShare.json.token}/download` }),
      await admin.get(`/api/fs/download?rootSlug=photos&path=${encodeURIComponent("/public/evil.js")}`, { accept: "*/*" }),
      await admin.get(`/api/fs/preview?rootSlug=photos&path=${encodeURIComponent("/public/evil.js")}`, { accept: "*/*" })
    ];
    for (const loaded of scriptLoads) {
      assert.equal(loaded.statusCode, 200);
      assert.equal(loaded.headers["content-type"], "application/octet-stream");
      assert.equal(loaded.headers["x-content-type-options"], "nosniff");
    }
    await rm(path.join(fixture.dataDir, "photos", "public", "bundle.zip"));
    await rm(path.join(fixture.dataDir, "photos", "public", "drawing.svg"));
    await rm(path.join(fixture.dataDir, "photos", "public", "evil.js"));

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

    // What the system left behind is not listed, in whatever case it was written, but stays reachable by path.
    const litter = [".DS_Store", "Thumbs.db", "desktop.ini", "._readme.txt", "@eaDir"];
    for (const name of litter.slice(0, 4)) await writeFile(path.join(fixture.dataDir, "photos", "public", name), "litter");
    await mkdir(path.join(fixture.dataDir, "photos", "public", "@eaDir"));
    await writeFile(path.join(fixture.dataDir, "photos", "public", "thumbs.db.txt"), "kept");
    const tidyList = (await admin.get("/api/fs/list?rootSlug=photos&path=/public")).json.items.map((item) => item.name);
    assert.deepEqual(tidyList.filter((name) => litter.includes(name)), []);
    assert.ok(tidyList.includes("thumbs.db.txt"));
    // Asked for line by line, the same folder comes as what it is, its entries, and a last line saying it is whole.
    const streamed = (await admin.get("/api/fs/list?rootSlug=photos&path=/public", { headers: { accept: "application/x-ndjson" } })).payload.trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(streamed[0].path, "/public");
    assert.deepEqual(streamed.at(-1), { done: true });
    assert.deepEqual(streamed.slice(1, -1).flatMap((line) => line.items).map((item) => item.name).sort(), [...tidyList].sort());
    assert.equal((await admin.get("/api/fs/list?rootSlug=photos&path=/missing", { headers: { accept: "application/x-ndjson" } })).statusCode, 404);
    assert.equal((await admin.get("/api/fs/download?rootSlug=photos&path=/public/Thumbs.db")).payload, "litter");
    // A folder's size is everything inside it, however deep, counted as it is listed: without what the system left behind.
    await mkdir(path.join(fixture.dataDir, "photos", "sized", "inner", "deeper"), { recursive: true });
    for (const [name, text] of [["a.txt", "12345"], ["inner/b.txt", "123"], ["inner/deeper/c.txt", "12"], [".DS_Store", "litter"], ["inner/._b.txt", "litter"]]) await writeFile(path.join(fixture.dataDir, "photos", "sized", name), text);
    await symlink(path.join(fixture.dataDir, "photos", "public"), path.join(fixture.dataDir, "photos", "sized", "elsewhere"));
    assert.deepEqual((await admin.get("/api/fs/size?rootSlug=photos&path=/sized")).json, { bytes: 10, count: 3 });
    assert.deepEqual((await admin.get("/api/fs/size?rootSlug=photos&path=/sized/inner")).json, { bytes: 5, count: 2 });
    assert.deepEqual((await admin.get("/api/fs/size?rootSlug=photos&path=/sized/a.txt")).json, { bytes: 5, count: 1 });
    assert.equal((await admin.get("/api/fs/size?rootSlug=photos&path=/sized/missing")).statusCode, 404);
    await rm(path.join(fixture.dataDir, "photos", "sized"), { recursive: true });
    // A rule is for the whole location: what it lets someone see in one folder it lets them see in every other.
    assert.equal((await scopedUser.get("/api/fs/list?rootSlug=photos&path=/private")).statusCode, 200);
    assert.equal((await scopedUser.post("/api/fs/mkdir", { rootSlug: "photos", path: "/public", name: "not-allowed" })).statusCode, 403);

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
    // The router decodes the path, so an escaped letter must not walk around the header check.
    const escapedPath = await app.inject({ method: "POST", url: "/%61pi/auth/logout" });
    assert.equal(escapedPath.statusCode, 403);
    assert.equal(JSON.parse(escapedPath.payload).code, "CSRF_REQUIRED");

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
    // A path is always read inside its location, so the server's own /data is never reached: this names a folder "data" that is not there.
    assert.equal(physicalPath.statusCode, 404);
    assert.equal(physicalPath.json.code, "PATH_NOT_FOUND");

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
    const visit = await app.inject({ method: "GET", url: `/s/${limitedShare.json.token}`, headers: { accept: "application/json" } });
    const visitCookie = String(visit.headers["set-cookie"]).split(";", 1)[0];
    const asVisitor = (part) => app.inject({ method: "GET", url: `/s/${limitedShare.json.token}/${part}`, headers: { cookie: visitCookie } });
    assert.equal((await asVisitor("download")).statusCode, 200);
    // Whoever was counted may look and download again; the limit is on how many people, not how many requests.
    assert.equal((await asVisitor("preview")).statusCode, 200);
    assert.equal((await asVisitor("download")).statusCode, 200);
    assert.equal((await admin.get("/api/shares")).json.find((item) => item.id === limitedShare.json.id).download_count, 1);
    // Without the visit's cookie, a request from the same address is somebody else behind it, and is counted.
    const sameAddress = await app.inject({ method: "GET", url: `/s/${limitedShare.json.token}/download` });
    assert.equal(sameAddress.statusCode, 410);
    assert.equal(JSON.parse(sameAddress.payload).code, "SHARE_LIMIT_REACHED");
    const limitedAgain = await app.inject({ method: "GET", url: `/s/${limitedShare.json.token}/download`, remoteAddress: "203.0.113.9" });
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

    // Clearing forgets what has ended, along with a download nobody can ask for any more.
    const listed = (await admin.get("/api/tasks")).json;
    assert.ok(listed.length >= 4);
    assert.deepEqual((await admin.delete("/api/tasks")).json, { cleared: listed.length });
    assert.deepEqual((await admin.get("/api/tasks")).json, []);
    assert.deepEqual(await readdir(path.join(fixture.appDataDir, "temp", "downloads")), []);

    // A sync job goes on telling how its last run ended after that run is cleared from the list.
    const job = await admin.post("/api/sync-jobs", { name: "Backup", source: { kind: "location", rootSlug: "photos", path: "/public" }, destination: { kind: "location", rootSlug: "photos", path: "/2026" } });
    const lastStatus = async () => (await admin.get("/api/sync-jobs")).json[0].last_status;
    const firstRun = await waitTask(admin, (await admin.post(`/api/sync-jobs/${job.json.id}/run`)).json.id);
    assert.deepEqual((await admin.delete("/api/tasks")).json, { cleared: 1 });
    assert.deepEqual((await admin.get("/api/tasks")).json, []);
    assert.equal(await lastStatus(), firstRun.status);
    assert.deepEqual((await admin.delete("/api/tasks")).json, { cleared: 0 });
    // The job's next run takes its place, and the cleared one is forgotten with whatever is cleared next.
    await waitTask(admin, (await admin.post(`/api/sync-jobs/${job.json.id}/run`)).json.id);
    assert.equal((await admin.get("/api/tasks")).json.length, 1);
    assert.deepEqual((await admin.delete("/api/tasks")).json, { cleared: 1 });
    assert.equal((await admin.get(`/api/tasks/${firstRun.id}`)).statusCode, 404);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("compress tasks take a compression level and a password", async () => {
  const fixture = await createFixture("kago-smoke-compress.");
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Smoke Admin" })).statusCode, 200);
    const text = "kago ".repeat(20_000);
    await writeFile(path.join(fixture.dataDir, "photos", "public", "long.txt"), text);
    const password = "fake-zip-password 密碼";
    const compress = async (name, options) => {
      const task = await admin.post("/api/tasks", { type: "compress", sources: [{ rootSlug: "photos", path: "/public/long.txt" }], destination: { rootSlug: "photos", path: `/2026/${name}.zip` }, options });
      assert.equal(task.statusCode, 200);
      assert.equal(JSON.stringify(task.json).includes(password), false);
      const done = await waitTask(admin, task.json.id);
      assert.equal(done.status, "done", done.error_message);
      // Not even the sealed password outlives the task.
      assert.equal("password" in JSON.parse(done.destination).options, false);
      return readFile(path.join(fixture.dataDir, "photos", "2026", `${name}.zip`));
    };

    const stored = await compress("stored", { level: "store" });
    const best = await compress("best", { level: "best" });
    assert.equal(new AdmZip(stored).getEntry("long.txt").header.method, 0);
    assert.ok(stored.length > text.length);
    assert.ok(best.length < text.length / 10);
    assert.equal(new AdmZip(best).readAsText("long.txt"), text);

    const legacy = new AdmZip(await compress("legacy", { password, encryption: "zipcrypto" }));
    assert.equal(legacy.getEntry("long.txt").header.encrypted, true);
    assert.equal(legacy.readFile("long.txt", password).toString(), text);
    assert.throws(() => legacy.readFile("long.txt", "wrong"));

    // AES is the default: WinZip's AE-2, read back here by its own description.
    const locked = await compress("locked", { password, level: "fast" });
    assert.equal(locked.readUInt16LE(6) & 1, 1);
    assert.equal(locked.readUInt16LE(8), 99);
    const dataStart = 30 + locked.readUInt16LE(26) + locked.readUInt16LE(28);
    const descriptor = locked.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]), dataStart);
    assert.equal(locked.readUInt32LE(descriptor + 4), 0);
    assert.equal(locked.readUInt32LE(descriptor + 8), descriptor - dataStart);
    const keys = pbkdf2Sync(password, locked.subarray(dataStart, dataStart + 16), 1000, 66, "sha1");
    assert.deepEqual(locked.subarray(dataStart + 16, dataStart + 18), keys.subarray(64));
    const sealed = locked.subarray(dataStart + 18, descriptor - 10);
    assert.deepEqual(locked.subarray(descriptor - 10, descriptor), createHmac("sha1", keys.subarray(32, 64)).update(sealed).digest().subarray(0, 10));
    const counters = Buffer.alloc(Math.ceil(sealed.length / 16) * 16);
    for (let block = 0; block * 16 < counters.length; block += 1) counters.writeUInt32LE(block + 1, block * 16);
    const stream = createCipheriv("aes-256-ecb", keys.subarray(0, 32), null).setAutoPadding(false).update(counters);
    assert.equal(inflateRawSync(sealed.map((byte, index) => byte ^ stream[index])).toString(), text);
    assert.equal(locked.includes(Buffer.from("kago kago")), false);

    // Locked archives open with a password given for the task, or with one of those the person keeps.
    let folders = 0;
    const extract = async (name, options) => {
      const folder = `out-${(folders += 1)}`;
      assert.equal((await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/2026", name: folder })).statusCode, 200);
      const task = await admin.post("/api/tasks", { type: "extract", sources: [{ rootSlug: "photos", path: `/2026/${name}.zip` }], destination: { rootSlug: "photos", path: `/2026/${folder}` }, options });
      assert.equal(task.statusCode, 200);
      assert.equal(JSON.stringify(task.json).includes(password), false);
      return { task: await waitTask(admin, task.json.id), read: () => readFile(path.join(fixture.dataDir, "photos", "2026", folder, "long.txt"), "utf8") };
    };
    for (const name of ["locked", "legacy"]) {
      const closed = await extract(name);
      assert.equal(closed.task.status, "failed");
      assert.equal(closed.task.error_message, "Archive password required");
      await assert.rejects(closed.read());
      assert.equal((await extract(name, { password: "wrong" })).task.error_message, "Wrong archive password");
      const opened = await extract(name, { password });
      assert.equal(opened.task.status, "done", opened.task.error_message);
      assert.equal(await opened.read(), text);
      assert.equal("password" in JSON.parse(opened.task.destination).options, false);
    }
    assert.deepEqual((await admin.get("/api/archive-passwords")).json, []);
    assert.equal((await admin.post("/api/archive-passwords", { password: "not this one", note: "old" })).statusCode, 200);
    assert.equal((await extract("locked")).task.error_message, "Archive password required");
    assert.equal((await extract("locked", { password, remember: true })).task.status, "done");
    const kept = (await admin.get("/api/archive-passwords")).json;
    assert.deepEqual(kept.map((item) => item.note), ["old", ""]);
    assert.equal(JSON.stringify(kept).includes(password), false);
    const unasked = await extract("legacy");
    assert.equal(unasked.task.status, "done", unasked.task.error_message);
    assert.equal(await unasked.read(), text);
    assert.equal((await admin.delete(`/api/archive-passwords/${kept[1].id}`)).json.length, 1);
    assert.equal((await extract("locked")).task.error_message, "Archive password required");

    // A locked archive that failed is locked the same way when it is tried again.
    await writeFile(path.join(fixture.dataDir, "photos", "2026", "taken.zip"), "in the way");
    const blocked = await admin.post("/api/tasks", { type: "compress", sources: [{ rootSlug: "photos", path: "/public/long.txt" }], destination: { rootSlug: "photos", path: "/2026/taken.zip" }, options: { password } });
    assert.equal((await waitTask(admin, blocked.json.id)).status, "failed");
    await rm(path.join(fixture.dataDir, "photos", "2026", "taken.zip"));
    const again = await admin.post(`/api/tasks/${blocked.json.id}/retry`);
    assert.equal((await waitTask(admin, again.json.id)).status, "done");
    assert.equal((await readFile(path.join(fixture.dataDir, "photos", "2026", "taken.zip"))).readUInt16LE(8), 99);

    const logs = new DatabaseSync(path.join(fixture.appDataDir, "app.db"), { readOnly: true });
    try {
      assert.equal(logs.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE target_json LIKE ?").get(`%${password}%`).n, 0);
    } finally {
      logs.close();
    }
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("folders and selections download as one archive written on the fly", async () => {
  const fixture = await createFixture("kago-smoke-zip.");
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Smoke Admin" });
    await symlink(path.join(fixture.dataDir, "photos", "private", "secret.txt"), path.join(fixture.dataDir, "photos", "src", "link.txt"));
    await writeFile(path.join(fixture.dataDir, "photos", "src", "child", "名前.txt"), "x".repeat(100_000));

    const folder = await admin.get("/api/fs/download-zip?rootSlug=photos&path=/src", { accept: "*/*" });
    assert.equal(folder.statusCode, 200);
    assert.equal(folder.headers["content-type"], "application/zip");
    assert.match(folder.headers["content-disposition"], /filename="src\.zip"/);
    const folderZip = new AdmZip(folder.raw);
    // The symlink is left out; everything else keeps its place under the folder's own name.
    assert.deepEqual(folderZip.getEntries().map((entry) => entry.entryName), ["src/", "src/child/", "src/child/名前.txt", "src/file.txt"]);
    assert.equal(folderZip.readAsText("src/file.txt"), "demo");
    assert.equal(folderZip.readAsText("src/child/名前.txt").length, 100_000);
    assert.ok(folder.raw.length < 10_000);

    // A folder picked together with something inside it is written once.
    const several = await admin.get("/api/fs/download-zip?rootSlug=photos&path=/public/readme.txt&path=/src&path=/src/file.txt&path=/2026/demo.txt", { accept: "*/*" });
    assert.match(several.headers["content-disposition"], /filename="Kago\.zip"/);
    assert.deepEqual(new AdmZip(several.raw).getEntries().filter((entry) => !entry.isDirectory).map((entry) => entry.entryName), ["readme.txt", "src/child/名前.txt", "src/file.txt", "demo.txt"]);

    assert.equal((await admin.get("/api/fs/download-zip?rootSlug=photos&path=/missing")).statusCode, 404);
    assert.equal((await client(app).get("/api/fs/download-zip?rootSlug=photos&path=/src")).statusCode, 401);
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

    // Several are renamed in one go, and may hand their names around: a and b swap while c takes a new one.
    const batchDir = path.join(fixture.dataDir, "photos", "batch");
    await mkdir(batchDir);
    for (const name of ["a.txt", "b.txt", "c.txt", "kept.txt"]) await writeFile(path.join(batchDir, name), name);
    const renameMany = (items) => admin.post("/api/fs/rename-many", { rootSlug: "photos", items });
    const batchContents = async () => Object.fromEntries(await Promise.all((await readdir(batchDir)).sort().map(async (name) => [name, await readFile(path.join(batchDir, name), "utf8")])));
    const swapped = await renameMany([{ path: "/batch/a.txt", name: "b.txt" }, { path: "/batch/b.txt", name: "a.txt" }, { path: "/batch/c.txt", name: "001.txt" }]);
    assert.equal(swapped.statusCode, 200);
    assert.deepEqual(swapped.json.items, [{ from: "/batch/a.txt", path: "/batch/b.txt" }, { from: "/batch/b.txt", path: "/batch/a.txt" }, { from: "/batch/c.txt", path: "/batch/001.txt" }]);
    assert.deepEqual(await batchContents(), { "001.txt": "c.txt", "a.txt": "b.txt", "b.txt": "a.txt", "kept.txt": "kept.txt" });
    // A name that an entry outside the batch keeps, or that two of the batch would share, stops all of it.
    assert.equal((await renameMany([{ path: "/batch/001.txt", name: "002.txt" }, { path: "/batch/a.txt", name: "kept.txt" }])).statusCode, 409);
    assert.equal((await renameMany([{ path: "/batch/a.txt", name: "same.txt" }, { path: "/batch/b.txt", name: "same.txt" }])).statusCode, 409);
    assert.equal((await renameMany([{ path: "/batch/a.txt", name: "x/y.txt" }])).statusCode, 400);
    assert.deepEqual(Object.keys(await batchContents()), ["001.txt", "a.txt", "b.txt", "kept.txt"]);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

/** A Blu-ray subtitle stream with one white bar on screen for a few seconds; ffmpeg has no encoder to make one with. */
function pgsSubtitle() {
  const segment = (millis, type, body) => {
    const header = Buffer.alloc(13);
    header.write("PG");
    header.writeUInt32BE(millis * 90, 2);
    header[10] = type;
    header.writeUInt16BE(body.length, 11);
    return Buffer.concat([header, body]);
  };
  const [width, height, left, top] = [200, 20, 220, 300];
  const shown = Buffer.alloc(19);
  shown.writeUInt16BE(640, 0);
  shown.writeUInt16BE(360, 2);
  shown.set([0x10, 0, 0, 0x80, 0, 0, 1, 0, 0, 0, 0], 4);
  shown.writeUInt16BE(left, 15);
  shown.writeUInt16BE(top, 17);
  const cleared = Buffer.from(shown.subarray(0, 11));
  cleared.set([0, 1, 0, 0, 0, 0], 5);
  const area = Buffer.alloc(10);
  area[0] = 1;
  [left, top, width, height].forEach((value, index) => area.writeUInt16BE(value, 2 + index * 2));
  const palette = Buffer.from([0, 0, 1, 235, 128, 128, 255]);
  const rows = Buffer.concat(Array.from({ length: height }, () => Buffer.from([0, 0xc0 | (width >> 8), width & 255, 1, 0, 0])));
  const object = Buffer.alloc(11);
  object[3] = 0xc0;
  object.writeUIntBE(rows.length + 4, 4, 3);
  object.writeUInt16BE(width, 7);
  object.writeUInt16BE(height, 9);
  return Buffer.concat([
    segment(1000, 0x16, shown), segment(1000, 0x17, area), segment(1000, 0x14, palette), segment(1000, 0x15, Buffer.concat([object, rows])), segment(1000, 0x80, Buffer.alloc(0)),
    segment(4000, 0x16, cleared), segment(4000, 0x17, area), segment(4000, 0x80, Buffer.alloc(0))
  ]);
}

// Root is let past ownership and mode bits, so there is nothing for the disk to refuse it.
test("what the disk refuses is told apart from an unexpected error", { skip: process.getuid?.() === 0 && "running as root" }, async () => {
  const fixture = await createFixture("kago-smoke-refused.");
  const locked = path.join(fixture.dataDir, "photos", "public");
  const sealed = path.join(fixture.dataDir, "sealed");
  await mkdir(sealed);
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);

  try {
    await app.ready();
    assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Smoke Admin" })).statusCode, 200);
    await chmod(locked, 0o555);
    await chmod(sealed, 0o000);

    // An administrator of Kago is still only what the server's account is to the disk.
    const refused = (response) => {
      assert.equal(response.statusCode, 500);
      assert.equal(response.json.code, "FS_PERMISSION_DENIED");
      assert.match(response.json.error, /PUID \/ PGID/);
    };
    refused(await admin.post("/api/fs/mkdir", { rootSlug: "photos", path: "/public", name: "new-folder" }));
    refused(await admin.multipart("/api/fs/upload", { rootSlug: "photos", path: "/public", filename: "uploaded.txt", content: "uploaded" }));
    refused(await admin.get("/api/fs/list?rootSlug=sealed&path=/"));

    // A task says the same, rather than only that it failed.
    const copyTask = await admin.post("/api/tasks", { type: "copy", sources: [{ rootSlug: "photos", path: "/2026/demo.txt" }], destination: { rootSlug: "photos", path: "/public" } });
    const copied = await waitTask(admin, copyTask.json.id);
    assert.equal(copied.status, "failed");
    assert.match(copied.error_message, /PUID \/ PGID/);

    // Where it is set up, each local location says what the disk allows the account the server runs as.
    const storage = (await admin.get("/api/storage")).json;
    assert.deepEqual(storage.account, { uid: process.getuid(), gid: process.getgid() });
    const roots = (await admin.get("/api/roots")).json;
    const accessOf = (slug) => storage.local.find((item) => item.id === roots.find((root) => root.slug === slug).id);
    assert.deepEqual([accessOf("photos").readable, accessOf("photos").writable], [true, true]);
    assert.deepEqual([accessOf("sealed").readable, accessOf("sealed").writable], [false, false]);
    await chmod(path.join(fixture.dataDir, "photos"), 0o555);
    const readOnly = (await admin.get("/api/storage")).json.local.find((item) => item.id === accessOf("photos").id);
    assert.deepEqual([readOnly.readable, readOnly.writable], [true, false]);
  } finally {
    await app.close();
    for (const folder of [path.join(fixture.dataDir, "photos"), locked, sealed]) await chmod(folder, 0o755);
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("videos are probed and transcoded to HLS on demand", {
  skip: spawnSync("ffmpeg", ["-version"]).status !== 0
    ? "ffmpeg is not installed"
    : spawnSync("ffprobe", ["-version"]).status !== 0 && "ffprobe is not installed"
}, async () => {
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

    // The pictures over the timeline are made in the background, and only while the server has processor time to spare.
    const boardUrl = "/api/media/storyboard?rootSlug=photos&path=/public/clip.avi";
    const sheetUrl = "/api/media/storyboard/sheet?rootSlug=photos&path=/public/clip.avi&index=0";
    assert.equal((await admin.get(boardUrl)).json.status, "pending");
    assert.equal((await admin.get(sheetUrl)).statusCode, 404);
    assert.equal((await admin.get("/api/media/storyboard?rootSlug=photos&path=/public/readme.txt")).statusCode, 422);
    if (process.platform !== "win32" && availableParallelism() > 1 && loadavg()[0] < availableParallelism() - 1) {
      let board = null;
      for (let tries = 0; tries < 200 && board?.status !== "ready"; tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        board = (await admin.get(boardUrl)).json;
      }
      assert.equal(board.status, "ready");
      assert.deepEqual([board.interval, board.columns, board.rows, board.sheets], [1, 10, 10, 1]);
      assert.ok(board.count >= 10 && board.count <= 15, "a picture for each second of the clip");
      // A 4:3 picture fitted into the 240 by 135 box.
      assert.deepEqual([board.width, board.height], [180, 134]);
      const sheet = await admin.get(sheetUrl);
      assert.equal(sheet.statusCode, 200);
      assert.equal(sheet.headers["content-type"], "image/jpeg");
      assert.equal((await admin.get(sheetUrl.replace("index=0", "index=1"))).statusCode, 404);
    }

    // Subtitles are matched to the video by name; the rest of the name gives the language and flags.
    const publicDir = path.join(fixture.dataDir, "photos", "public");
    const coverImage = path.join(publicDir, "cover.jpg");
    const coverClip = path.join(publicDir, "cover.mp4");
    const madeCover = spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=80x80:r=1", "-frames:v", "1", "-c:v", "mjpeg", coverImage]);
    assert.equal(madeCover.status, 0, String(madeCover.stderr));
    const withCover = spawnSync("ffmpeg", [
      "-loglevel", "error", "-i", clip, "-i", coverImage,
      "-map", "1:v:0", "-map", "0:v:0", "-map", "0:a:0",
      "-c", "copy", "-disposition:v:0", "attached_pic", "-disposition:v:1", "default", coverClip
    ]);
    assert.equal(withCover.status, 0, String(withCover.stderr));
    const coverProbe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", coverClip]);
    assert.equal(coverProbe.status, 0, String(coverProbe.stderr));
    const coverStreams = JSON.parse(coverProbe.stdout).streams.filter((stream) => stream.codec_type === "video");
    assert.ok(coverStreams.some((stream) => stream.disposition.attached_pic === 1), "the fixture contains an attached cover picture");
    const mainBySelector = spawnSync("ffprobe", [
      "-v", "error", "-select_streams", "V:0", "-show_entries", "stream=codec_name,width,height", "-of", "json", coverClip
    ]);
    assert.equal(mainBySelector.status, 0, String(mainBySelector.stderr));
    const selectedMain = JSON.parse(mainBySelector.stdout).streams[0];
    assert.ok(selectedMain, "V:0 selects the primary video rather than the attached picture");
    assert.deepEqual([selectedMain.codec_name, selectedMain.width, selectedMain.height], ["mpeg4", 640, 480]);

    const coverInfo = await admin.get("/api/media/info?rootSlug=photos&path=/public/cover.mp4");
    assert.equal(coverInfo.statusCode, 200);
    assert.deepEqual([coverInfo.json.video.codec, coverInfo.json.video.width, coverInfo.json.video.height], ["mpeg4", 640, 480]);
    const coverSession = await admin.post("/api/media/sessions", { rootSlug: "photos", path: "/public/cover.mp4", height: 360 });
    assert.equal(coverSession.statusCode, 200);
    const coverSegment = await admin.get(`/api/media/sessions/${coverSession.json.id}/0.ts`);
    assert.equal(coverSegment.statusCode, 200);
    const coverOutputProbe = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height", "-of", "json", "pipe:0"
    ], { input: coverSegment.raw });
    assert.equal(coverOutputProbe.status, 0, String(coverOutputProbe.stderr));
    const coverVideo = JSON.parse(coverOutputProbe.stdout).streams.find((stream) => stream.codec_type === "video");
    assert.ok(coverVideo, "the cover-art session transcodes a video stream");
    assert.deepEqual([coverVideo.codec_name, coverVideo.pix_fmt, coverVideo.width, coverVideo.height], ["h264", "yuv420p", 480, 360]);
    await admin.delete(`/api/media/sessions/${coverSession.json.id}`);

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
      if (index === 2) {
        const probe = spawnSync("ffprobe", [
          "-v", "error",
          "-show_streams", "-show_packets",
          "-show_entries", "stream=index,codec_type,codec_name,pix_fmt,width,height:packet=pts_time,stream_index",
          "-of", "json", "pipe:0"
        ], { input: segment.raw });
        assert.equal(probe.status, 0, String(probe.stderr));
        const details = JSON.parse(probe.stdout);
        const video = details.streams.find((stream) => stream.codec_type === "video");
        const audio = details.streams.find((stream) => stream.codec_type === "audio");
        assert.ok(video, "the HLS segment has a video stream");
        assert.ok(audio, "the HLS segment has an audio stream");
        assert.deepEqual(
          [video.codec_name, video.pix_fmt, video.width, video.height],
          ["h264", "yuv420p", 480, 360],
          "the session transcodes MPEG-4 to browser-compatible H.264 at the requested size"
        );
        assert.equal(audio.codec_name, "aac", "the session transcodes MP3 audio to AAC");

        const firstVideoPacket = details.packets.find((packet) => packet.stream_index === video.index);
        assert.ok(firstVideoPacket, "the later segment contains a video packet");
        assert.ok(Number(firstVideoPacket.pts_time) >= 11, `later segment starts near its 12-second seek point, got ${firstVideoPacket.pts_time}`);
        assert.ok(Number(firstVideoPacket.pts_time) < 15, `later segment remains within the source duration, got ${firstVideoPacket.pts_time}`);
      }
    }
    assert.equal((await admin.get(`${base}/3.ts`)).statusCode, 404);
    assert.equal((await admin.get(`${base}/../../fs/list`)).statusCode !== 200, true);

    // Hover prewarm shares the exact transcode contract and returns complete cached segments without starting a foreground run.
    const hoverClip = path.join(publicDir, "hover.avi");
    const hoverEncoded = spawnSync("ffmpeg", [
      "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1920x1080:rate=24", "-t", "32", "-c:v", "mpeg4", "-q:v", "5", hoverClip
    ]);
    assert.equal(hoverEncoded.status, 0, String(hoverEncoded.stderr));
    const hoverSession = await admin.post("/api/media/sessions", { rootSlug: "photos", path: "/public/hover.avi", height: 360 });
    assert.equal(hoverSession.statusCode, 200);
    const hoverBase = `/api/media/sessions/${hoverSession.json.id}`;
    const hoverDir = path.join(fixture.appDataDir, "temp", "transcode", hoverSession.json.id);
    const warmDir = path.join(hoverDir, ".prewarm-cache");
    for (const invalid of [
      { time: -1, revision: 1 },
      { time: 0, revision: 0 },
      { time: 0, revision: 1.5 },
      { time: 0, revision: 1, unexpected: true }
    ]) assert.equal((await admin.post(`${hoverBase}/prewarm`, invalid)).statusCode, 400);

    const canSpeculate = process.platform !== "win32" && availableParallelism() > 1 && loadavg()[0] < availableParallelism() - 1;
    if (canSpeculate) {
      const queued = await admin.post(`${hoverBase}/prewarm`, { time: 20, revision: 1 });
      assert.deepEqual(queued.json, { status: "queued" });
      let warmFiles = [];
      for (let tries = 0; tries < 200; tries += 1) {
        warmFiles = await readdir(warmDir).catch(() => []);
        if (warmFiles.includes("3.ts") && warmFiles.includes("4.ts")) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.ok(warmFiles.includes("3.ts"), "the target segment at 18 seconds is prewarmed");
      assert.ok(warmFiles.includes("4.ts"), "the next segment is prewarmed");
      assert.deepEqual((await admin.post(`${hoverBase}/prewarm`, { time: 21, revision: 2 })).json, { status: "ready" });
      assert.deepEqual((await admin.post(`${hoverBase}/prewarm`, { time: 21, revision: 1 })).json, { status: "skipped", reason: "stale-revision" });
      assert.deepEqual((await admin.post(`${hoverBase}/prewarm`, { time: null, revision: 3 })).json, { status: "skipped", reason: "cancelled" });
      assert.deepEqual((await readdir(warmDir)).sort(), ["3.ts", "4.ts"], "cancellation preserves completed cache for the imminent seek");

      for (const index of [3, 4]) {
        const warmSegment = await admin.get(`${hoverBase}/${index}.ts`);
        assert.equal(warmSegment.statusCode, 200);
        assert.ok(warmSegment.raw.length > 0);
        assert.deepEqual(warmSegment.raw, await readFile(path.join(hoverDir, `${index}.ts`)));
      }
      assert.equal((await readdir(hoverDir)).includes("ffmpeg.m3u8"), false, "a warm hit did not start a foreground ffmpeg run");

      // Two adjacent requests arrive while a speculative encoder is active and must share one foreground run.
      assert.deepEqual((await admin.post(`${hoverBase}/prewarm`, { time: 12, revision: 4 })).json, { status: "queued" });
      let activeWorkDir = false;
      for (let tries = 0; tries < 200; tries += 1) {
        activeWorkDir = (await readdir(hoverDir)).some((name) => name.startsWith(".prewarm-") && name !== ".prewarm-cache");
        if (activeWorkDir) break;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(activeWorkDir, true, "the speculative ffmpeg is still active before concurrent foreground requests");
      const [foregroundZero, foregroundOne] = await Promise.all([
        admin.get(`${hoverBase}/0.ts`),
        admin.get(`${hoverBase}/1.ts`)
      ]);
      assert.equal(foregroundZero.statusCode, 200);
      assert.equal(foregroundZero.raw[0], 0x47);
      assert.equal(foregroundOne.statusCode, 200);
      assert.equal(foregroundOne.raw[0], 0x47);
      for (let tries = 0; tries < 100 && (await readdir(hoverDir)).some((name) => name.startsWith(".prewarm-") && name !== ".prewarm-cache"); tries += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      assert.equal((await readdir(warmDir).catch(() => [])).length, 0, "a cancelled hover is not promoted after the foreground seek");
    }

    // An HDR picture is told apart, and a picture subtitle is listed as one the server draws into the frames.
    const hdrClip = path.join(publicDir, "hdr.mkv");
    await writeFile(path.join(publicDir, "inner.sup"), pgsSubtitle());
    await writeFile(path.join(publicDir, "cover.en.sup"), pgsSubtitle());
    const coverSubtitle = await admin.get("/api/media/subtitles?rootSlug=photos&path=/public/cover.mp4");
    assert.deepEqual(coverSubtitle.json.tracks.map((track) => [track.id, track.format]), [["file:/public/cover.en.sup", "pgs"]]);
    const coverSubtitleSession = await admin.post("/api/media/sessions", {
      rootSlug: "photos", path: "/public/cover.mp4", height: 360, subtitleIndex: 0, subtitlePath: "/public/cover.en.sup"
    });
    assert.equal(coverSubtitleSession.statusCode, 200);
    const coverSubtitleSegment = await admin.get(`/api/media/sessions/${coverSubtitleSession.json.id}/0.ts`);
    assert.equal(coverSubtitleSegment.statusCode, 200);
    const coverSubtitleProbe = spawnSync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height", "-of", "json", "pipe:0"
    ], { input: coverSubtitleSegment.raw });
    assert.equal(coverSubtitleProbe.status, 0, String(coverSubtitleProbe.stderr));
    const coverSubtitleVideo = JSON.parse(coverSubtitleProbe.stdout).streams.find((stream) => stream.codec_type === "video");
    assert.ok(coverSubtitleVideo, "the cover-art subtitle session transcodes a video stream");
    assert.deepEqual([coverSubtitleVideo.codec_name, coverSubtitleVideo.pix_fmt, coverSubtitleVideo.width, coverSubtitleVideo.height], ["h264", "yuv420p", 480, 360]);
    await admin.delete(`/api/media/sessions/${coverSubtitleSession.json.id}`);

    const graded = spawnSync("ffmpeg", [
      "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24,format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc",
      "-i", path.join(publicDir, "inner.sup"), "-t", "8", "-map", "0", "-map", "1", "-c:v", "libx264", "-c:s", "copy", hdrClip
    ]);
    assert.equal(graded.status, 0, String(graded.stderr));
    const hdrInfo = await admin.get("/api/media/info?rootSlug=photos&path=/public/hdr.mkv");
    assert.equal(hdrInfo.json.video.codec, "h264");
    assert.equal(hdrInfo.json.video.pixelFormat, "yuv420p10le");
    assert.equal(hdrInfo.json.video.hdr, "pq");
    assert.equal(info.json.video.hdr, null);
    const pictures = await admin.get("/api/media/subtitles?rootSlug=photos&path=/public/hdr.mkv");
    assert.deepEqual(pictures.json.tracks.map((item) => [item.id, item.format, item.stream, item.url]), [["stream:0", "pgs", 0, ""]]);
    assert.equal(pictures.json.unsupported, 0);
    assert.equal((await admin.get("/api/media/subtitle?rootSlug=photos&path=/public/hdr.mkv&index=0")).statusCode, 404);

    // Tone-mapped to SDR with the subtitle drawn in, the stream is the same H.264 in MPEG-TS as any other.
    const hdrSource = { rootSlug: "photos", path: "/public/hdr.mkv", height: 360 };
    assert.equal((await admin.post("/api/media/sessions", { ...hdrSource, subtitleIndex: 1 })).statusCode, 400);
    const burned = await admin.post("/api/media/sessions", { ...hdrSource, subtitleIndex: 0 });
    assert.equal(burned.json.hdr, false);
    const burnedSegment = await admin.get(`/api/media/sessions/${burned.json.id}/0.ts`);
    assert.equal(burnedSegment.statusCode, 200);
    assert.equal(burnedSegment.raw[0], 0x47);
    const normalized = spawnSync("ffprobe", [
      "-v", "error", "-show_streams",
      "-show_entries", "stream=codec_type,codec_name,pix_fmt,width,height",
      "-of", "json", "pipe:0"
    ], { input: burnedSegment.raw });
    assert.equal(normalized.status, 0, String(normalized.stderr));
    const normalizedVideo = JSON.parse(normalized.stdout).streams.find((stream) => stream.codec_type === "video");
    assert.ok(normalizedVideo, "the tone-mapped segment has video");
    assert.deepEqual(
      [normalizedVideo.codec_name, normalizedVideo.pix_fmt, normalizedVideo.width, normalizedVideo.height],
      ["h264", "yuv420p", 640, 360],
      "the session converts 10-bit H.264 into 8-bit H.264 for a browser-compatible output"
    );
    await admin.delete(`/api/media/sessions/${burned.json.id}`);

    // A picture subtitle lying next to the video is drawn in the same way, read as a second input.
    await writeFile(path.join(publicDir, "hdr.en.sup"), pgsSubtitle());
    await writeFile(path.join(publicDir, "hdr.ja.idx"), "# VobSub index file, v7 (do not modify this line!)\n");
    const beside = await admin.get("/api/media/subtitles?rootSlug=photos&path=/public/hdr.mkv");
    assert.deepEqual(
      beside.json.tracks.map((item) => [item.id, item.format, item.language, item.embedded, item.file, item.stream, item.url]),
      [
        ["file:/public/hdr.en.sup", "pgs", "en", false, "/public/hdr.en.sup", 0, ""],
        ["stream:0", "pgs", "", true, undefined, 0, ""]
      ],
      "an index without its .sub is not a subtitle"
    );
    assert.equal(beside.json.tracks.some((item) => "absolutePath" in item || "stat" in item), false);
    for (const subtitlePath of ["/public/readme.txt", "/public/inner.sup", "/public/hdr.ja.idx"]) {
      assert.equal((await admin.post("/api/media/sessions", { ...hdrSource, subtitleIndex: 0, subtitlePath })).statusCode, 400, subtitlePath);
    }
    assert.equal((await admin.post("/api/media/sessions", { ...hdrSource, subtitleIndex: 1, subtitlePath: "/public/hdr.en.sup" })).statusCode, 400);
    const besideSession = await admin.post("/api/media/sessions", { ...hdrSource, subtitleIndex: 0, subtitlePath: "/public/hdr.en.sup" });
    assert.equal(besideSession.statusCode, 200);
    assert.equal((await admin.get(`/api/media/sessions/${besideSession.json.id}/1.ts`)).statusCode, 200);
    await admin.delete(`/api/media/sessions/${besideSession.json.id}`);

    // For a screen that shows HDR it stays HDR: HEVC in fragmented MP4, where the server has an encoder for it.
    const kept = await admin.post("/api/media/sessions", { ...hdrSource, subtitleIndex: 0, hdr: true, lift: true });
    assert.equal(kept.json.hdr, hdrInfo.json.hdrOutput);
    if (kept.json.hdr) {
      const keptBase = `/api/media/sessions/${kept.json.id}`;
      const keptPlaylist = (await admin.get(`${keptBase}/index.m3u8`)).payload;
      assert.match(keptPlaylist, /#EXT-X-MAP:URI="init\.mp4"/);
      assert.deepEqual(keptPlaylist.split("\n").filter((line) => line.endsWith(".m4s")), ["0.m4s", "1.m4s"]);
      const init = await admin.get(`${keptBase}/init.mp4`);
      assert.equal(init.statusCode, 200);
      assert.equal(init.raw.subarray(4, 8).toString(), "ftyp");
      for (const index of [1, 0]) assert.equal((await admin.get(`${keptBase}/${index}.m4s`)).statusCode, 200);
    }
    await admin.delete(`/api/media/sessions/${kept.json.id}`);
    // An SDR picture has nothing to keep.
    const plain = await admin.post("/api/media/sessions", { rootSlug: "photos", path: "/public/clip.avi", height: 360, hdr: true });
    assert.equal(plain.json.hdr, false);
    await admin.delete(`/api/media/sessions/${plain.json.id}`);

    // Sessions belong to whoever opened them.
    await admin.post("/api/users", { email: "viewer@example.test", password: "fake-viewer-password-123", displayName: "Viewer", role: "USER" });
    const viewer = client(app);
    await viewer.post("/api/auth/login", { email: "viewer@example.test", password: "fake-viewer-password-123" });
    assert.equal((await viewer.get(`${base}/index.m3u8`)).statusCode, 404);
    assert.equal((await viewer.post(`${hoverBase}/prewarm`, { time: 0, revision: 1 })).statusCode, 404);
    assert.equal((await viewer.post("/api/media/sessions", { rootSlug: "photos", path: "/public/clip.avi", height: 360 })).statusCode, 403);

    assert.equal((await admin.delete(base)).statusCode, 200);
    assert.equal((await admin.delete(hoverBase)).statusCode, 200);
    assert.equal((await admin.get(`${base}/index.m3u8`)).statusCode, 404);
    const transcodeDir = path.join(fixture.appDataDir, "temp", "transcode");
    for (let tries = 0; tries < 40 && (await readdir(transcodeDir)).length > 0; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(await readdir(transcodeDir), []);
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("foreground preemption waits for the speculative child to close", async () => {
  const service = Object.create(MediaService.prototype);
  const child = new EventEmitter();
  child.closed = false;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = (signal) => {
    assert.equal(signal, "SIGKILL");
    setTimeout(() => {
      child.closed = true;
      child.signalCode = signal;
      child.emit("close", null, signal);
    }, 40);
    return true;
  };
  const session = { actorId: "test-actor", prewarmRevision: 1, prewarmIndex: 2 };
  const job = { sessionId: "speculative", actorId: "test-actor", index: 2, revision: 1, proc: child, cancelled: false };
  service.sessions = new Map([[job.sessionId, session]]);
  service.pendingPrewarms = new Map();
  service.activePrewarm = job;
  service.foregroundStarts = 0;
  service.pumpPrewarms = () => {
    assert.equal(service.foregroundStarts, 1, "the speculative queue stays blocked until its child closes");
    service.activePrewarm = null;
  };
  child.once("close", service.pumpPrewarms);

  let finished = false;
  const preemption = service.preemptSpeculation("foreground").then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(finished, false, "foreground startup waits for close, not just kill() returning");
  assert.equal(service.foregroundStarts, 1);
  assert.equal(service.pendingPrewarms.has(job.sessionId), true, "the latest hover can resume after foreground work ends");
  await preemption;
  assert.equal(finished, true);
  assert.equal(service.foregroundStarts, 0);
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
