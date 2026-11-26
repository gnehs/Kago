import fsp from "node:fs/promises";
import path from "node:path";

const known = new Map<string, Promise<boolean>>();

/**
 * Whether what holds `target` is a disk that spins, as far as Linux says: it tells of each block device, and a
 * partition is asked about through the disk it is cut from. An array of spinning disks counts as one. Anything
 * it does not tell of is taken not to spin: another system, a network share, or a filesystem that stands
 * between several disks and names none of them. A path not made yet is asked about by the folder it will be in.
 */
export async function onSpinningDisk(target: string, sys = "/sys"): Promise<boolean> {
  let dev: bigint;
  try {
    ({ dev } = await fsp.stat(target, { bigint: true }));
  } catch {
    const parent = path.dirname(target);
    return parent === target ? false : onSpinningDisk(parent, sys);
  }
  // The device number as Linux packs it: twelve bits of major around twenty of minor.
  const device = `${(dev >> 8n) & 0xfffn}:${(dev & 0xffn) | ((dev >> 12n) & 0xfff00n)}`;
  const key = `${sys}:${device}`;
  let spinning = known.get(key);
  if (!spinning) {
    // Not joined as a path: `..` has to be followed from where the link for a partition leads, which is inside its disk.
    const said = (queue: string) => fsp.readFile(`${sys}/dev/block/${device}/${queue}/rotational`, "utf8");
    spinning = said("queue").catch(() => said("../queue")).then((value) => value.trim() === "1", () => false);
    known.set(key, spinning);
  }
  return spinning;
}
