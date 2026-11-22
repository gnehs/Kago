import type { FastifyInstance, FastifyRequest } from "fastify";
import { lookup } from "mime-types";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { randomToken } from "../lib/crypto.js";
import { isBrowserViewable } from "../lib/viewable.js";
import { MAX_PASSWORD } from "../services/auth.service.js";
import { maxUploadFiles } from "../services/fs.service.js";
import { SHARE_ACCESS_SECONDS, SHARE_VISIT_SECONDS, shareSchema, type ShareVisitor } from "../services/share.service.js";
import { isPlayable, sendUserFile } from "./respond.js";
import type { Services } from "./services.js";
import { guards } from "./guards.js";

export function register(app: FastifyInstance, s: Services) {
  const { requireActor } = guards(s);

  app.get("/api/shares", async (request) => s.shares.list(requireActor(request)));
  app.post("/api/shares", async (request) => s.shares.create(requireActor(request), shareSchema.parse(request.body)));
  app.patch("/api/shares/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ disabled: z.boolean().optional() }).parse(request.body);
    return s.shares.patch(actor, params.id, body);
  });
  app.delete("/api/shares/:id", async (request) => {
    const actor = requireActor(request);
    s.shares.delete(actor, z.object({ id: z.string() }).parse(request.params).id);
    return { ok: true };
  });

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

  app.get("/s/:token/download", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const safe = await s.shares.publicDownload(params.token, shareVisitor(request, params.token), shareAccessCookie(request, params.token));
    const stat = await s.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    return sendUserFile(request, reply, s.storage.source(safe, stat), lookup(safe.logicalPath) || "application/octet-stream", s.storage.name(safe), true);
  });

  app.get("/s/:token/preview", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const safe = await s.shares.publicPreview(params.token, shareVisitor(request, params.token), shareAccessCookie(request, params.token));
    const stat = await s.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    const contentType = lookup(safe.logicalPath) || "application/octet-stream";
    if (!isBrowserViewable(contentType)) throw new AppError(415, "This kind of file cannot be viewed in the browser", "PREVIEW_UNSUPPORTED");
    if (isPlayable(contentType)) reply.raw.once("close", s.media.directPlay());
    return sendUserFile(request, reply, s.storage.source(safe, stat), contentType, s.storage.name(safe));
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
