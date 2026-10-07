import yauzl from "yauzl";

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

export function isZipDirectory(entry: yauzl.Entry): boolean {
  return entry.fileName.endsWith("/");
}

export function isZipSymlink(entry: yauzl.Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return unixMode === 0o120000;
}
