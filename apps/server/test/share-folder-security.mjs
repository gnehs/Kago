import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildApp } from "../dist/app.js";
import { client } from "./helpers.mjs";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const CANARIES = ["outside canary", "sibling canary", "trash canary"];

test("a shared folder can be looked through and downloaded from, and nothing outside it can be reached", async () => {
  const fixture = await createFixture();
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);
  try {
    await app.ready();
    await setup(admin);
    const download = await share(admin, "/albums/trip", "download");
    assert.equal(download.statusCode, 200);
    assert.equal(download.json.kind, "folder");
    const visitor = await visit(app, download.json.token);

    // A folder share is known by its name; where it lies is not told.
    assert.deepEqual(Object.keys(visitor.info).sort(), ["authenticated", "id", "kind", "mode", "name", "requiresPassword"]);
    assert.equal(visitor.info.name, "trip");

    const top = await visitor.get("list");
    assert.equal(top.statusCode, 200);
    assert.equal(top.json.path, "/");
    assert.equal(top.json.name, "trip");
    assert.deepEqual(top.json.items.map((item) => item.name), ["day1", "many", "a.png", "Café.txt", "notes.md", "notes.txt", "report.docx"], "folders first, then by name; symlinks and system files are not listed");
    assert.deepEqual(top.json.items.find((item) => item.name === "day1"), { ...top.json.items.find((item) => item.name === "day1"), path: "/day1", kind: "folder", previewable: false });
    assert.equal(top.json.items.find((item) => item.name === "notes.txt").previewable, true);
    assert.equal(top.json.items.find((item) => item.name === "report.docx").previewable, false);
    assert.equal(top.json.items.some((item) => "tags" in item || "readonly" in item), false, "nobody's tags go out through a link");
    assert.ok(!top.payload.includes("albums") && !top.payload.includes(fixture.baseDir));

    const nested = await visitor.get("list", q("/day1/deep"));
    assert.equal(nested.json.path, "/day1/deep");
    assert.deepEqual(nested.json.items.map((item) => item.path), ["/day1/deep/c.txt"]);

    // Paged and sorted as the file browser sorts: numbers in names in their order.
    const pages = [];
    for (let offset = 0; ; offset += 10) {
      const page = await visitor.get("list", `${q("/many")}&offset=${offset}&limit=10`);
      assert.equal(page.statusCode, 200);
      assert.equal(page.json.total, 25);
      assert.equal(page.json.offset, offset);
      pages.push(...page.json.items);
      if (!page.json.hasMore) break;
    }
    assert.deepEqual(pages.map((item) => item.name), ["sub", ...Array.from({ length: 24 }, (_, index) => `img ${index + 1}.txt`)]);
    const bySize = await visitor.get("list", `${q("/many")}&sortBy=size&direction=desc&limit=3`);
    assert.deepEqual(bySize.json.items.map((item) => item.name), ["sub", "img 24.txt", "img 23.txt"], "folders stay first even backwards");
    assert.equal(bySize.json.hasMore, true);
    for (const bad of ["offset=-1", "limit=0", "limit=1001", "sortBy=path", "direction=up"]) assert.equal((await visitor.get("list", bad)).statusCode, 400, bad);

    assert.equal((await visitor.get("download", q("/day1/b.txt"))).payload, "day one");
    assert.equal((await visitor.get("download", q("/Café.txt".normalize("NFC")))).payload, "accented", "an NFC name reaches the NFD file on disk");
    assert.equal((await visitor.get("download", q("/day1"))).json.code, "NOT_FILE");
    assert.equal((await visitor.get("download")).json.code, "NOT_FILE", "the folder itself is not a file");
    assert.equal((await visitor.get("preview", q("/notes.txt"))).payload, "trip notes");
    assert.equal((await visitor.get("preview", q("/report.docx"))).statusCode, 415);
    assert.equal((await visitor.get("thumbnail", q("/a.png"))).statusCode, 200);
    assert.equal((await visitor.get("thumbnail", q("/notes.md"))).statusCode, 200, "a link that downloads may show any file's icon");
    assert.equal((await visitor.get("thumbnail", q("/day1"))).json.code, "NO_THUMBNAIL");

    const zip = await visitor.get("zip");
    assert.equal(zip.statusCode, 200);
    assert.match(zip.headers["content-disposition"], /filename="trip\.zip"/);
    const names = zipNames(zip.raw);
    for (const name of ["trip/", "trip/notes.txt", "trip/day1/b.txt", "trip/day1/deep/c.txt", "trip/many/img 24.txt"]) assert.ok(names.includes(name), name);
    assert.ok(names.every((name) => name.startsWith("trip/")));
    assert.ok(!names.some((name) => /\.DS_Store|\._a\.png|link-/i.test(name)), "what the listing leaves out stays out of the archive");
    assert.ok(zip.raw.includes(Buffer.from("trip notes")), "files are stored as they are");
    for (const canary of CANARIES) assert.ok(!zip.raw.includes(Buffer.from(canary)), canary);
    const part = await visitor.get("zip", q("/day1"));
    assert.match(part.headers["content-disposition"], /filename="day1\.zip"/);
    assert.deepEqual(zipNames(part.raw).sort(), ["day1/", "day1/b.txt", "day1/deep/", "day1/deep/c.txt"]);
    assert.equal((await visitor.get("zip", q("/notes.txt"))).json.code, "NOT_FOLDER");

    // Every way out of the folder fails, for every route, and says nothing of what it found.
    const attacks = [
      q("../outside.txt"), q("/../outside.txt"), "path=..%2Foutside.txt", "path=%2e%2e%2Foutside.txt", "path=%252e%252e%252Foutside.txt",
      q("..\\outside.txt"), q("/day1/..\\..\\outside.txt"), q("day1/../../outside.txt"), q("/day1/../../trip-secret/secret.txt"),
      q("/link-out"), q("/link-dir"), q("/link-dir/outside.txt"), q("/link-dir/trip-secret/secret.txt"),
      q(path.join(fixture.dataDir, "photos", "outside.txt")), q("//outside.txt"), q("/etc/passwd"), "path=%00", q("/notes.txt\0.png"),
      q("/.DS_Store"), q("/.ds_store"), q("/._a.png"), q("/day1/Thumbs.db"), q("/.kago-trash"), q("/.KAGO-TRASH/gone.txt"),
      q("/..."), q("/.. "), q("/. /notes.txt"), q("/day1/deep/.."), q("/DAY1/../../outside.txt")
    ];
    for (const route of ["list", "download", "preview", "thumbnail", "zip"]) {
      for (const attack of attacks) {
        const response = await visitor.get(route, attack);
        assert.ok([400, 403, 404].includes(response.statusCode), `${route}?${attack} gave ${response.statusCode}`);
        for (const canary of CANARIES) assert.ok(!response.payload.includes(canary), `${route}?${attack} leaked ${canary}`);
        assert.ok(!response.payload.includes(fixture.baseDir) && !response.payload.includes("albums"), `${route}?${attack} told where the folder lies`);
      }
    }
    // A disk that ignores case finds a folder under any case, and it is still the one inside.
    const anyCase = await visitor.get("download", q("/DAY1/b.txt"));
    assert.ok(anyCase.statusCode === 404 || anyCase.payload === "day one");

    // Files and archives are written down; listings, previews and icons are not.
    const audit = (await admin.get("/api/audit?limit=500")).json.filter((entry) => entry.actor_type === "share_link" && entry.actor_id === download.json.id);
    const rows = (await Promise.all(audit.map(async (entry) => (entry.burst ? (await admin.get(`/api/audit/runs/${entry.burst.id}`)).json : [entry])))).flat();
    assert.deepEqual([...new Set(rows.map((entry) => entry.action))].sort(), ["download_via_share", "download_zip_via_share"]);
    assert.ok(rows.some((entry) => entry.action === "download_via_share" && entry.path === "/albums/trip/day1/b.txt"));
    assert.ok(rows.some((entry) => entry.action === "download_zip_via_share" && entry.path === "/albums/trip/day1"));
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("a folder shared for viewing shows what a file shared for viewing would, and gives nothing to download", async () => {
  const fixture = await createFixture();
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);
  try {
    await app.ready();
    await setup(admin);
    const view = await share(admin, "/albums/trip", "view_only");
    assert.equal(view.statusCode, 200);
    const visitor = await visit(app, view.json.token);
    assert.equal((await visitor.get("list")).statusCode, 200);
    assert.equal((await visitor.get("preview", q("/notes.txt"))).payload, "trip notes");
    assert.equal((await visitor.get("preview", q("/a.png"))).statusCode, 200);
    assert.equal((await visitor.get("preview", q("/report.docx"))).json.code, "PREVIEW_UNSUPPORTED");
    assert.equal((await visitor.get("thumbnail", q("/a.png"))).statusCode, 200);
    assert.equal((await visitor.get("thumbnail", q("/notes.md"))).json.code, "NO_THUMBNAIL", "what the preview would not send has no icon either");
    for (const [route, query] of [["download", q("/notes.txt")], ["download", ""], ["zip", ""], ["zip", q("/day1")]]) {
      const refused = await visitor.get(route, query);
      assert.equal(refused.statusCode, 403, `${route} ${query}`);
      assert.equal(refused.json.code, "SHARE_DOWNLOAD_FORBIDDEN");
    }
    assert.equal((await admin.get("/api/shares")).json.find((item) => item.id === view.json.id).download_count, 1, "one person looked");
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("a folder share's password, expiry, switch, visitor limit and creator hold on every route", async () => {
  const fixture = await createFixture();
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);
  try {
    await app.ready();
    await setup(admin);
    const root = (await admin.get("/api/roots")).json[0];
    const routes = [["list", ""], ["download", q("/notes.txt")], ["preview", q("/notes.txt")], ["thumbnail", q("/a.png")], ["zip", q("/day1")]];
    const everyRoute = async (visitor, status, code) => {
      for (const [route, query] of routes) {
        const response = await visitor.get(route, query);
        assert.equal(response.statusCode, status, `${route}: ${response.payload.slice(0, 200)}`);
        if (code) assert.equal(response.json.code, code, route);
      }
    };

    const locked = await share(admin, "/albums/trip", "download", { password: "fake-share-password" });
    const stranger = await visit(app, locked.json.token);
    assert.deepEqual(Object.keys(stranger.info).sort(), ["authenticated", "id", "mode", "requiresPassword"], "nothing of the folder before the password");
    await everyRoute(stranger, 401, "SHARE_PASSWORD_REQUIRED");
    assert.equal((await stranger.post("auth", { password: "fake-share-password" })).statusCode, 200);
    await everyRoute(stranger, 200);

    const owner = await addUser(app, admin, root, "owner");
    const owned = await share(owner.api, "/albums/trip", "download");
    assert.equal(owned.statusCode, 200);
    const guest = await visit(app, owned.json.token);
    await everyRoute(guest, 200);
    assert.equal((await admin.put("/api/permissions", { principalType: "user", principalId: owner.id, rootId: root.id, level: null })).statusCode, 200);
    await everyRoute(guest, 403, "FORBIDDEN");

    assert.equal((await admin.patch(`/api/shares/${locked.json.id}`, { expiresAt: Math.floor(Date.now() / 1000) - 60 })).statusCode, 200);
    await everyRoute(stranger, 410, "SHARE_EXPIRED");
    assert.equal((await admin.patch(`/api/shares/${locked.json.id}`, { disabled: true })).statusCode, 200);
    await everyRoute(stranger, 404, "SHARE_NOT_FOUND");

    // The limit is on people: one who has been counted may go on looking and downloading, someone else may not start.
    const limited = await share(admin, "/albums/trip", "download", { maxDownloads: 1 });
    const first = await visit(app, limited.json.token);
    await everyRoute(first, 200);
    await everyRoute(first, 200);
    assert.equal((await admin.get("/api/shares")).json.find((item) => item.id === limited.json.id).download_count, 1);
    const second = await visit(app, limited.json.token, "203.0.113.9");
    assert.equal(second.infoStatus, 410);
    await everyRoute(second, 410, "SHARE_LIMIT_REACHED");
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("a file share and an upload-only folder are what they were", async () => {
  const fixture = await createFixture();
  const app = await buildApp(testEnv(fixture));
  const admin = client(app);
  try {
    await app.ready();
    await setup(admin);
    const file = await share(admin, "/albums/trip/notes.txt", "download");
    assert.equal(file.json.kind, "file");
    const fileVisitor = await visit(app, file.json.token);
    assert.equal(fileVisitor.info.path, "/albums/trip/notes.txt");
    assert.equal(fileVisitor.info.size, "trip notes".length);
    assert.equal((await fileVisitor.get("download")).payload, "trip notes");
    assert.equal((await fileVisitor.get("preview")).payload, "trip notes");
    assert.equal((await fileVisitor.get("download", q("/"))).payload, "trip notes");
    for (const attack of [q("/other.txt"), q("../a.png"), q("/notes.txt")]) assert.equal((await fileVisitor.get("download", attack)).statusCode, attack.includes("..") ? 400 : 404, attack);
    for (const route of ["list", "zip"]) assert.equal((await fileVisitor.get(route)).json.code, "SHARE_TARGET_NOT_FOLDER", route);

    const dropBox = await share(admin, "/albums/trip", "upload_only");
    assert.equal(dropBox.json.kind, "folder");
    const dropVisitor = await visit(app, dropBox.json.token);
    assert.equal(dropVisitor.info.path, "/albums/trip");
    for (const [route, code] of [["list", "SHARE_LIST_FORBIDDEN"], ["download", "SHARE_DOWNLOAD_FORBIDDEN"], ["zip", "SHARE_DOWNLOAD_FORBIDDEN"], ["preview", "SHARE_PREVIEW_FORBIDDEN"], ["thumbnail", "SHARE_PREVIEW_FORBIDDEN"]]) {
      const refused = await dropVisitor.get(route, q("/notes.txt"));
      assert.equal(refused.statusCode, 403, route);
      assert.equal(refused.json.code, code, route);
    }
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("a visitor's archive is refused up front when too large, and only a few are written at once", async () => {
  const fixture = await createFixture();
  const big = path.join(fixture.dataDir, "photos", "big");
  await mkdir(path.join(big, "huge"), { recursive: true });
  await mkdir(path.join(big, "wide"), { recursive: true });
  await mkdir(path.join(big, "slow"), { recursive: true });
  // Sparse, so the disk holds next to nothing of them.
  await writeFile(path.join(big, "huge", "disk.img"), "");
  await truncate(path.join(big, "huge", "disk.img"), 33 * 1024 ** 3);
  await writeFile(path.join(big, "slow", "film.bin"), "");
  await truncate(path.join(big, "slow", "film.bin"), 512 * 1024 ** 2);
  for (let start = 0; start < 20_001; start += 500) {
    await Promise.all(Array.from({ length: Math.min(500, 20_001 - start) }, (_, index) => mkdir(path.join(big, "wide", `d${start + index}`))));
  }

  const app = await buildApp(testEnv(fixture));
  const admin = client(app);
  try {
    await app.ready();
    await setup(admin);
    const link = await share(admin, "/big", "download");
    const visitor = await visit(app, link.json.token);
    for (const folder of ["/huge", "/wide"]) {
      const refused = await visitor.get("zip", q(folder));
      assert.equal(refused.statusCode, 413, folder);
      assert.equal(refused.json.code, "SHARE_ZIP_TOO_LARGE");
    }
    assert.equal((await visitor.get("list", q("/wide"))).json.total, 20_001, "too many for one archive is not too many to look through");

    await app.listen({ host: "127.0.0.1", port: 0 });
    const { port } = app.server.address();
    const stalled = [];
    const start = () => new Promise((resolve, reject) => {
      const request = http.get({ host: "127.0.0.1", port, path: `/s/${link.json.token}/zip?${q("/slow")}`, headers: { cookie: visitor.cookie } }, (response) => {
        response.pause();
        stalled.push(request);
        resolve(response.statusCode);
      });
      request.on("error", reject);
    });
    assert.equal(await start(), 200);
    assert.equal(await start(), 200);
    const third = await visitor.get("zip", q("/slow"));
    assert.equal(third.statusCode, 429);
    assert.equal(third.json.code, "SHARE_ZIP_BUSY");
    for (const request of stalled) request.destroy();
    let freed;
    for (let attempt = 0; attempt < 100 && freed !== 200; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      freed = (await visitor.get("zip", q("/huge"))).statusCode === 413 ? 200 : 429;
    }
    assert.equal(freed, 200, "an archive given up on frees its place");
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

test("links made before folders could be looked through are upgraded in place", async () => {
  const fixture = await createFixture();
  let app = await buildApp(testEnv(fixture));
  let admin = client(app);
  try {
    await app.ready();
    await setup(admin);
    const file = await share(admin, "/albums/trip/notes.txt", "view_only");
    const dropBox = await share(admin, "/albums/trip", "upload_only");
    await app.close();
    const db = new DatabaseSync(path.join(fixture.appDataDir, "app.db"));
    db.exec("ALTER TABLE share_links DROP COLUMN kind");
    db.close();
    app = await buildApp(testEnv(fixture));
    await app.ready();
    admin = client(app);
    assert.equal((await admin.post("/api/auth/login", { email: "admin@example.test", password: "fake-admin-password-123" })).statusCode, 200);
    const listed = (await admin.get("/api/shares")).json;
    assert.equal(listed.find((item) => item.id === file.json.id).kind, "file");
    assert.equal(listed.find((item) => item.id === dropBox.json.id).kind, "folder");
    assert.equal((await (await visit(app, file.json.token)).get("preview")).payload, "trip notes");
  } finally {
    await app.close();
    await rm(fixture.baseDir, { recursive: true, force: true });
  }
});

const q = (value) => `path=${encodeURIComponent(value)}`;

function share(api, sharePath, mode, extra = {}) {
  return api.post("/api/shares", { rootSlug: "photos", path: sharePath, mode, ...extra });
}

async function setup(admin) {
  assert.equal((await admin.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" })).statusCode, 200);
}

async function addUser(app, admin, root, name) {
  const created = await admin.post("/api/users", { email: `${name}@example.test`, password: `fake-${name}-password-123`, displayName: name, role: "USER" });
  assert.equal(created.statusCode, 200);
  assert.equal((await admin.put("/api/permissions", { principalType: "user", principalId: created.json.id, rootId: root.id, level: "view" })).statusCode, 200);
  const api = client(app);
  assert.equal((await api.post("/api/auth/login", { email: `${name}@example.test`, password: `fake-${name}-password-123` })).statusCode, 200);
  return { api, id: created.json.id };
}

/** Someone who opens the link: the page asks what it is first, and is given the visit's cookie. */
async function visit(app, token, remoteAddress = "198.51.100.7") {
  let cookie = "";
  const keep = (response) => {
    const values = response.headers["set-cookie"];
    for (const value of Array.isArray(values) ? values : values ? [values] : []) {
      const pair = value.split(";", 1)[0];
      const [name] = pair.split("=");
      cookie = cookie.split("; ").filter((item) => item && !item.startsWith(`${name}=`)).concat(pair).join("; ");
    }
  };
  const send = async (method, url, body) => {
    const headers = { accept: "application/json", ...(cookie ? { cookie } : {}) };
    if (body !== undefined) Object.assign(headers, { "content-type": "application/json", "x-kago-csrf": "1" });
    const response = await app.inject({ method, url, headers, remoteAddress, payload: body === undefined ? undefined : JSON.stringify(body) });
    keep(response);
    const json = String(response.headers["content-type"] ?? "").includes("application/json") && response.payload ? JSON.parse(response.payload) : null;
    return { statusCode: response.statusCode, headers: response.headers, payload: response.payload, raw: response.rawPayload, json };
  };
  const info = await send("GET", `/s/${token}`);
  return {
    info: info.json,
    infoStatus: info.statusCode,
    get cookie() {
      return cookie;
    },
    get: (route, query = "") => send("GET", `/s/${token}/${route}${query ? `?${query}` : ""}`),
    post: (route, body) => send("POST", `/s/${token}/${route}`, body)
  };
}

/** The names in a zip's central directory. */
function zipNames(buffer) {
  const names = [];
  for (let at = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); at !== -1; at = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), at + 4)) {
    const nameLength = buffer.readUInt16LE(at + 28);
    names.push(buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8"));
  }
  return names;
}

function testEnv(fixture) {
  return { port: 0, dataDir: fixture.dataDir, appDataDir: fixture.appDataDir, sessionSecret: "share-folder-test-session-secret", nodeEnv: "test" };
}

async function createFixture() {
  const baseDir = await mkdtemp(path.join(tmpdir(), "kago-share-folder."));
  const dataDir = path.join(baseDir, "data");
  const appDataDir = path.join(baseDir, "app-data");
  const photos = path.join(dataDir, "photos");
  const trip = path.join(photos, "albums", "trip");
  await mkdir(path.join(trip, "day1", "deep"), { recursive: true });
  await mkdir(path.join(trip, "many", "sub"), { recursive: true });
  await mkdir(path.join(photos, "albums", "trip-secret"), { recursive: true });
  await mkdir(path.join(photos, ".kago-trash"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(photos, "outside.txt"), "outside canary");
  await writeFile(path.join(photos, "albums", "trip-secret", "secret.txt"), "sibling canary");
  await writeFile(path.join(photos, ".kago-trash", "gone.txt"), "trash canary");
  await writeFile(path.join(trip, "notes.txt"), "trip notes");
  await writeFile(path.join(trip, "notes.md"), "# trip notes in markdown");
  await writeFile(path.join(trip, "report.docx"), "not really a document");
  await writeFile(path.join(trip, "a.png"), PNG);
  await writeFile(path.join(trip, "Café.txt".normalize("NFD")), "accented");
  await writeFile(path.join(trip, ".DS_Store"), "outside canary");
  await writeFile(path.join(trip, "._a.png"), "outside canary");
  await writeFile(path.join(trip, "day1", "b.txt"), "day one");
  await writeFile(path.join(trip, "day1", "Thumbs.db"), "outside canary");
  await writeFile(path.join(trip, "day1", "deep", "c.txt"), "deep");
  for (let index = 1; index <= 24; index += 1) await writeFile(path.join(trip, "many", `img ${index}.txt`), "x".repeat(index));
  await symlink(path.join(photos, "outside.txt"), path.join(trip, "link-out"));
  await symlink(path.join(photos, "albums"), path.join(trip, "link-dir"));
  return { baseDir, dataDir, appDataDir };
}
