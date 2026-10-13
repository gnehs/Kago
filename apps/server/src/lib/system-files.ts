/** Where a location keeps what was deleted from it, at its own top; never listed, never reachable by path. */
export const TRASH_FOLDER = ".kago-trash";

/** How a conversion names the file it is still writing, beside where the finished one will lie. */
export const CONVERT_PARTIAL = ".kago-convert-";

/** How a copy or move names what is to take another's place, beside it, until it has arrived whole. */
export const REPLACE_PARTIAL = ".kago-replace-";

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

/** `._name` is where macOS keeps a file's resource fork on a volume that has no place for one. Kago's own trash folder, half-written conversions and replacements still arriving are left out the same way. */
export const isSystemFile = (name: string) => name.startsWith("._") || name === TRASH_FOLDER || name.startsWith(CONVERT_PARTIAL) || name.startsWith(REPLACE_PARTIAL) || SYSTEM_NAMES.has(name.toLowerCase());
