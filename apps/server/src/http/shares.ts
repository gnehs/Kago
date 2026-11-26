import fs from "node:fs";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { lookup } from "mime-types";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { randomToken } from "../lib/crypto.js";
import { zipStream, type ZipEntry } from "../lib/zip-stream.js";
import { MAX_PASSWORD } from "../services/auth.service.js";
import { maxUploadFiles } from "../services/fs.service.js";
import { SHARE_ACCESS_SECONDS, SHARE_VISIT_SECONDS, shareListQuerySchema, sharePatchSchema, shareSchema, type ShareVisitor } from "../services/share.service.js";
import { contentDisposition, isPlayable, sandboxContent, sendUserFile } from "./respond.js";
import { idParams } from "./schemas.js";
import type { Services } from "./services.js";
import { signedIn } from "./guards.js";

const tokenParams = z.object({ token: z.string().min(1) });
const sharePathQuery = z.object({ path: z.string().min(1).optional() });

const userRoutes = signedIn((app, s) => {
  app.get("/api/shares", async (request) => s.shares.list(request.actor));
  app.post("/api/shares", async (request) => s.shares.create(request.actor, shareSchema.parse(request.body)));
  app.patch("/api/shares/:id", async (request) => {
    const params = idParams.parse(request.params);
    return s.shares.patch(request.actor, params.id, sharePatchSchema.parse(request.body));
  });
  app.post("/api/shares/:id/rotate", async (request) => s.shares.rotate(request.actor, idParams.parse(request.params).id));
  app.delete("/api/shares/:id", async (request) => {
    s.shares.delete(request.actor, idParams.parse(request.params).id);
    return { ok: true };
  });
});

export function register(app: FastifyInstance, s: Services) {
  app.get("/s/:token", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    if (wantsHtml(request)) {
      return reply.sendFile("index.html");
    }
    const visitor = shareVisitor(request, params.token);
    // The page asks this before it shows or fetches the file, so the visitor has a session by the time they are counted.
    if (!visitor.session) {
      reply.setCookie(shareVisitCookieName(params.token), randomToken(), {
        httpOnly: true,
        sameSite: "lax",
        secure: request.protocol === "https",
        path: `/s/${params.token}`,
        maxAge: SHARE_VISIT_SECONDS
      });
    }
    return s.shares.publicInfo(params.token, shareAccessCookie(request, params.token), visitor);
  });

  app.post("/s/:token/auth", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const body = z.object({ password: z.string().min(1).max(MAX_PASSWORD) }).parse(request.body);
    const auth = await s.shares.authenticatePublicShare(params.token, body.password, request.ip, shareVisitor(request, params.token));
    reply.setCookie(shareAccessCookieName(params.token), auth.accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.protocol === "https",
      path: `/s/${params.token}`,
      maxAge: SHARE_ACCESS_SECONDS
    });
    return { ok: true, shareId: auth.shareId };
  });

  // In a folder share `path` names a file or folder below the shared one; a file share has nothing below it.
  app.get("/s/:token/list", async (request) => {
    const params = tokenParams.parse(request.params);
    return s.shares.publicList(params.token, shareVisitor(request, params.token), shareAccessCookie(request, params.token), shareListQuerySchema.parse(request.query));
  });

  app.get("/s/:token/download", async (request, reply) => {
    const params = tokenParams.parse(request.params);
    const query = sharePathQuery.parse(request.query);
    const file = await s.shares.publicDownload(params.token, shareVisitor(request, params.token), shareAccessCookie(request, params.token), query.path);
    return sendUserFile(request, reply, s.storage.source(file.safe, file.stat), lookup(file.safe.logicalPath) || "application/octet-stream", s.storage.name(file.safe), true);
  });

  app.get("/s/:token/preview", async (request, reply) => {
    const params = tokenParams.parse(request.params);
    const query = sharePathQuery.parse(request.query);
    const file = await s.shares.publicPreview(params.token, shareVisitor(request, params.token), shareAccessCookie(request, params.token), query.path);
    if (isPlayable(file.contentType)) reply.raw.once("close", s.media.directPlay());
    return sendUserFile(request, reply, s.storage.source(file.safe, file.stat), file.contentType, s.storage.name(file.safe));
  });

  app.get("/s/:token/thumbnail", async (request, reply) => {
    const params = tokenParams.parse(request.params);
    const query = sharePathQuery.extend({ size: z.enum(["small", "medium"]).default("small") }).parse(request.query);
    const thumbnail = await s.shares.publicThumbnail(params.token, shareVisitor(request, params.token), shareAccessCookie(request, params.token), query.path, query.size === "medium");
    reply.header("Content-Type", thumbnail.contentType);
    reply.header("Cache-Control", "private, max-age=3600");
    // A picture ffmpeg could not draw is sent as the file itself, and that file may be an SVG.
    sandboxContent(reply);
    if ("data" in thumbnail) return thumbnail.data;
    reply.header("Content-Length", String(thumbnail.size));
    return fs.createReadStream(thumbnail.path);
  });

  app.get("/s/:token/zip", async (request, reply) => {
    const params = tokenParams.parse(request.params);
    const query = sharePathQuery.parse(request.query);
    const archive = await s.shares.publicZip(params.token, shareVisitor(request, params.token), shareAccessCookie(request, params.token), query.path);
    reply.raw.once("close", archive.release);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition("attachment", archive.fileName));
    reply.header("X-Accel-Buffering", "no");
    return reply.send(Readable.from(zipStream(listed(archive.entries), { level: 0 })));
  });

  app.post("/s/:token/upload", async (request) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const target = await s.shares.publicUploadTarget(params.token, shareAccessCookie(request, params.token));
    const parts = request.parts();
    const uploaded = [];
    let fileCount = 0;
    for await (const part of parts) {
      if (part.type === "file") {
        fileCount += 1;
        if (fileCount > maxUploadFiles) throw new AppError(413, "Too many files in one upload", "TOO_MANY_UPLOAD_FILES");
        uploaded.push(await s.fsService.publicUpload(target.safe.root.slug, target.safe.logicalPath, part.filename, part.file, target.share.id));
      }
    }
    return { items: uploaded };
  });
  userRoutes(app, s);
}

async function* listed(entries: ZipEntry[]): AsyncGenerator<ZipEntry> {
  yield* entries;
}

function shareAccessCookie(request: FastifyRequest, token: string): string | undefined {
  return request.cookies[shareAccessCookieName(token)];
}

function shareAccessCookieName(token: string): string {
  return `kago_share_${token.slice(0, 16)}`;
}

function shareVisitCookieName(token: string): string {
  return `kago_visit_${token.slice(0, 16)}`;
}

function shareVisitor(request: FastifyRequest, token: string): ShareVisitor {
  const session = request.cookies[shareVisitCookieName(token)];
  // The cookie is the visitor's own to write, so only what Kago could have set is taken for one.
  return { address: request.ip ?? "", session: session && /^[\w-]{20,64}$/.test(session) ? session : undefined };
}

function wantsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") && !accept.includes("application/json");
}
