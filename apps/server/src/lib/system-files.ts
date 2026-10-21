/** What Kago's own names begin with, and nobody else's may: what it leaves under one is hidden, and may be cleared away. */
export const KAGO_PREFIX = ".kago-";

/** Where a location keeps what was deleted from it, at its own top; never listed, never reachable by path. */
export const TRASH_FOLDER = ".kago-trash";

/** How a conversion names the file it is still writing, beside where the finished one will lie. */
export const CONVERT_PARTIAL = ".kago-convert-";

/** How a copy or move names what is to take another's place, beside it, until it has arrived whole. */
export const REPLACE_PARTIAL = ".kago-replace-";

/** How an upload names the file it is still receiving, beside where the finished one will lie. */
export const UPLOAD_PARTIAL = ".kago-upload-";

/**
 * What operating systems and NAS software leave in folders for their own use: thumbnail caches, folder settings,
 * resource forks, recycle bins. Nobody put them there, so a folder is listed without them. They stay where they
 * are, and reachable by path. Compared in lower case, as the systems that write them do not mind the case.
 */
const SYSTEM_NAMES = new Set([
  // macOS
  ".ds_store",
  ".appledouble",
  ".lsoverride",
  ".spotlight-v100",
  ".trashes",
  ".fseventsd",
  ".temporaryitems",
  ".documentrevisions-v100",
  ".volumeicon.icns",
  ".apdisk",
  ".com.apple.timemachine.donotpresent",
  "icon\r",
  // Windows
  "thumbs.db",
  "ehthumbs.db",
  "ehthumbs_vista.db",
  "desktop.ini",
  "$recycle.bin",
  "system volume information",
  // Synology and QNAP
  "@eadir",
  ".@__thumb"
]);

/** `._name` is where macOS keeps a file's resource fork on a volume that has no place for one. Kago's own trash folder, half-written uploads, conversions and replacements are left out the same way. */
export const isSystemFile = (name: string) => name.startsWith("._") || name.startsWith(KAGO_PREFIX) || SYSTEM_NAMES.has(name.toLowerCase());
