import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FsService } from "../src/services/fs.service.ts";
import { PermissionService } from "../src/services/permission.service.ts";

test("renaming a folder rebases user and group rules and leaves a neighbour's alone", async (t) => {
  const fixture = await createFixture(t);
  const sourceFolder = "/shared/100%_done";
  const sourceFile = `${sourceFolder}/private/secret.txt`;
  const targetFolder = "/shared/renamed";
  const targetFile = `${targetFolder}/private/secret.txt`;

  await mkdir(path.join(fixture.root.base_path, sourceFolder.slice(1), "private"), { recursive: true });
  await writeFile(path.join(fixture.root.base_path, sourceFile.slice(1)), "fake canary");
  await writeFile(path.join(fixture.root.base_path, sourceFolder.slice(1), "public.txt"), "public fake content");

  fixture.db.prepare("INSERT INTO group_members (user_id, group_id) VALUES (?, ?)").run("user-a", "group-a");
  addRule(fixture.db, { id: "folder", principalType: "user", principalId: "user-a", path: sourceFolder, level: "edit", recursive: false });
  addRule(fixture.db, { id: "source-user", principalType: "user", principalId: "user-a", path: `${sourceFolder}/public.txt`, level: "view" });
  addRule(fixture.db, { id: "source-group", principalType: "group", principalId: "group-a", path: sourceFile, level: "edit" });
  addRule(fixture.db, { id: "destination", principalType: "user", principalId: "user-a", path: `${targetFolder}/other.txt`, level: "view" });
  addRule(fixture.db, { id: "neighbor-rule", principalType: "user", principalId: "user-a", path: "/shared/100%_done-backup/private/secret.txt", level: "view" });

  assert.equal(fixture.permissions.can(fixture.actor, "edit", fixture.root, sourceFile).allowed, true);
  assert.equal(fixture.permissions.can(fixture.actor, "edit", fixture.root, `${sourceFolder}/public.txt`).allowed, false);
  assert.equal(fixture.permissions.can(fixture.actor, "view", fixture.root, `${sourceFolder}/private`).allowed, false);
  const result = await fixture.fs.rename(fixture.actor, "photos", sourceFolder, "renamed");

  assert.equal(result.path, targetFolder);
  assert.equal(await readFile(path.join(fixture.root.base_path, targetFile.slice(1)), "utf8"), "fake canary");
  assert.equal(fixture.permissions.can(fixture.actor, "edit", fixture.root, targetFile).allowed, true);
  assert.equal(fixture.permissions.can(fixture.actor, "view", fixture.root, `${targetFolder}/public.txt`).allowed, true);
  assert.equal(fixture.permissions.can(fixture.actor, "edit", fixture.root, `${targetFolder}/public.txt`).allowed, false);
  assert.equal(fixture.permissions.can(fixture.actor, "view", fixture.root, `${targetFolder}/private`).allowed, false);
  assert.equal(fixture.permissions.can(fixture.actor, "view", fixture.root, sourceFile).allowed, false);

  const rebased = Object.fromEntries(
    fixture.db.prepare("SELECT id, root_id, path_prefix FROM permission_rules").all().map((rule) => [rule.id, rule])
  );
  assert.equal(rebased["folder"].path_prefix, targetFolder);
  assert.equal(rebased["source-user"].path_prefix, `${targetFolder}/public.txt`);
  assert.equal(rebased["source-group"].path_prefix, targetFile);
  assert.equal(rebased["destination"].path_prefix, `${targetFolder}/other.txt`);
  assert.equal(rebased["neighbor-rule"].path_prefix, "/shared/100%_done-backup/private/secret.txt");
  assert.equal(fixture.db.prepare("SELECT count(*) AS count FROM move_markers").get().count, 1);
  assert.equal(fixture.auditEntries.length, 1);
});

test("a permission database failure rolls back the filesystem rename", async (t) => {
  const fixture = await createFixture(t);
  const source = "/shared/secret.txt";
  const target = "/shared/renamed.txt";
  await mkdir(path.join(fixture.root.base_path, "shared"), { recursive: true });
  await writeFile(path.join(fixture.root.base_path, source.slice(1)), "fake secret");
  addRule(fixture.db, { id: "parent", principalType: "user", principalId: "user-a", path: "/shared", level: "edit" });
  addRule(fixture.db, { id: "file-rule", principalType: "user", principalId: "user-a", path: source, level: "view" });
  fixture.db.exec(`
    CREATE TRIGGER fail_permission_update BEFORE UPDATE ON permission_rules
    BEGIN SELECT RAISE(ABORT, 'fixture ACL update failure'); END;
  `);

  await assert.rejects(fixture.fs.rename(fixture.actor, "photos", source, "renamed.txt"));

  assert.equal(await readFile(path.join(fixture.root.base_path, source.slice(1)), "utf8"), "fake secret");
  await assert.rejects(readFile(path.join(fixture.root.base_path, target.slice(1))));
  assert.equal(fixture.db.prepare("SELECT path_prefix FROM permission_rules WHERE id = 'file-rule'").get().path_prefix, source);
  assert.equal(fixture.db.prepare("SELECT count(*) AS count FROM move_markers").get().count, 0);
  assert.equal(fixture.auditEntries.length, 0);
});

