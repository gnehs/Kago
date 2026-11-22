import { Readable } from "node:stream";
import type { FastifyReply, FastifyRequest } from "fastify";
import { publicError } from "../lib/errors.js";
import { nfc } from "../lib/filename.js";
import { sendSource } from "../lib/send-file.js";
import { isBrowserViewable } from "../lib/viewable.js";
import type { FileSource } from "../services/storage.service.js";

/**
 * The page that holds another service inside Kago. The interface frames this page, and this page frames the
 * service, so the interface itself stays unable to frame anything but Kago: the one place a frame from elsewhere
 * can stand is here, around an address that was checked when it was saved. Whatever the service then goes to
 * inside its frame (its sign-in page, say) is its own affair.
 */
export const FRAME_POLICY = "default-src 'none'; frame-src http: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/**
 * What the framed service may do: run, keep its own sign-in, open tabs and save files. It is not given the tab
 * Kago is in: without `allow-top-navigation` it cannot take the person away from their desktop.
 */
const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock allow-storage-access-by-user-activation";

export function framePage(url: string): string {
  const address = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{height:100%;margin:0;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe src="${address}" sandbox="${FRAME_SANDBOX}" allow="fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture" referrerpolicy="no-referrer"></iframe></body></html>`;
}

/** Header values must be latin1, so non-ASCII names travel in the RFC 5987 `filename*` form. */
export function contentDisposition(kind: "attachment" | "inline", rawFileName: string): string {
  const fileName = nfc(rawFileName);
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Anything that is, or was made out of, someone's file is sent as inert content: an SVG holds scripts, and one opened
 * at its own address would run them as the application. The page still shows it in an `<img>`, where nothing runs.
 */
export function sandboxContent(reply: FastifyReply): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; sandbox");
}

/**
 * Sends someone's file from Kago's own origin, where it must never run as the application. Opened directly it is
 * sandboxed, and only what a browser shows by itself goes inline. Anything that isn't a picture, a sound or a video
 * goes as plain bytes, so a page can't load an uploaded script or stylesheet as its own; fetch-based viewers still read it.
 */
export function sendUserFile(request: FastifyRequest, reply: FastifyReply, source: FileSource, contentType: string, fileName: string, save = false) {
  reply.header("Content-Disposition", contentDisposition(!save && isBrowserViewable(contentType) ? "inline" : "attachment", fileName));
  sandboxContent(reply);
  const passive = isBrowserViewable(contentType) || /^(image|audio|video)\//.test(contentType);
  return sendSource(request, reply, source, passive ? contentType : "application/octet-stream");
}

export const isPlayable = (contentType: string) => /^(video|audio)\//.test(contentType);

/** Aborts when the client drops the connection, so work done for an answer nobody will read can stop. */
export function abortOnClose(reply: FastifyReply): AbortController {
  const gone = new AbortController();
  reply.raw.on("close", () => gone.abort());
  return gone;
}

/** Sends `head`, then each batch as `{ items }`, then `end()`, one JSON value per line, as the batches are produced. */
export function sendNdjson(reply: FastifyReply, gone: AbortSignal, head: unknown, batches: AsyncIterable<unknown>, end: () => unknown) {
  const line = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);
  reply.header("Content-Type", "application/x-ndjson; charset=utf-8");
  reply.header("X-Accel-Buffering", "no");
  return reply.send(
    Readable.from(
      (async function* () {
        yield line(head);
        try {
          for await (const items of batches) yield line({ items });
          yield line(end());
        } catch (error) {
          if (gone.aborted) return;
          // The answer has begun and can no longer be turned into a refusal; its last line says what went wrong.
          yield line(publicError(error).body);
        }
      })()
    )
  );
}
