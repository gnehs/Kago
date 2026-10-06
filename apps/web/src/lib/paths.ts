/** Names are shown, compared and sent in NFC; paths from the server keep their on-disk spelling and stay the identity. */
export const nfc = (value: string) => value.normalize("NFC");

export function parentPath(value: string) {
  const parts = value.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

const rawBaseName = (value: string) => value.split("/").filter(Boolean).at(-1) ?? "";

/** Display name of a path. */
export const baseName = (value: string) => nfc(rawBaseName(value));

/** True when the name on disk is not NFC yet, i.e. renaming it to its own display name still changes something. */
export const needsNormalizing = (path: string) => rawBaseName(path) !== baseName(path);

export function joinLogicalPath(parent: string, name: string) {
  const cleanName = nfc(name).replaceAll("\\", "-").replaceAll("/", "-").replaceAll("\0", "");
  return `${parent === "/" ? "" : parent}/${cleanName}`;
}

/** Normalises a typed logical path. Returns null when the input can never be a valid logical path. */
export function normalizeLogicalPath(value: string, rootSlug?: string): string | null {
  const trimmed = value.trim().replaceAll("\\", "/");
  const withoutRoot = rootSlug && trimmed.startsWith(`${rootSlug}:`) ? trimmed.slice(rootSlug.length + 1).trim() : trimmed;
  if (!withoutRoot || withoutRoot === "/") return "/";
  if (withoutRoot.includes("\0")) return null;
  const parts = withoutRoot.split("/").filter(Boolean);
  if (parts.some((part) => part === "..")) return null;
  const normalized = parts.filter((part) => part !== ".").join("/");
  return normalized ? `/${normalized}` : "/";
}

export function ensureZipName(value: string) {
  const trimmed = value.trim() || "archive";
  return trimmed.toLowerCase().endsWith(".zip") ? trimmed : `${trimmed}.zip`;
}

export function triggerDownload(url: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}
