// Remote locations and sync, against a real remote. Needs rclone on the PATH and somewhere to connect to:
//
//   KAGO_TEST_REMOTE='{"type":"smb","base":"share","params":{"host":"nas","user":"kago","pass":"..."}}' pnpm test:remote
//
// KAGO_TEST_SERVER takes the same without `base`, for the test of a whole SMB server added as one location.
// The folder `base` names is filled with test files and left clean.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import AdmZip from "adm-zip";
import { buildApp } from "../dist/app.js";
import { nextRun } from "../dist/services/sync.service.js";

const remote = process.env.KAGO_TEST_REMOTE ? JSON.parse(process.env.KAGO_TEST_REMOTE) : null;
const port = Number(process.env.KAGO_TEST_PORT ?? 18999);

test("a schedule comes round at the next matching moment", () => {
  const at = (text) => Math.floor(new Date(text).getTime() / 1000);
  const from = new Date("2026-10-07T10:30:00"); // a Wednesday
  assert.equal(nextRun({ kind: "interval", minutes: 15 }, from), at("2026-10-07T10:45:00"));
  assert.equal(nextRun({ kind: "daily", time: "12:00" }, from), at("2026-10-07T12:00:00"));
  assert.equal(nextRun({ kind: "daily", time: "10:30" }, from), at("2026-10-08T10:30:00"));
  assert.equal(nextRun({ kind: "weekly", weekday: 3, time: "09:00" }, from), at("2026-10-14T09:00:00"));
  assert.equal(nextRun({ kind: "weekly", weekday: 5, time: "09:00" }, from), at("2026-10-09T09:00:00"));
});

