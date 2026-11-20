import { t } from "../../lib/i18n";
import type { ShareLink } from "../../types/kago";
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

export type ShareState = "disabled" | "expired" | "limit" | "active";

/** What a link in the list is doing right now, as the server judges it when the link is opened. */
export function shareState(share: ShareLink, nowSeconds = Math.floor(Date.now() / 1000)): ShareState {
  if (share.disabled) return "disabled";
  if (share.expires_at && share.expires_at < nowSeconds) return "expired";
  if (share.max_downloads && share.download_count >= share.max_downloads) return "limit";
  return "active";
}

export const shareStateLabel = (state: ShareState) => ({ disabled: t("Disabled"), expired: t("Expired"), limit: t("Limit reached"), active: t("Active") })[state];

/** Puts the link on the clipboard, falling back to the old way when the browser turns the first down (it does once the page has waited on the network). */
export async function copyShareLink(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    try {
      return document.execCommand("copy");
    } catch {
      return false;
    } finally {
      textarea.remove();
    }
  }
}
