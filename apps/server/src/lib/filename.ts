import fsp from "node:fs/promises";
import { AppError } from "./errors.js";

/** Names Kago writes are always NFC; names it reads are left as they are on disk and only compared in NFC. */
export const nfc = (value: string) => value.normalize("NFC");

export const sameName = (a: string, b: string) => a === b || nfc(a) === nfc(b);

/**
 * Rejects a new name when the folder already holds an entry that reads the same once normalised
 * (e.g. an NFD "が.txt" next to a new NFC "が.txt"), which a normalisation-sensitive filesystem would happily store twice.
 * `ignore` is the on-disk name of the entry being renamed, which may keep its own slot.
 */
export async function assertNameAvailable(directory: string, name: string, ignore?: string): Promise<void> {
  const entries = await fsp.readdir(directory);
  if (entries.some((entry) => entry !== ignore && sameName(entry, name))) {
    throw new AppError(409, "Target already exists", "TARGET_EXISTS");
  }
}
