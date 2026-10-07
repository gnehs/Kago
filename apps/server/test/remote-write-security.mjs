import assert from "node:assert/strict";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { RemoteStorage } from "../dist/storage/remote-storage.js";

const root = { id: "root-test", provider: "webdav" };
const roots = { remoteConfig: () => ({ type: "webdav", base: "", params: {} }) };
const env = { appDataDir: "/tmp/kago-test", sessionSecret: "test-secret" };

test("failed staged upload leaves an existing remote file untouched", async () => {
  const remote = new FakeRclone({ "docs/notes.txt": Buffer.from("original") });
  remote.failUpload = true;
  const storage = new RemoteStorage(remote, roots, env);

  await assert.rejects(storage.write(root, "/docs/notes.txt", Readable.from(["replacement"])));

  assert.equal(remote.text("docs/notes.txt"), "original");
  assert.ok(remote.deleted.every((name) => name !== "docs/notes.txt"));
  assert.deepEqual([...remote.files.keys()], ["docs/notes.txt"]);
});

test("failed replacement move restores the old file after a partial destination write", async () => {
  const remote = new FakeRclone({ "docs/notes.txt": Buffer.from("original") });
  remote.failCommitAfterPartialWrite = true;
  const storage = new RemoteStorage(remote, roots, env);

  await assert.rejects(storage.write(root, "/docs/notes.txt", Readable.from(["replacement"])));

  assert.equal(remote.text("docs/notes.txt"), "original");
  assert.deepEqual([...remote.files.keys()], ["docs/notes.txt"]);
});

test("failed restoration keeps the recovery copy on the remote", async () => {
  const remote = new FakeRclone({ "docs/notes.txt": Buffer.from("original") });
  remote.failCommitAfterPartialWrite = true;
  remote.failRestore = true;
  const storage = new RemoteStorage(remote, roots, env);

  await assert.rejects(
    storage.write(root, "/docs/notes.txt", Readable.from(["replacement"])),
    (error) => error.code === "REMOTE_WRITE_RECOVERY_REQUIRED"
  );

  assert.equal(remote.text("docs/notes.txt"), undefined);
  const recovery = [...remote.files].find(([name]) => name.startsWith("docs/.kago-write-backup_"));
  assert.equal(recovery?.[1].toString("utf8"), "original");
});

class FakeRclone {
  files;
  deleted = [];
  failUpload = false;
  failCommitAfterPartialWrite = false;
  failRestore = false;

  constructor(files = {}) {
    this.files = new Map(Object.entries(files));
  }

  async stat(_fs, remote) {
    const data = this.files.get(remote);
    return data ? { Path: remote, Name: path.posix.basename(remote), Size: data.length, ModTime: new Date(0).toISOString(), IsDir: false } : null;
  }

  async upload(_fs, directory, name, source) {
    if (this.failUpload) throw new Error("simulated upload failure before remote replacement");
    const chunks = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    this.files.set(path.posix.join(directory, name), Buffer.concat(chunks));
  }

  async call(command, body) {
    if (command === "operations/deletefile") {
      this.deleted.push(body.remote);
      this.files.delete(body.remote);
      return {};
    }
    if (command === "operations/copyfile") {
      if (this.failRestore && String(body.srcRemote).includes(".kago-write-backup_")) {
        throw new Error("simulated restore failure");
      }
      const source = this.files.get(body.srcRemote);
      if (!source) throw new Error("source object missing");
      this.files.set(body.dstRemote, Buffer.from(source));
      return {};
    }
    if (command === "operations/movefile") {
      if (this.failCommitAfterPartialWrite && String(body.srcRemote).includes(".kago-write-temp_")) {
        this.failCommitAfterPartialWrite = false;
        this.files.set(body.dstRemote, Buffer.from("partial replacement"));
        throw new Error("simulated move failure after partial destination write");
      }
      const source = this.files.get(body.srcRemote);
      if (!source) throw new Error("source object missing");
      this.files.set(body.dstRemote, Buffer.from(source));
      this.files.delete(body.srcRemote);
      return {};
    }
    throw new Error(`unexpected rclone operation: ${command}`);
  }

  text(remote) {
    return this.files.get(remote)?.toString("utf8");
  }
}
