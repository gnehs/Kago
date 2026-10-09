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

/** `._name` is where macOS keeps a file's resource fork on a volume that has no place for one. */
export const isSystemFile = (name: string) => name.startsWith("._") || SYSTEM_NAMES.has(name.toLowerCase());