test("a related database failure rolls back both ACL changes and filesystem rename", async (t) => {
  const fixture = await createFixture(t);
  const source = "/shared/secret.txt";
  const target = "/shared/renamed.txt";
  await mkdir(path.join(fixture.root.base_path, "shared"), { recursive: true });
  await writeFile(path.join(fixture.root.base_path, source.slice(1)), "fake secret");
  addRule(fixture.db, { id: "parent", principalType: "user", principalId: "user-a", path: "/shared", level: "edit" });
  addRule(fixture.db, { id: "file-rule", principalType: "user", principalId: "user-a", path: source, level: "view" });
  fixture.db.exec(`
    CREATE TRIGGER fail_related_update BEFORE INSERT ON move_markers
    BEGIN SELECT RAISE(ABORT, 'fixture related update failure'); END;
  `);

  await assert.rejects(fixture.fs.rename(fixture.actor, "photos", source, "renamed.txt"));

  assert.equal(await readFile(path.join(fixture.root.base_path, source.slice(1)), "utf8"), "fake secret");
  await assert.rejects(readFile(path.join(fixture.root.base_path, target.slice(1))));
  assert.equal(fixture.db.prepare("SELECT path_prefix FROM permission_rules WHERE id = 'file-rule'").get().path_prefix, source);
  assert.equal(fixture.db.prepare("SELECT count(*) AS count FROM move_markers").get().count, 0);
  assert.equal(fixture.auditEntries.length, 0);
});

async function createFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "kago-rename-acl."));
  const rootDirectory = path.join(directory, "root");
  await mkdir(rootDirectory, { recursive: true });
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE permission_rules (
      id TEXT PRIMARY KEY, principal_type TEXT NOT NULL, principal_id TEXT NOT NULL,
      root_id TEXT NOT NULL, path_prefix TEXT NOT NULL, level TEXT NOT NULL,
      recursive INTEGER NOT NULL, created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE group_members (user_id TEXT NOT NULL, group_id TEXT NOT NULL);
    CREATE TABLE move_markers (from_root TEXT, from_path TEXT, to_root TEXT, to_path TEXT);
  `);

  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });

  const root = {
    id: "root-a",
    slug: "photos",
    name: "Photos",
    base_path: rootDirectory,
    provider: "local",
    config: null,
    readonly: 0,
    created_at: 1,
    updated_at: 1
  };
  const normalize = (rawPath) => path.posix.normalize(rawPath.startsWith("/") ? rawPath : `/${rawPath}`);
  const paths = {
    async resolveExisting(_rootSlug, rawPath) {
      const logicalPath = normalize(rawPath);
      return { root, logicalPath, absolutePath: path.join(root.base_path, logicalPath.slice(1)) };
    },
    async resolveForCreate(_rootSlug, rawPath) {
      const logicalPath = normalize(rawPath);
      return { root, logicalPath, absolutePath: path.join(root.base_path, logicalPath.slice(1)) };
    }
  };
  const permissions = new PermissionService(db, { write() {} });
  const auditEntries = [];
  const preferences = {
    moved(fromRoot, fromPath, toRoot, toPath) {
      db.prepare("INSERT INTO move_markers VALUES (?, ?, ?, ?)").run(fromRoot, fromPath, toRoot, toPath);
    }
  };
  const fs = new FsService(
    paths,
    permissions,
    { write(entry) { auditEntries.push(entry); } },
    { isRemote: () => false },
    directory,
    preferences
  );
  const actor = { id: "user-a", email: "fake@example.test", displayName: "Fake User", role: "USER", disabled: false };
  return { db, root, permissions, auditEntries, fs, actor };
}

function addRule(db, input) {
  db.prepare(`
    INSERT INTO permission_rules
    (id, principal_type, principal_id, root_id, path_prefix, level, recursive, created_at, updated_at)
    VALUES (?, ?, ?, 'root-a', ?, ?, ?, 1, 1)
  `).run(input.id, input.principalType, input.principalId, input.path, input.level, input.recursive === false ? 0 : 1);
}
