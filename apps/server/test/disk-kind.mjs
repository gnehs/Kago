import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { onSpinningDisk } from "../src/lib/disk-kind.ts";

/** A `/sys` that tells of the disk the folder is on, the way Linux lays it out for a partition or for a whole disk. */
async function sysfs(t, folder, { rotational, partition }) {
  const sys = await mkdtemp(path.join(tmpdir(), "kago-sys."));
  t.after(() => rm(sys, { recursive: true, force: true }));
  const { dev } = await stat(folder, { bigint: true });
  const device = `${(dev >> 8n) & 0xfffn}:${(dev & 0xffn) | ((dev >> 12n) & 0xfff00n)}`;
  const disk = path.join(sys, "devices/sda");
  await mkdir(path.join(disk, "queue"), { recursive: true });
  await mkdir(path.join(disk, "sda1"));
  await mkdir(path.join(sys, "dev/block"), { recursive: true });
  if (rotational !== undefined) await writeFile(path.join(disk, "queue/rotational"), `${rotational}\n`);
  await symlink(partition ? path.join(disk, "sda1") : disk, path.join(sys, "dev/block", device));
  return sys;
}

test("a disk that says it spins is one, asked directly or through a partition of it", async (t) => {
  const folder = tmpdir();
  assert.equal(await onSpinningDisk(folder, await sysfs(t, folder, { rotational: 1, partition: false })), true);
  assert.equal(await onSpinningDisk(folder, await sysfs(t, folder, { rotational: 1, partition: true })), true);
  assert.equal(await onSpinningDisk(folder, await sysfs(t, folder, { rotational: 0, partition: true })), false);
});

test("a path that is not there yet is asked about by the folder it will be in", async (t) => {
  const folder = tmpdir();
  assert.equal(await onSpinningDisk(path.join(folder, "not", "made", "yet"), await sysfs(t, folder, { rotational: 1, partition: true })), true);
});

test("what the system tells nothing of is taken not to spin", async (t) => {
  const folder = tmpdir();
  assert.equal(await onSpinningDisk(folder, await sysfs(t, folder, { partition: true })), false);
  assert.equal(await onSpinningDisk(folder, path.join(folder, "no-sys-here")), false);
});
