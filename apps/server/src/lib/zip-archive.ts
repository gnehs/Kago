import { isUtf8 } from "node:buffer";
import yauzl from "yauzl";
import type { ArchiveEntry, ArchiveListing } from "@kago/contract";

/** Opens an archive by file descriptor and reads entry metadata on demand. */
export function openZipArchive(filePath: string): Promise<yauzl.ZipFile> {
  return yauzl.openPromise(filePath, {
    autoClose: true,
    decodeStrings: true,
    lazyEntries: true,
    strictFileNames: false,
    validateEntrySizes: true
  });
}

/**
 * The entry's name, read as UTF-8 whenever its bytes are UTF-8: macOS and most tools today write UTF-8 names
 * without setting the flag that says so, and yauzl then reads them as CP437, which no one writes non-ASCII names in anymore.
 */
export function zipEntryName(entry: yauzl.Entry): string {
  const flagged = (entry.generalPurposeBitFlag & 0x800) !== 0;
  return !flagged && isUtf8(entry.fileNameRaw) ? entry.fileNameRaw.toString("utf8") : entry.fileName;
}

export function isZipDirectory(entry: yauzl.Entry): boolean {
  return entry.fileName.endsWith("/");
}

export function isZipSymlink(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

/** Reads the central directory only; nothing is decompressed. Past `limit` entries the rest are left out. */
export async function listZipEntries(filePath: string, limit: number): Promise<ArchiveListing> {
  const zip = await openZipArchive(filePath);
  const entries: ArchiveEntry[] = [];
  try {
    for await (const entry of zip.eachEntry()) {
      if (entries.length === limit) return { entries, truncated: true };
      const mtime = entry.getLastModDate().getTime();
      entries.push({
        path: zipEntryName(entry).normalize("NFC").replaceAll("\\", "/").split("/").filter((segment) => segment && segment !== ".").join("/"),
        folder: isZipDirectory(entry),
        size: entry.uncompressedSize,
        packed: entry.compressedSize,
        mtime: Number.isFinite(mtime) ? mtime : null,
        locked: entry.isEncrypted()
      });
    }
    return { entries, truncated: false };
  } finally {
    if (zip.isOpen) zip.close();
  }
}
