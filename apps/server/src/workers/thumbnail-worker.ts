import fs from "node:fs";
import { parentPort } from "node:worker_threads";
import AdmZip from "adm-zip";

/** What the worker is asked for: a picture of `source`, written to `target` for ffmpeg to shrink. */
export type ThumbnailJob = { id: number; kind: "pdf" | "embedded"; source: string; target: string; edge: number };
export type ThumbnailJobResult = { id: number; ok: boolean };

/** Both kinds are read whole into memory; larger files keep their icon. */
const MAX_BYTES = 128 * 1024 * 1024;

/**
 * The preview picture a program saved inside its own file: Office Open XML and OpenDocument keep one of the first page,
 * as do Pages, Numbers and Keynote. Word and Excel may save theirs as a Windows metafile, which nothing here can draw.
 */
const EMBEDDED_PICTURES = ["docProps/thumbnail.jpeg", "docProps/thumbnail.jpg", "docProps/thumbnail.png", "Thumbnails/thumbnail.png", "preview.jpg", "QuickLook/Thumbnail.jpg"];

let mupdf: Promise<typeof import("mupdf")> | undefined;

/** The first page of a PDF, drawn by MuPDF. The library is only loaded once a PDF asks for it. */
async function drawPdf(job: ThumbnailJob): Promise<boolean> {
  const { Document, Matrix, ColorSpace } = await (mupdf ??= import("mupdf"));
  const document = Document.openDocument(fs.readFileSync(job.source), "application/pdf");
  try {
    if (document.needsPassword() || document.countPages() === 0) return false;
    const page = document.loadPage(0);
    const [left, top, right, bottom] = page.getBounds();
    const scale = job.edge / Math.max(1, right - left, bottom - top);
    const pixmap = page.toPixmap(Matrix.scale(scale, scale), ColorSpace.DeviceRGB, false, true);
    fs.writeFileSync(job.target, pixmap.asPNG());
    pixmap.destroy();
    page.destroy();
    return true;
  } finally {
    document.destroy();
  }
}

function extractEmbedded(job: ThumbnailJob): boolean {
  const zip = new AdmZip(job.source);
  for (const name of EMBEDDED_PICTURES) {
    const data = zip.getEntry(name)?.getData();
    if (!data?.length) continue;
    fs.writeFileSync(job.target, data);
    return true;
  }
  return false;
}

parentPort!.on("message", async (job: ThumbnailJob) => {
  let ok = false;
  try {
    if (fs.statSync(job.source).size <= MAX_BYTES) ok = job.kind === "pdf" ? await drawPdf(job) : extractEmbedded(job);
  } catch {
    // A file that cannot be read as what its name says has no thumbnail.
  }
  parentPort!.postMessage({ id: job.id, ok } satisfies ThumbnailJobResult);
});
