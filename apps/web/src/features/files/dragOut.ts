import { downloadUrl, zipDownloadUrl } from "@/api/client";
import { nfc } from "@/lib/paths";
import type { FileItem } from "@/types/kago";

type Dragged = Pick<FileItem, "path" | "name" | "kind">;

/** Addresses longer than this are refused by servers and proxies on the way, so a selection that large is not offered. */
const MAX_URL_LENGTH = 6000;

/**
 * Lets a drag that leaves the browser land as a file: Chromium downloads the address straight to where it is dropped
 * (the desktop, a Finder window), under the name given here. A file arrives as itself; a folder or several items as one zip.
 * Other browsers ignore the entry, and the Download command stays the dependable way.
 * The address has to be known as the drag starts, which is why nothing here asks the server first.
 */
export function setDragDownload(dataTransfer: DataTransfer, rootSlug: string, items: Dragged[]) {
  const first = items[0];
  if (!first) return;
  const single = items.length === 1 && first.kind === "file";
  const path = single ? downloadUrl(rootSlug, first.path) : zipDownloadUrl(rootSlug, items.map((item) => item.path));
  const url = new URL(path, location.href).href;
  if (url.length > MAX_URL_LENGTH) return;
  const name = single ? first.name : items.length === 1 ? `${first.name}.zip` : "Kago.zip";
  // The three parts are separated by colons, so the name cannot hold one.
  dataTransfer.setData("DownloadURL", `${single ? "application/octet-stream" : "application/zip"}:${nfc(name).replace(/[:/\\]/g, "-")}:${url}`);
}

const PREVIEW_SIZE = 48;

/**
 * What follows the pointer: the item's own icon or thumbnail rather than a ghost of its whole row,
 * with the number of items on its corner when there are several.
 */
export function setDragPreview(dataTransfer: DataTransfer, source: Element, count: number) {
  const picture = source.querySelector("img[src], svg.kago-tile, svg.kago-icon");
  if (!picture) return;
  const preview = document.createElement("div");
  // It has to be in the document to be drawn, so it waits off-screen until the browser has taken its picture.
  preview.className = "pointer-events-none fixed -top-[200px] -left-[200px] flex size-16 items-center justify-center";
  for (const offset of count > 1 ? [5, 0] : [0]) {
    const copy = picture.cloneNode(true) as HTMLElement | SVGElement;
    copy.removeAttribute("loading");
    copy.setAttribute("class", `${copy.getAttribute("class") ?? ""} absolute drop-shadow-sm`);
    Object.assign(copy.style, { width: "auto", height: "auto", maxWidth: `${PREVIEW_SIZE}px`, maxHeight: `${PREVIEW_SIZE}px`, translate: `${offset}px ${-offset}px`, opacity: offset ? "0.6" : "" });
    if (copy instanceof SVGElement) Object.assign(copy.style, { width: `${PREVIEW_SIZE}px`, height: `${PREVIEW_SIZE}px` });
    preview.append(copy);
  }
  if (count > 1) {
    const badge = document.createElement("span");
    badge.className = "absolute top-0 right-0 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#ff3b30] px-1.5 text-[11px] font-semibold text-white tabular-nums shadow-sm";
    badge.textContent = String(count);
    preview.append(badge);
  }
  document.body.append(preview);
  dataTransfer.setDragImage(preview, 32, 32);
  setTimeout(() => preview.remove());
}
