import type { ShareLink } from "@/types/kago";
import { t } from "@/lib/i18n";
import { kindOfExtension, extensionOf } from "@/lib/fileKind";
import { shareIsFolder, shareName, type ShareEnd, type ShareExpiry, type ShareFigure, type ShareMode, type Span } from "@/lib/shareModel";

/** The three things a visitor can be let do, in the order they are offered. `visitor` is how a card in the list says it. */
export const shareModes: Array<{ value: ShareMode; label: string; visitor: string; description: string }> = [
  { value: "download", label: t("Download"), visitor: t("Can download"), description: t("See the file and download it") },
  { value: "view_only", label: t("View only"), visitor: t("View only"), description: t("Preview it online, with no download") },
  { value: "upload_only", label: t("Upload to me"), visitor: t("Drop box"), description: t("A drop box: they add files but can’t see what’s inside") }
];

export const visitorCan = (mode: ShareMode) => shareModes.find((item) => item.value === mode)!.visitor;

export function spanAhead({ unit, amount }: Span) {
  return unit === "minute" ? t("expires in {count} minute | expires in {count} minutes", { count: amount }) : unit === "hour" ? t("expires in {count} hour | expires in {count} hours", { count: amount }) : t("expires in {count} day | expires in {count} days", { count: amount });
}

export function spanBehind({ unit, amount }: Span) {
  return unit === "minute" ? t("expired {count} minute ago | expired {count} minutes ago", { count: amount }) : unit === "hour" ? t("expired {count} hour ago | expired {count} hours ago", { count: amount }) : t("expired {count} day ago | expired {count} days ago", { count: amount });
}

export const expiryText = (expiry: ShareExpiry) => (expiry.kind === "never" ? t("never expires") : expiry.kind === "in" ? spanAhead(expiry.span) : spanBehind(expiry.span));

export const endText = (end: ShareEnd) => (end.state === "expired" ? spanBehind(end.span) : end.state === "limit" ? t("{used} / {max} downloads, limit reached", { used: end.used, max: end.max }) : t("disabled"));

export const figureText = (figure: ShareFigure) => (figure.kind === "limit" ? `${figure.used} / ${figure.max}` : t("{count} download | {count} downloads", { count: figure.count }));

/**
 * What a share's icon is drawn from. The list is told no more than the name and the mode, but the server refuses any
 * pair but a file with download or view and a folder with upload, so the mode says which it is and the name's ending
 * says what kind of file. A kind has no registered type here, so one is made up that `fileKind` will take for it.
 */
export function shareIconItem(share: ShareLink, rootName: string) {
  const name = shareName(share, rootName);
  if (shareIsFolder(share)) return { kind: "folder", type: "", name } as const;
  const kind = kindOfExtension(extensionOf(name));
  return { kind: "file", type: kind === "image" ? "image/x-share" : kind === "video" ? "video/x-share" : kind === "audio" ? "audio/x-share" : kind === "pdf" ? "application/pdf" : "", name } as const;
}

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
