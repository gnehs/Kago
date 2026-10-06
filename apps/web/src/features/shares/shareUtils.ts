export type ShareMode = "download" | "view_only" | "upload_only";

export const shareModes: Array<{ value: ShareMode; label: string }> = [
  { value: "download", label: "可下載" },
  { value: "view_only", label: "僅檢視" },
  { value: "upload_only", label: "僅上傳（收件箱）" }
];

export function parseShareMode(permissionJson: string): ShareMode {
  try {
    const mode = (JSON.parse(permissionJson) as { mode?: unknown }).mode;
    if (mode === "view_only" || mode === "upload_only") return mode;
  } catch {
    // Fall through to the default mode.
  }
  return "download";
}

export const shareModeLabel = (mode: ShareMode) => shareModes.find((item) => item.value === mode)?.label ?? mode;