test("a remote location behaves like a local one", { skip: remote ? false : "KAGO_TEST_REMOTE is not set" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kago-remote."));
  const dataDir = path.join(dir, "data");
  const appDataDir = path.join(dir, "app-data");
  await mkdir(path.join(dataDir, "local", "album", "nested"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(dataDir, "local", "album", "one.txt"), "one");
  await writeFile(path.join(dataDir, "local", "album", "nested", "two.txt"), "two two");
  const app = await buildApp({ port, dataDir, appDataDir, sessionSecret: "remote-test-session-secret", nodeEnv: "test" });
  // ffmpeg reads remote files back from the server itself, so it has to be listening.
  await app.listen({ host: "127.0.0.1", port });
  const api = client(`http://127.0.0.1:${port}`);
  let rootId;

  try {
    assert.equal((await api.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" })).status, 200);
    const storage = await api.get("/api/storage");
    assert.equal(storage.json.available, true, "rclone has to be installed");
    assert.ok(storage.json.providers.some((provider) => provider.type === remote.type));

    // A wrong secret is refused with the remote's own reason; the right one connects.
    const secret = storage.json.providers.find((provider) => provider.type === remote.type).fields.find((field) => field.kind === "secret" && remote.params[field.key]);
    if (secret) {
      const wrong = await api.post("/api/storage/test", { config: { ...remote, params: { ...remote.params, [secret.key]: "definitely-wrong" } } });
      assert.equal(wrong.json.ok, false);
      assert.ok(wrong.json.error);
    }
    assert.deepEqual((await api.post("/api/storage/test", { config: remote })).json, { ok: true });

    // Everything happens inside a folder of its own, so the remote is left as it was found.
    const sandbox = `kago-test-${Date.now()}`;
    const outer = await api.post("/api/roots/remote", { name: "Outer", config: remote });
    assert.equal(outer.status, 200, outer.text);
    assert.equal((await api.post("/api/fs/mkdir", { rootSlug: outer.json.slug, path: "/", name: sandbox })).status, 200);
    const created = await api.post("/api/roots/remote", { name: "遠端 NAS", config: { ...remote, base: `${remote.base}/${sandbox}` } });
    assert.equal(created.status, 200, created.text);
    rootId = created.json.id;
    const slug = created.json.slug;
    assert.equal(created.json.provider, remote.type);
    if (secret) {
      assert.equal(created.json.remote.params[secret.key], undefined, "secrets never come back");
      assert.deepEqual(created.json.remote.secrets, [secret.key]);
      const stored = new DatabaseSync(path.join(appDataDir, "app.db"), { readOnly: true });
      assert.ok(!String(stored.prepare("SELECT config FROM roots WHERE id = ?").get(rootId).config).includes(remote.params[secret.key]), "secrets are sealed in the database");
      stored.close();
    }
    const roots = await api.get("/api/roots");
    assert.deepEqual(roots.json.map((root) => root.provider).sort(), ["local", remote.type, remote.type].sort());
    assert.ok(roots.json.every((root) => !("config" in root) && !("base_path" in root)));
    // The connection can be saved again without typing its secrets, and under another name.
    const here = { ...remote, base: `${remote.base}/${sandbox}` };
    const renamed = await api.put(`/api/roots/${rootId}/remote`, { name: "NAS", config: { ...here, params: { ...here.params, ...(secret ? { [secret.key]: "" } : {}) } } });
    assert.equal(renamed.status, 200, renamed.text);
    assert.equal(renamed.json.name, "NAS");
    assert.equal(renamed.json.slug, slug, "the address of a location outlives its name");
    assert.equal((await api.get(`/api/fs/list?rootSlug=${slug}&path=/`)).status, 200);
    // A change counts from the moment it is saved, even for a remote that was already in use.
    if (secret) {
      assert.equal((await api.put(`/api/roots/${rootId}/remote`, { config: { ...here, params: { ...here.params, [secret.key]: "definitely-wrong" } } })).status, 200);
      assert.equal((await api.get(`/api/fs/list?rootSlug=${slug}&path=/`)).status, 502);
      assert.equal((await api.put(`/api/roots/${rootId}/remote`, { config: here })).status, 200);
    }

    // Folders and files.
    assert.deepEqual((await api.get(`/api/fs/list?rootSlug=${slug}&path=/`)).json.items, []);
    assert.equal((await api.post("/api/fs/mkdir", { rootSlug: slug, path: "/", name: "文件 夾" })).status, 200);
    assert.equal((await api.post("/api/fs/mkdir", { rootSlug: slug, path: "/", name: "文件 夾" })).status, 409);
    const uploaded = await api.upload(slug, "/文件 夾", "hello.txt", "hello remote world\n");
    assert.equal(uploaded.status, 200, uploaded.text);
    assert.equal((await api.upload(slug, "/文件 夾", "hello.txt", "again")).status, 409, "an upload never replaces a file");
    const listing = await api.get(`/api/fs/list?rootSlug=${slug}&path=${encodeURIComponent("/文件 夾")}`);
    assert.deepEqual(listing.json.items.map((item) => [item.name, item.kind, item.size]), [["hello.txt", "file", 19]]);
    const filePath = "/文件 夾/hello.txt";
    const q = (p) => `rootSlug=${slug}&path=${encodeURIComponent(p)}`;
    assert.equal((await api.get(`/api/fs/meta?${q(filePath)}`)).json.type, "text/plain");
    assert.equal((await api.get(`/api/fs/meta?${q("/nope.txt")}`)).status, 404);
    assert.equal((await api.get(`/api/fs/list?${q("/.kago-trash")}`)).status, 404);
    assert.equal((await api.get(`/api/fs/list?${q("/../")}`)).status, 400);

    // Reading, whole and in part.
    const whole = await api.get(`/api/fs/preview?${q(filePath)}`);
    assert.equal(whole.text, "hello remote world\n");
    const part = await api.get(`/api/fs/preview?${q(filePath)}`, { Range: "bytes=6-11" });
    assert.equal(part.status, 206);
    assert.equal(part.text, "remote");
    assert.equal(part.headers.get("content-range"), "bytes 6-11/19");
    const download = await api.get(`/api/fs/download?${q(filePath)}`);
    assert.match(download.headers.get("content-disposition"), /hello\.txt/);
    assert.equal((await api.get(`/api/fs/thumbnail?${q(filePath)}`)).text, "hello remote world\n");

    // Editing in place, with the check that nobody else changed the file.
    const before = (await api.get(`/api/fs/meta?${q(filePath)}`)).json.mtime;
    assert.equal((await api.put("/api/fs/content", { rootSlug: slug, path: filePath, content: "edited", mtime: before - 5000 })).status, 409);
    assert.equal((await api.put("/api/fs/content", { rootSlug: slug, path: filePath, content: "edited", mtime: before })).status, 200);
    assert.equal((await api.get(`/api/fs/preview?${q(filePath)}`)).text, "edited");

    // Renaming a file and a folder.
    assert.equal((await api.post("/api/fs/rename", { rootSlug: slug, path: filePath, name: "renamed.txt" })).status, 200);
    assert.equal((await api.post("/api/fs/rename", { rootSlug: slug, path: "/文件 夾", name: "docs" })).status, 200);
    assert.equal((await api.get(`/api/fs/preview?${q("/docs/renamed.txt")}`)).text, "edited");
    assert.equal((await api.put("/api/fs/finder-tags", { rootSlug: slug, path: "/docs/renamed.txt", tags: [] })).json.code, "FINDER_TAGS_UNSUPPORTED");

    // Pictures and video: thumbnails, shooting data and transcoding all read the remote file.
    const media = path.join(dir, "media");
    await mkdir(media);
    assert.equal(spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=1", "-frames:v", "1", path.join(media, "picture.png")]).status, 0);
    assert.equal(spawnSync("ffmpeg", ["-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440", "-t", "14", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", path.join(media, "clip.mkv")]).status, 0);
    assert.equal((await api.upload(slug, "/docs", "picture.png", await readFile(path.join(media, "picture.png")))).status, 200);
    assert.equal((await api.upload(slug, "/docs", "clip.mkv", await readFile(path.join(media, "clip.mkv")))).status, 200);
    const pictureThumb = await api.get(`/api/fs/thumbnail?${q("/docs/picture.png")}`);
    assert.equal(pictureThumb.status, 200);
    assert.ok(["image/avif", "image/png"].includes(pictureThumb.headers.get("content-type")));
    assert.equal((await api.get(`/api/fs/exif?${q("/docs/picture.png")}`)).json.width, 320);
    const info = await api.get(`/api/media/info?${q("/docs/clip.mkv")}`);
    assert.equal(info.status, 200, info.text);
    assert.equal(info.json.video.width, 640);
    assert.ok(Math.abs(info.json.duration - 14) < 1);
    const videoThumb = await api.get(`/api/fs/thumbnail?${q("/docs/clip.mkv")}`);
    assert.equal(videoThumb.headers.get("content-type"), "image/avif");
    if (info.json.transcode) {
      const session = await api.post("/api/media/sessions", { rootSlug: slug, path: "/docs/clip.mkv", height: info.json.qualities[0] });
      assert.equal(session.status, 200, session.text);
      const segment = await api.get(`/api/media/sessions/${session.json.id}/1.ts`);
      assert.equal(segment.status, 200);
      assert.equal(segment.bytes[0], 0x47, "segments are MPEG-TS");
      await api.delete(`/api/media/sessions/${session.json.id}`);
    }
    // The address ffmpeg reads from answers nobody without the signature for that file.
    assert.equal((await api.get(`/api/internal/blob/${rootId}/${"0".repeat(64)}/docs/clip.mkv`)).status, 404);

    // A database is fetched before it is opened.
    const dbFile = path.join(media, "notes.sqlite");
    const db = new DatabaseSync(dbFile);
    db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT); INSERT INTO notes (body) VALUES ('from afar');");
    db.close();
    assert.equal((await api.upload(slug, "/docs", "notes.sqlite", await readFile(dbFile))).status, 200);
    assert.deepEqual((await api.get(`/api/fs/sqlite?${q("/docs/notes.sqlite")}`)).json.tables.map((table) => table.name), ["notes"]);
    assert.equal((await api.get(`/api/fs/sqlite/rows?${q("/docs/notes.sqlite")}&table=notes`)).json.rows[0][1], "from afar");

    // Copying and moving, in every direction.
    const task = async (body) => {
      const created = await api.post("/api/tasks", body);
      assert.equal(created.status, 200, created.text);
      return waitTask(api, created.json.id);
    };
    assert.equal((await task({ type: "copy", sources: [{ rootSlug: "local", path: "/album" }], destination: { rootSlug: slug, path: "/" } })).status, "done");
    assert.equal((await api.get(`/api/fs/preview?${q("/album/nested/two.txt")}`)).text, "two two");
    const again = await task({ type: "copy", sources: [{ rootSlug: "local", path: "/album" }], destination: { rootSlug: slug, path: "/" } });
    assert.equal(again.error_message, "Target already exists");
    assert.equal((await task({ type: "copy", sources: [{ rootSlug: slug, path: "/docs" }], destination: { rootSlug: "local", path: "/" } })).status, "done");
    assert.equal(await readFile(path.join(dataDir, "local", "docs", "renamed.txt"), "utf8"), "edited");
    assert.equal((await task({ type: "copy", sources: [{ rootSlug: slug, path: "/docs/renamed.txt" }], destination: { rootSlug: slug, path: "/album" } })).status, "done");
    assert.equal((await task({ type: "move", sources: [{ rootSlug: slug, path: "/album/nested" }], destination: { rootSlug: slug, path: "/docs" } })).status, "done");
    assert.equal((await api.get(`/api/fs/preview?${q("/docs/nested/two.txt")}`)).text, "two two");
    assert.equal((await api.get(`/api/fs/meta?${q("/album/nested")}`)).status, 404);
    assert.equal((await task({ type: "move", sources: [{ rootSlug: slug, path: "/album/one.txt" }], destination: { rootSlug: "local", path: "/" } })).status, "done");
    assert.equal(await readFile(path.join(dataDir, "local", "one.txt"), "utf8"), "one");
    // A folder moved between locations leaves nothing where it was, not even itself.
    assert.equal((await task({ type: "move", sources: [{ rootSlug: "local", path: "/docs" }], destination: { rootSlug: slug, path: "/album" } })).status, "done");
    assert.equal((await api.get(`/api/fs/preview?${q("/album/docs/renamed.txt")}`)).text, "edited");
    assert.deepEqual((await readdir(path.join(dataDir, "local"))).sort(), ["album", "one.txt"]);
    assert.equal((await task({ type: "move", sources: [{ rootSlug: slug, path: "/album/docs" }], destination: { rootSlug: "local", path: "/" } })).status, "done");
    assert.equal(await readFile(path.join(dataDir, "local", "docs", "renamed.txt"), "utf8"), "edited");
    assert.equal((await api.get(`/api/fs/meta?${q("/album/docs")}`)).status, 404);
    assert.equal((await api.post("/api/tasks", { type: "copy", sources: [{ rootSlug: slug, path: "/docs" }], destination: { rootSlug: slug, path: "/docs/nested" } })).status, 409);

    // The trash of a remote location is on the remote, out of sight.
    assert.equal((await task({ type: "delete_to_trash", sources: [{ rootSlug: slug, path: "/docs/nested" }, { rootSlug: slug, path: "/album/renamed.txt" }] })).status, "done");
    assert.equal((await api.get(`/api/fs/meta?${q("/docs/nested")}`)).status, 404);
    assert.deepEqual((await api.get(`/api/fs/list?${q("/")}`)).json.items.map((item) => item.name).sort(), ["album", "docs"]);
    const trash = await api.get("/api/trash");
    assert.equal(trash.json.length, 2);
    const folderItem = trash.json.find((item) => item.original_path === "/docs/nested");
    const restore = await api.post(`/api/trash/${folderItem.id}/restore`);
    assert.equal((await waitTask(api, restore.json.id)).status, "done");
    assert.equal((await api.get(`/api/fs/preview?${q("/docs/nested/two.txt")}`)).text, "two two");
    assert.equal((await api.delete("/api/trash")).json.deleted, 1);
    assert.deepEqual((await api.get(`/api/fs/list?rootSlug=${outer.json.slug}&path=${encodeURIComponent(`/${sandbox}/.kago-trash`)}`)).json.items, [], "emptying the trash removes what it held");

    // Archives: made from remote files, kept on the remote, and unpacked there.
    assert.equal((await task({ type: "compress", sources: [{ rootSlug: slug, path: "/docs/nested" }, { rootSlug: "local", path: "/one.txt" }], destination: { rootSlug: slug, path: "/bundle.zip" } })).status, "done");
    const bundle = new AdmZip((await api.get(`/api/fs/download?${q("/bundle.zip")}`)).bytes);
    assert.deepEqual(bundle.getEntries().map((entry) => entry.entryName).sort(), ["nested/", "nested/two.txt", "one.txt"]);
    assert.equal(bundle.readAsText("nested/two.txt"), "two two");
    assert.equal((await api.post("/api/fs/mkdir", { rootSlug: slug, path: "/", name: "unpacked" })).status, 200);
    assert.equal((await task({ type: "extract", sources: [{ rootSlug: slug, path: "/bundle.zip" }], destination: { rootSlug: slug, path: "/unpacked" } })).status, "done");
    assert.equal((await api.get(`/api/fs/preview?${q("/unpacked/nested/two.txt")}`)).text, "two two");
    const streamed = new AdmZip((await api.get(`/api/fs/download-zip?rootSlug=${slug}&path=${encodeURIComponent("/unpacked")}`)).bytes);
    assert.deepEqual(streamed.getEntries().map((entry) => entry.entryName).sort(), ["unpacked/", "unpacked/nested/", "unpacked/nested/two.txt", "unpacked/one.txt"]);

    // Share links reach into a remote location like any other.
    const share = await api.post("/api/shares", { rootSlug: slug, path: "/docs/renamed.txt", mode: "download" });
    assert.equal(share.status, 200, share.text);
    const visitor = client(`http://127.0.0.1:${port}`);
    assert.equal((await visitor.get(`/s/${share.json.token}/download`)).text, "edited");
    const inbox = await api.post("/api/shares", { rootSlug: slug, path: "/unpacked", mode: "upload_only" });
    assert.equal((await visitor.shareUpload(inbox.json.token, "gift.txt", "for you")).status, 200);
    assert.equal((await api.get(`/api/fs/preview?${q("/unpacked/gift.txt")}`)).text, "for you");

    // A read-only location refuses every change.
    assert.equal((await api.patch(`/api/roots/${rootId}`, { readonly: true })).status, 200);
    assert.equal((await api.upload(slug, "/docs", "no.txt", "no")).status, 403);
    assert.equal((await api.patch(`/api/roots/${rootId}`, { readonly: false })).status, 200);

    // Sync: copy adds, mirror also removes, a trial run changes nothing.
    await mkdir(path.join(dataDir, "local", "source", "deep"), { recursive: true });
    await writeFile(path.join(dataDir, "local", "source", "a.txt"), "a");
    await writeFile(path.join(dataDir, "local", "source", "deep", "b.txt"), "bb");
    assert.equal((await api.post("/api/fs/mkdir", { rootSlug: slug, path: "/", name: "backup" })).status, 200);
    const source = { kind: "location", rootSlug: "local", path: "/source" };
    const destination = { kind: "location", rootSlug: slug, path: "/backup" };
    assert.equal((await api.post("/api/sync-jobs", { name: "overlap", source, destination: { kind: "location", rootSlug: "local", path: "/source/deep" } })).json.code, "SYNC_OVERLAP");
    const job = await api.post("/api/sync-jobs", { name: "Backup", source, destination, schedule: { kind: "daily", time: "03:00" } });
    assert.equal(job.status, 200, job.text);
    assert.ok(job.json.next_run_at > Date.now() / 1000);
    const runJob = async (id) => {
      const started = await api.post(`/api/sync-jobs/${id}/run`);
      assert.equal(started.status, 200, started.text);
      return waitTask(api, started.json.id);
    };
    assert.equal((await runJob(job.json.id)).status, "done");
    assert.equal((await api.get(`/api/fs/preview?${q("/backup/deep/b.txt")}`)).text, "bb");
    assert.equal((await api.get("/api/sync-jobs")).json[0].last_status, "done");

    await rm(path.join(dataDir, "local", "source", "a.txt"));
    await writeFile(path.join(dataDir, "local", "source", "c.txt"), "ccc");
    assert.equal((await runJob(job.json.id)).status, "done");
    assert.equal((await api.get(`/api/fs/meta?${q("/backup/a.txt")}`)).status, 200, "a copy deletes nothing");
    assert.equal((await api.get(`/api/fs/preview?${q("/backup/c.txt")}`)).text, "ccc");

    // A file changed without changing size is still noticed, by its time.
    await writeFile(path.join(dataDir, "local", "source", "c.txt"), "CCC");
    await utimes(path.join(dataDir, "local", "source", "c.txt"), new Date(), new Date(Date.now() + 60_000));
    assert.equal((await runJob(job.json.id)).status, "done");
    assert.equal((await api.get(`/api/fs/preview?${q("/backup/c.txt")}`)).text, "CCC");

    const trial = await api.put(`/api/sync-jobs/${job.json.id}`, { name: "Backup", source, destination, options: { mode: "mirror", dryRun: true }, schedule: null });
    assert.equal(trial.json.next_run_at, null);
    assert.equal((await runJob(job.json.id)).status, "done");
    assert.equal((await api.get(`/api/fs/meta?${q("/backup/a.txt")}`)).status, 200, "a trial run changes nothing");
    // What it would have changed is what it leaves behind.
    await writeFile(path.join(dataDir, "local", "source", "deep", "new.txt"), "new!");
    assert.equal((await runJob(job.json.id)).status, "done");
    assert.equal((await api.get(`/api/fs/meta?${q("/backup/deep/new.txt")}`)).status, 404);
    const report = await api.get(`/api/sync-jobs/${job.json.id}/trial`);
    assert.deepEqual(report.json.changes.map((change) => `${change.action} ${change.path}`).sort(), ["copy deep/new.txt", "delete a.txt"]);
    assert.equal(report.json.changes.find((change) => change.action === "copy").size, 4);
    assert.deepEqual(report.json.stats.extensions, [{ extension: "txt", count: 1, bytes: 4 }]);
    assert.deepEqual(report.json.stats.folders.find((folder) => folder.name === "deep"), { name: "deep", copy: 1, delete: 0, bytes: 4 });
    assert.deepEqual((await api.get("/api/sync-jobs")).json[0].last_trial, { copy: 1, delete: 1, mkdir: 0, rmdir: 0, touch: 0, bytes: 4, truncated: false });
    await rm(path.join(dataDir, "local", "source", "deep", "new.txt"));
    await api.put(`/api/sync-jobs/${job.json.id}`, { name: "Backup", source, destination, options: { mode: "mirror" } });
    assert.equal((await runJob(job.json.id)).status, "done");
    assert.equal((await api.get(`/api/fs/meta?${q("/backup/a.txt")}`)).status, 404, "a mirror removes what the source lost");
    assert.equal((await api.get("/api/sync-jobs")).json[0].last_trial, null);
    assert.equal((await api.get(`/api/sync-jobs/${job.json.id}/trial`)).json.code, "SYNC_NO_TRIAL");
    assert.equal((await api.get(`/api/fs/preview?${q("/backup/c.txt")}`)).text, "CCC");
    // How the runs before the last one ended is remembered: the trial ones with what they would have changed, the others with what they did.
    const runs = (await api.get(`/api/sync-jobs/${job.json.id}/runs`)).json;
    assert.deepEqual(runs.map((run) => `${run.status} ${run.dry_run}`), ["done false", "done true", "done true", "done false", "done false", "done false"]);
    assert.deepEqual(runs[1].summary, { copy: 1, delete: 1, mkdir: 0, rmdir: 0, touch: 0, bytes: 4, truncated: false });
    assert.deepEqual(runs.map((run) => `${run.summary.copy} ${run.summary.delete} ${run.summary.bytes}`), ["0 1 0", "1 1 4", "0 1 0", "1 0 3", "1 0 3", "2 0 3"]);
    assert.ok(runs.every((run) => run.finished_at >= run.started_at && !run.scheduled));

    // And back again, from the remote to a local folder.
    await mkdir(path.join(dataDir, "local", "restored"));
    const back = await api.post("/api/sync-jobs", { name: "Restore", source: destination, destination: { kind: "location", rootSlug: "local", path: "/restored" } });
    assert.equal((await runJob(back.json.id)).status, "done");
    assert.deepEqual((await readdir(path.join(dataDir, "local", "restored"), { recursive: true })).sort(), ["c.txt", "deep", "deep/b.txt"]);

    assert.equal((await api.delete(`/api/sync-jobs/${back.json.id}`)).status, 200);

    // Removing the location forgets it and what pointed into it; the files stay on the remote.
    assert.equal((await api.delete(`/api/roots/${rootId}`)).status, 200);
    rootId = undefined;
    assert.equal((await api.get(`/api/fs/list?${q("/")}`)).status, 404);
    assert.equal((await api.get("/api/shares")).json.length, 0);
    assert.equal((await api.get(`/api/fs/list?rootSlug=${outer.json.slug}&path=${encodeURIComponent(`/${sandbox}/backup`)}`)).json.items.length, 2);
    const cleanup = await api.post("/api/tasks", { type: "delete_to_trash", sources: [{ rootSlug: outer.json.slug, path: `/${sandbox}` }] });
    assert.equal((await waitTask(api, cleanup.json.id)).status, "done");
    await api.delete("/api/trash");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a whole server is one location with its shares at the top", { skip: process.env.KAGO_TEST_SERVER ? false : "KAGO_TEST_SERVER is not set" }, async () => {
  // KAGO_TEST_SERVER is a configuration with no `base`, for a server with at least two writable shares.
  const server = JSON.parse(process.env.KAGO_TEST_SERVER);
  const dir = await mkdtemp(path.join(tmpdir(), "kago-server."));
  const dataDir = path.join(dir, "data");
  const appDataDir = path.join(dir, "app-data");
  await mkdir(path.join(dataDir, "local"), { recursive: true });
  await mkdir(appDataDir, { recursive: true });
  await writeFile(path.join(dataDir, "local", "note.txt"), "note");
  const app = await buildApp({ port, dataDir, appDataDir, sessionSecret: "remote-test-session-secret", nodeEnv: "test" });
  await app.listen({ host: "127.0.0.1", port });
  const api = client(`http://127.0.0.1:${port}`);

  try {
    assert.equal((await api.post("/api/auth/setup", { email: "admin@example.test", password: "fake-admin-password-123", displayName: "Admin" })).status, 200);
    const created = await api.post("/api/roots/remote", { name: "Server", config: { ...server, base: "" } });
    assert.equal(created.status, 200, created.text);
    const slug = created.json.slug;
    const q = (p) => `rootSlug=${slug}&path=${encodeURIComponent(p)}`;
    const task = async (body) => {
      const made = await api.post("/api/tasks", body);
      assert.equal(made.status, 200, made.text);
      return waitTask(api, made.json.id);
    };

    // The shares are listed, and are not Kago's to add to, rename or remove.
    const top = await api.get(`/api/fs/list?${q("/")}`);
    assert.equal(top.status, 200, top.text);
    assert.equal(top.json.readonly, true);
    const [one, two] = top.json.items.map((item) => item.name);
    assert.ok(one && two, "the server needs two shares");
    assert.ok(top.json.items.every((item) => item.kind === "folder" && item.readonly));
    assert.equal((await api.get(`/api/fs/meta?${q(`/${one}`)}`)).json.kind, "folder");
    assert.equal((await api.post("/api/fs/mkdir", { rootSlug: slug, path: "/", name: "newshare" })).json.code, "REMOTE_SHARES_FIXED");
    assert.equal((await api.upload(slug, "/", "loose.txt", "x")).json.code, "REMOTE_SHARES_FIXED");
    assert.equal((await api.post("/api/fs/rename", { rootSlug: slug, path: `/${one}`, name: "other" })).json.code, "REMOTE_SHARES_FIXED");
    assert.equal((await api.post("/api/tasks", { type: "delete_to_trash", sources: [{ rootSlug: slug, path: `/${one}` }] })).json.code, "REMOTE_SHARES_FIXED");
    assert.equal((await api.post("/api/tasks", { type: "copy", sources: [{ rootSlug: "local", path: "/note.txt" }], destination: { rootSlug: slug, path: "/" } })).json.code, "REMOTE_SHARES_FIXED");
    assert.equal((await api.post("/api/tasks", { type: "move", sources: [{ rootSlug: slug, path: `/${one}` }], destination: { rootSlug: "local", path: "/" } })).json.code, "REMOTE_SHARES_FIXED");
    assert.equal((await api.post("/api/sync-jobs", { name: "all", source: { kind: "location", rootSlug: "local", path: "/" }, destination: { kind: "location", rootSlug: slug, path: "/" } })).json.code, "REMOTE_SHARES_FIXED");
    assert.deepEqual((await api.get(`/api/fs/list?${q("/")}`)).json.items.map((item) => item.name), [one, two], "the share is still there");

    // Inside a share everything works as in any location.
    const box = `kago-test-${Date.now()}`;
    const inside = await api.get(`/api/fs/list?${q(`/${one}`)}`);
    assert.equal(inside.json.readonly, false);
    assert.equal((await api.post("/api/fs/mkdir", { rootSlug: slug, path: `/${one}`, name: box })).status, 200);
    assert.equal((await api.post("/api/fs/mkdir", { rootSlug: slug, path: `/${two}`, name: box })).status, 200);
    assert.equal((await api.upload(slug, `/${one}/${box}`, "a.txt", "alpha")).status, 200);
    assert.equal((await api.get(`/api/fs/preview?${q(`/${one}/${box}/a.txt`)}`)).text, "alpha");
    assert.equal((await task({ type: "copy", sources: [{ rootSlug: "local", path: "/note.txt" }], destination: { rootSlug: slug, path: `/${one}/${box}` } })).status, "done");

    // From one share to another, which the server cannot do by renaming.
    assert.equal((await task({ type: "copy", sources: [{ rootSlug: slug, path: `/${one}/${box}/a.txt` }], destination: { rootSlug: slug, path: `/${two}/${box}` } })).status, "done");
    assert.equal((await task({ type: "move", sources: [{ rootSlug: slug, path: `/${one}/${box}/note.txt` }], destination: { rootSlug: slug, path: `/${two}/${box}` } })).status, "done");
    assert.deepEqual((await api.get(`/api/fs/list?${q(`/${two}/${box}`)}`)).json.items.map((item) => item.name).sort(), ["a.txt", "note.txt"]);
    assert.equal((await api.get(`/api/fs/meta?${q(`/${one}/${box}/note.txt`)}`)).status, 404);

    // Each share keeps its own trash, hidden in it.
    assert.equal((await task({ type: "delete_to_trash", sources: [{ rootSlug: slug, path: `/${one}/${box}/a.txt` }, { rootSlug: slug, path: `/${two}/${box}/a.txt` }] })).status, "done");
    assert.ok(!(await api.get(`/api/fs/list?${q(`/${one}`)}`)).json.items.some((item) => item.name === ".kago-trash"));
    assert.equal((await api.get(`/api/fs/list?${q(`/${one}/.kago-trash`)}`)).status, 404);
    const trash = (await api.get("/api/trash")).json;
    assert.equal(trash.length, 2);
    const restore = await api.post(`/api/trash/${trash.find((item) => item.original_path === `/${one}/${box}/a.txt`).id}/restore`);
    assert.equal((await waitTask(api, restore.json.id)).status, "done");
    assert.equal((await api.get(`/api/fs/preview?${q(`/${one}/${box}/a.txt`)}`)).text, "alpha");

    // A sync into a folder of a share, and an archive of the whole server that leaves the trash out.
    const job = await api.post("/api/sync-jobs", { name: "in", source: { kind: "location", rootSlug: "local", path: "/" }, destination: { kind: "location", rootSlug: slug, path: `/${two}/${box}` }, options: { mode: "mirror" } });
    assert.equal(job.status, 200, job.text);
    assert.equal((await waitTask(api, (await api.post(`/api/sync-jobs/${job.json.id}/run`)).json.id)).status, "done");
    assert.deepEqual((await api.get(`/api/fs/list?${q(`/${two}/${box}`)}`)).json.items.map((item) => item.name), ["note.txt"]);
    const archive = new AdmZip((await api.get(`/api/fs/download-zip?${q(`/${two}`)}`)).bytes);
    assert.ok(archive.getEntries().every((entry) => !entry.entryName.includes(".kago-trash")));
    assert.ok(archive.getEntry(`${two}/${box}/note.txt`));

    for (const share of [one, two]) assert.equal((await task({ type: "delete_to_trash", sources: [{ rootSlug: slug, path: `/${share}/${box}` }] })).status, "done");
    assert.equal((await api.delete("/api/trash")).json.deleted, 3);
    assert.equal((await api.delete(`/api/roots/${created.json.id}`)).status, 200);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function client(origin) {
  let cookie = "";
  async function request(method, url, { body, headers = {} } = {}) {
    const response = await fetch(`${origin}${url}`, { method, body, headers: { ...(method === "GET" ? {} : { "x-kago-csrf": "1" }), ...(cookie ? { cookie } : {}), ...headers } });
    const set = response.headers.getSetCookie().map((value) => value.split(";")[0]);
    if (set.length > 0) cookie = [...cookie.split("; ").filter(Boolean), ...set].join("; ");
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString("utf8");
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, bytes, text, json };
  }
  const json = (method) => (url, body) => request(method, url, body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } });
  const form = (fields, name, content) => {
    const data = new FormData();
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    data.set("file", new Blob([content]), name);
    return data;
  };
  return {
    get: (url, headers) => request("GET", url, { headers }),
    post: json("POST"),
    put: json("PUT"),
    patch: json("PATCH"),
    delete: json("DELETE"),
    upload: (rootSlug, folder, name, content) => request("POST", "/api/fs/upload", { body: form({ rootSlug, path: folder }, name, content) }),
    shareUpload: (token, name, content) => request("POST", `/s/${token}/upload`, { body: form({}, name, content) })
  };
}

async function waitTask(api, taskId) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const task = (await api.get(`/api/tasks/${taskId}`)).json;
    if (!["queued", "running"].includes(task.status)) return task;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`task ${taskId} did not finish`);
}
