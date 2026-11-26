import type { ShareLink } from "@/types/kago";
import { t } from "@/lib/i18n";
import { namedItem } from "@/lib/fileKind";
import { shareIsFolder, shareName, type ShareEnd, type ShareExpiry, type ShareFigure, type ShareMode, type Span } from "@/lib/shareModel";

/** The three things a visitor can be let do, in the order they are offered. `visitor` is how a card in the list says it. */
export const shareModes: Array<{ value: ShareMode; label: string; visitor: string; folderVisitor: string }> = [
  { value: "download", label: t("Download"), visitor: t("Can download"), folderVisitor: t("Can browse and download") },
  { value: "view_only", label: t("View only"), visitor: t("View only"), folderVisitor: t("Can browse, view only") },
  { value: "upload_only", label: t("Upload to me"), visitor: t("Drop box"), folderVisitor: t("Drop box") }
];

export const visitorCan = (mode: ShareMode, folder = false) => {
  const entry = shareModes.find((item) => item.value === mode)!;
  return folder ? entry.folderVisitor : entry.visitor;
};

/** What a choice of the dialog means for what is being shared; each is true for a file and for a folder, and says which where the two differ. */
export function modeDescription(mode: ShareMode, kind: "file" | "folder" | null): string {
  if (mode === "download") return kind === "folder" ? t("Browse it and download files, or all of it") : kind === "file" ? t("See the file and download it") : t("See it and download it");
  if (mode === "view_only") return kind === "folder" ? t("Browse and preview what’s inside, with no download") : kind === "file" ? t("Preview it online, with no download") : t("Look at it online, with no download");
  return kind === "file" ? t("Only for a folder: they add files but can’t see what’s inside") : t("A drop box: they add files but can’t see what’s inside");
}

export function spanAhead({ unit, amount }: Span) {
  return unit === "minute" ? t("expires in {count} minute | expires in {count} minutes", { count: amount }) : unit === "hour" ? t("expires in {count} hour | expires in {count} hours", { count: amount }) : t("expires in {count} day | expires in {count} days", { count: amount });
}

export function spanBehind({ unit, amount }: Span) {
  return unit === "minute" ? t("expired {count} minute ago | expired {count} minutes ago", { count: amount }) : unit === "hour" ? t("expired {count} hour ago | expired {count} hours ago", { count: amount }) : t("expired {count} day ago | expired {count} days ago", { count: amount });
}

export const expiryText = (expiry: ShareExpiry) => (expiry.kind === "never" ? t("never expires") : expiry.kind === "in" ? spanAhead(expiry.span) : spanBehind(expiry.span));

/** A limit on a folder counts the people who open it, once each for a while; on a file, the times it was sent. `folder` words the figures for the first. */
export const endText = (end: ShareEnd, folder = false) => (end.state === "expired" ? spanBehind(end.span) : end.state === "limit" ? (folder ? t("{used} / {max} visitors, limit reached", { used: end.used, max: end.max }) : t("{used} / {max} downloads, limit reached", { used: end.used, max: end.max })) : t("disabled"));

export const figureText = (figure: ShareFigure, folder = false) => (figure.kind === "limit" ? `${figure.used} / ${figure.max}` : folder ? t("{count} visitor | {count} visitors", { count: figure.count }) : t("{count} download | {count} downloads", { count: figure.count }));

/** What a share's icon is drawn from: its name, and whether the server recorded it as a folder. */
export const shareIconItem = (share: ShareLink, rootName: string) => namedItem(shareName(share, rootName), shareIsFolder(share));

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
