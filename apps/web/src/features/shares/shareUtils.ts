import { t } from "../../lib/i18n";
export type ShareMode = "download" | "view_only" | "upload_only";

export const shareModes: Array<{ value: ShareMode; label: string }> = [
  { value: "download", label: t("Can download") },
  { value: "view_only", label: t("View only") },
  { value: "upload_only", label: t("Upload only (drop box)") }
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
