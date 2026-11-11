import fs from "node:fs";
import { parentPort } from "node:worker_threads";
import zlib from "node:zlib";
import AdmZip from "adm-zip";
import { readSplats } from "../lib/splat-decode.js";
import { renderSplats } from "../lib/splat-render.js";

/** What the worker is asked for: a picture of `source`, written to `target` for ffmpeg to shrink. */
export type ThumbnailJob = { id: number; kind: "pdf" | "embedded" | "splat"; source: string; target: string; edge: number };
export type ThumbnailJobResult = { id: number; ok: boolean };

/** PDFs and documents are read whole into memory; larger files keep their icon. Splat files are read only in part. */
const MAX_BYTES = 128 * 1024 * 1024;
/** About this many splats are drawn, out of however many a file holds: drawing more takes longer than it shows. */
const SPLAT_BUDGET = 2_000_000;

/**
 * The preview picture a program saved inside its own file: Office Open XML and OpenDocument keep one of the first page,
 * as do Pages, Numbers and Keynote. Word and Excel may save theirs as a Windows metafile, which nothing here can draw.
 */
const EMBEDDED_PICTURES = ["docProps/thumbnail.jpeg", "docProps/thumbnail.jpg", "docProps/thumbnail.png", "Thumbnails/thumbnail.png", "preview.jpg", "QuickLook/Thumbnail.jpg"];

const MAX_PICTURE_BYTES = 32 * 1024 * 1024;

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
    const entry = zip.getEntry(name);
    // A preview picture is small. One that says it unpacks to more is not unpacked to find out.
    if (!entry || entry.header.size > MAX_PICTURE_BYTES) continue;
    // What it says is not relied on either: unpacking stops at the same size, and a picture that would pass it is given up on.
    const packed = entry.getCompressedData();
    const data = entry.header.method === 8 ? zlib.inflateRawSync(packed, { maxOutputLength: MAX_PICTURE_BYTES }) : entry.header.method === 0 && packed.length <= MAX_PICTURE_BYTES ? packed : null;
    if (!data?.length) continue;
    fs.writeFileSync(job.target, data);
    return true;
  }
  return false;
}

/**
 * A splat scene as the preview opens on it. sharp is used here directly, not in the picture process: it unpacks a
 * SOG's pictures one at a time, each holding one thread of the pool file reads go through for a fraction of a
 * second, and only while the machine is otherwise idle.
 */
async function drawSplats(job: ThumbnailJob): Promise<boolean> {
  const cloud = await readSplats(job.source, SPLAT_BUDGET);
  if (!cloud) return false;
  const pixels = renderSplats(cloud, job.edge);
  if (!pixels.some((value, index) => index % 4 === 3 && value > 0)) return false;
  const { default: sharp } = await import("sharp");
  await sharp(pixels, { raw: { width: job.edge, height: job.edge, channels: 4 } }).png({ compressionLevel: 1 }).toFile(job.target);
  return true;
}

parentPort!.on("message", async (job: ThumbnailJob) => {
  let ok = false;
  try {
    if (job.kind === "splat") ok = await drawSplats(job);
    else if (fs.statSync(job.source).size <= MAX_BYTES) ok = job.kind === "pdf" ? await drawPdf(job) : extractEmbedded(job);
  } catch {
    // A file that cannot be read as what its name says has no thumbnail.
  }
  parentPort!.postMessage({ id: job.id, ok } satisfies ThumbnailJobResult);
});
