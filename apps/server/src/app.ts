import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { lookup } from "mime-types";
import { z } from "zod";
import type { Env } from "./config/env.js";
import { openDb } from "./db/db.js";
import { AppError, publicError } from "./lib/errors.js";
import { nfc } from "./lib/filename.js";
import { sendFile } from "./lib/send-file.js";
import { isBrowserViewable } from "./lib/viewable.js";
import { AuditService } from "./services/audit.service.js";
import { AuthService, changePasswordSchema, createUserSchema, loginSchema, patchUserSchema, resetPasswordSchema, setupAdminSchema } from "./services/auth.service.js";
import { FsService, finderTagsSchema, fsQuerySchema, maxUploadFiles, mkdirSchema, renameSchema, sqliteRowsSchema, writeTextSchema } from "./services/fs.service.js";
import { ImageService } from "./services/image.service.js";
import { createGroupSchema, GroupService } from "./services/group.service.js";
import { MediaService, mediaSessionSchema, mediaStreamSchema } from "./services/media.service.js";
import { PathService } from "./services/path.service.js";
import { permissionInputSchema, PermissionService } from "./services/permission.service.js";
import { rootPatchSchema, RootService } from "./services/root.service.js";
import { ShareService, shareSchema } from "./services/share.service.js";
import { ShelfService } from "./services/shelf.service.js";
import { TagService, tagSchema } from "./services/tag.service.js";
import { taskInputSchema, TaskService } from "./services/task.service.js";
import { workspaceSchema, WorkspaceService } from "./services/workspace.service.js";
import { WorkerManager } from "./workers/worker-manager.js";
import { EventHub } from "./ws/events.js";

export async function buildApp(env: Env) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 * 25 });
  const db = openDb(env);
  const events = new EventHub();
  const audit = new AuditService(db);
  const roots = new RootService(db, env.dataDir);
  const paths = new PathService(roots);
  const permissions = new PermissionService(db, audit);
  const auth = new AuthService(db, env);
  const images = new ImageService(env.appDataDir);
  const fsService = new FsService(paths, permissions, audit, env.appDataDir, images);
  const workspace = new WorkspaceService(db, roots, paths);
  const tasks = new TaskService(db, paths, permissions, audit, events, env.appDataDir, fsService);
  const shelves = new ShelfService(db, paths, permissions, events, audit);
  const tags = new TagService(db, paths, permissions, audit);
  const shares = new ShareService(db, paths, permissions, audit, events);
  const groups = new GroupService(db);
  const media = new MediaService(env.appDataDir);
  const workers = new WorkerManager(tasks, env, events);

  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(multipart, {
    // Uploads are streamed to disk, so there is no per-file size limit; without this the plugin falls back to bodyLimit.
    limits: { fileSize: Infinity, files: maxUploadFiles, fields: 4, parts: maxUploadFiles + 4 }
  });
  await app.register(websocket);

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof z.ZodError) {
      auditRequestFailure(request, "INVALID_INPUT", 400);
      void reply.status(400).send({ error: "Invalid input", code: "INVALID_INPUT", issues: error.issues });
      return;
    }
    const safe = publicError(error);
    auditRequestFailure(request, safe.body.code, safe.statusCode);
    void reply.status(safe.statusCode).send(safe.body);
  });

  function auditRequestFailure(request: FastifyRequest, code: string, statusCode: number): void {
    if (!request.url.startsWith("/api/") && !request.url.startsWith("/s/")) return;
    const actor = auth.actorFromRequest(request);
    audit.write({
      actorType: actor ? "user" : "system",
      actorId: actor?.id,
      action: statusCode === 403 ? "request_denied" : "request_failed",
      target: { method: request.method, route: auditRoute(request), code, statusCode },
      result: statusCode === 403 ? "denied" : "failure",
      ip: request.ip,
      userAgent: request.headers["user-agent"]
    });
  }

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/api/") && !request.url.startsWith("/s/")) return;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    if (request.headers["x-kago-csrf"] !== "1") {
      throw new AppError(403, "Missing CSRF header", "CSRF_REQUIRED");
    }
  });

  await auth.ensureInitialAdminFromEnv();
  roots.syncFromDataDir();
  registerApi(app, { auth, audit, roots, paths, permissions, fsService, workspace, tasks, shelves, tags, shares, groups, media, images, events, db });

  app.get("/ws", {
    websocket: true,
    preValidation: async (request) => {
      assertAllowedWebSocketOrigin(request);
      auth.requireActor(request);
    }
  }, (socket, request) => {
    const actor = auth.requireActor(request);
    events.add(socket, actor);
    socket.send(JSON.stringify({ type: "connected" }));
  });

  const webDist = resolveWebDist(env);
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/") || request.url === "/ws") {
        void reply.status(404).send({ error: "Not found", code: "NOT_FOUND" });
        return;
      }
      void reply.sendFile("index.html");
    });
  }

  app.addHook("onClose", async () => {
    await workers.stop();
    media.stop();
    await images.stop();
    db.close();
  });

  workers.start();
  return app;
}

/** Header values must be latin1, so non-ASCII names travel in the RFC 5987 `filename*` form. */
function contentDisposition(kind: "attachment" | "inline", rawFileName: string): string {
  const fileName = nfc(rawFileName);
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

function resolveWebDist(env: Env): string {
  const candidates = [
    env.webDistDir,
    path.resolve(import.meta.dirname, "../../web/dist"),
    path.resolve(import.meta.dirname, "../apps/web/dist")
  ].filter((candidate): candidate is string => Boolean(candidate));
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
}

function auditRoute(request: FastifyRequest): string {
  if (request.routeOptions.url) return request.routeOptions.url;
  if (request.url.startsWith("/s/")) return "/s/:token";
  return request.url.split("?", 1)[0] ?? request.url;
}

type Services = {
  auth: AuthService;
  audit: AuditService;
  roots: RootService;
  paths: PathService;
  permissions: PermissionService;
  fsService: FsService;
  workspace: WorkspaceService;
  tasks: TaskService;
  shelves: ShelfService;
  tags: TagService;
  shares: ShareService;
  groups: GroupService;
  media: MediaService;
  images: ImageService;
  events: EventHub;
  db: ReturnType<typeof openDb>;
};

function registerApi(app: FastifyInstance, services: Services) {
  const requireActor = (request: FastifyRequest) => services.auth.requireActor(request);
  const requireAdmin = (request: FastifyRequest) => {
    const actor = services.auth.requireActor(request);
    if (actor.role !== "ADMIN") {
      services.audit.write({
        actorType: "user",
        actorId: actor.id,
        action: "permission_denied",
        target: { action: "admin" },
        result: "denied",
        ip: request.ip,
        userAgent: request.headers["user-agent"]
      });
      throw new AppError(403, "Admin required", "ADMIN_REQUIRED");
    }
    return actor;
  };
  const publishPermissionUpdated = (actor: ReturnType<typeof requireActor>, principalType: string, principalId: string) => {
    services.events.publish({ type: "permission.updated", userId: actor.id });
    if (principalType === "user" && principalId !== actor.id) {
      services.events.publish({ type: "permission.updated", userId: principalId });
    }
  };

  app.get("/api/auth/setup", async () => ({ needsSetup: services.auth.needsSetup() }));
  app.post("/api/auth/setup", async (request, reply) => {
    const actor = await services.auth.setupAdmin(request, reply, setupAdminSchema.parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "setup_admin", result: "success" });
    return { user: actor };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    try {
      const actor = await services.auth.login(request, reply, input.email, input.password);
      services.audit.write({ actorType: "user", actorId: actor.id, action: "login_success", result: "success" });
      return { user: actor };
    } catch (error) {
      services.audit.write({ actorType: "system", action: "login_failed", target: { email: input.email }, result: "failure" });
      throw error;
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const actor = services.auth.actorFromRequest(request);
    services.auth.logout(request, reply);
    if (actor) services.audit.write({ actorType: "user", actorId: actor.id, action: "logout", result: "success" });
    return { ok: true };
  });

  app.get("/api/auth/me", async (request) => ({ user: services.auth.actorFromRequest(request) }));
  app.post("/api/auth/password", async (request) => {
    const actor = requireActor(request);
    await services.auth.changePassword(request, actor, changePasswordSchema.parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "password_change", result: "success" });
    return { ok: true };
  });

  app.get("/api/admins", async (request) => {
    requireActor(request);
    return services.auth.listAdminContacts();
  });
  app.get("/api/users", async (request) => {
    requireAdmin(request);
    return services.auth.listUsers();
  });
  app.post("/api/users", async (request) => {
    const actor = requireAdmin(request);
    const user = await services.auth.createUser(createUserSchema.parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "user_create", target: user, result: "success" });
    return user;
  });
  app.patch("/api/users/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = patchUserSchema.parse(request.body);
    const user = services.auth.patchUser(params.id, body);
    if (body.disabled !== undefined) {
      services.audit.write({ actorType: "user", actorId: actor.id, action: "user_disable", target: { userId: params.id, disabled: body.disabled }, result: "success" });
    }
    return user;
  });

  app.post("/api/users/:id/password", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    await services.auth.setPassword(request, params.id, resetPasswordSchema.parse(request.body).password);
    services.audit.write({ actorType: "user", actorId: actor.id, action: "password_reset", target: { userId: params.id }, result: "success" });
    return { ok: true };
  });
  app.get("/api/groups", async (request) => {
    requireAdmin(request);
    return services.groups.list();
  });
  app.post("/api/groups", async (request) => {
    const actor = requireAdmin(request);
    const group = services.groups.create(createGroupSchema.parse(request.body).name);
    services.audit.write({ actorType: "user", actorId: actor.id, action: "group_create", target: group, result: "success" });
    return group;
  });
  app.post("/api/groups/:id/members", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ userId: z.string() }).parse(request.body);
    services.groups.addMember(params.id, body.userId);
    services.audit.write({ actorType: "user", actorId: actor.id, action: "group_member_add", target: { groupId: params.id, userId: body.userId }, result: "success" });
    return { ok: true };
  });
  app.delete("/api/groups/:id/members/:userId", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string(), userId: z.string() }).parse(request.params);
    services.groups.removeMember(params.id, params.userId);
    services.audit.write({ actorType: "user", actorId: actor.id, action: "group_member_remove", target: { groupId: params.id, userId: params.userId }, result: "success" });
    return { ok: true };
  });

  app.get("/api/roots", async (request) => {
    const actor = requireActor(request);
    return services.roots
      .listMounted()
      .filter((root) =>
        services.permissions.can(actor, "list", root, "/").allowed ||
        services.permissions.canReachListableDescendant(actor, root, "/")
      )
      .map(({ base_path: _basePath, ...root }) => root);
  });
  app.patch("/api/roots/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const root = services.roots.patch(params.id, rootPatchSchema.parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "root_update", rootId: root.id, result: "success" });
    return { ...root, base_path: undefined };
  });

  app.get("/api/workspace", async (request) => {
    const actor = requireActor(request);
    return services.workspace.get(actor.id);
  });
  app.put("/api/workspace", async (request) => {
    const actor = requireActor(request);
    const saved = services.workspace.save(actor.id, workspaceSchema.parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "workspace_update", result: "success" });
    services.events.publish({ type: "workspace.updated", userId: actor.id });
    return saved;
  });

  app.get("/api/fs/list", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    return services.fsService.list(actor, query.rootSlug, query.path);
  });
  app.get("/api/fs/meta", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    return services.fsService.meta(actor, query.rootSlug, query.path);
  });
  app.get("/api/fs/download", async (request, reply) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.download(actor, query.rootSlug, query.path);
    reply.header("Content-Disposition", contentDisposition("attachment", path.basename(file.safe.absolutePath)));
    return sendFile(request, reply, file.safe.absolutePath, file.stat, file.contentType);
  });
  app.get("/api/fs/preview", async (request, reply) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.preview(actor, query.rootSlug, query.path);
    return sendFile(request, reply, file.safe.absolutePath, file.stat, file.contentType);
  });
  app.put("/api/fs/content", async (request) => services.fsService.writeText(requireActor(request), writeTextSchema.parse(request.body)));
  app.get("/api/fs/sqlite", async (request) => {
    const query = fsQuerySchema.parse(request.query);
    return services.fsService.sqliteOverview(requireActor(request), query.rootSlug, query.path);
  });
  app.get("/api/fs/sqlite/rows", async (request) => services.fsService.sqliteRows(requireActor(request), sqliteRowsSchema.parse(request.query)));
  app.get("/api/fs/image", async (request, reply) => {
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.preview(requireActor(request), query.rootSlug, query.path);
    const rendition = await services.images.rendition(file.safe.absolutePath, file.stat);
    reply.header("Cache-Control", "private, max-age=86400");
    return sendFile(request, reply, rendition, await fs.promises.stat(rendition), "image/jpeg");
  });
  app.get("/api/fs/exif", async (request) => {
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.preview(requireActor(request), query.rootSlug, query.path);
    return services.images.metadata(file.safe.absolutePath);
  });
  app.get("/api/fs/thumbnail", async (request, reply) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const thumbnail = await services.fsService.thumbnail(actor, query.rootSlug, query.path);
    reply.header("Content-Type", thumbnail.contentType);
    reply.header("Cache-Control", "private, max-age=86400");
    if ("data" in thumbnail) return thumbnail.data;
    reply.header("Content-Length", String(thumbnail.size));
    return fs.createReadStream(thumbnail.path);
  });
  app.get("/api/media/info", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.preview(actor, query.rootSlug, query.path);
    return services.media.info(file.safe.absolutePath, file.stat);
  });
  app.get("/api/media/subtitles", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.preview(actor, query.rootSlug, query.path);
    const sidecars = await services.fsService.subtitles(actor, query.rootSlug, query.path);
    // Something ffprobe cannot read simply has no streams of its own to offer.
    const info = await services.media.info(file.safe.absolutePath, file.stat).catch(() => null);
    const own = new URLSearchParams({ rootSlug: query.rootSlug, path: query.path }).toString();
    const embedded = info?.subtitles ?? [];
    return {
      tracks: [
        ...sidecars.map(({ path: sidecarPath, name, ...track }) => ({
          ...track,
          id: `file:${sidecarPath}`,
          embedded: false,
          url: `/api/fs/preview?${new URLSearchParams({ rootSlug: query.rootSlug, path: sidecarPath }).toString()}`
        })),
        ...embedded
          .filter((stream) => stream.text)
          .map(({ index, codec, text, ...track }) => ({
            ...track,
            format: codec === "ass" || codec === "ssa" ? "ass" : "srt",
            id: `stream:${index}`,
            embedded: true,
            url: `/api/media/subtitle?${own}&index=${index}`
          }))
      ],
      fonts: (info?.fonts ?? []).map((font) => `/api/media/attachment?${own}&index=${font.index}`),
      /** Picture subtitles (Blu-ray, DVD) that cannot be drawn in the browser. */
      unsupported: embedded.filter((stream) => !stream.text).length
    };
  });
  app.get("/api/media/subtitle", async (request, reply) => {
    const actor = requireActor(request);
    const query = mediaStreamSchema.parse(request.query);
    const file = await services.fsService.preview(actor, query.rootSlug, query.path);
    const subtitle = await services.media.subtitle(file.safe.absolutePath, file.stat, query.index);
    reply.header("Cache-Control", "private, max-age=3600");
    return sendFile(request, reply, subtitle.file, await fs.promises.stat(subtitle.file), "text/plain; charset=utf-8");
  });
  app.get("/api/media/attachment", async (request, reply) => {
    const actor = requireActor(request);
    const query = mediaStreamSchema.parse(request.query);
    const file = await services.fsService.preview(actor, query.rootSlug, query.path);
    const font = await services.media.font(file.safe.absolutePath, file.stat, query.index);
    reply.header("Cache-Control", "private, max-age=3600");
    return sendFile(request, reply, font, await fs.promises.stat(font), "application/octet-stream");
  });
  app.post("/api/media/sessions", async (request) => {
    const actor = requireActor(request);
    const input = mediaSessionSchema.parse(request.body);
    const file = await services.fsService.preview(actor, input.rootSlug, input.path);
    const session = await services.media.createSession(actor.id, file.safe.absolutePath, file.stat, input.height, input.audioIndex);
    return { id: session.id, playlistUrl: `/api/media/sessions/${session.id}/index.m3u8` };
  });
  app.get("/api/media/sessions/:id/:file", async (request, reply) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string().min(1), file: z.string().regex(/^(index\.m3u8|\d{1,9}\.ts)$/) }).parse(request.params);
    reply.header("Cache-Control", "no-store");
    if (params.file === "index.m3u8") {
      reply.header("Content-Type", "application/vnd.apple.mpegurl");
      return services.media.playlist(actor.id, params.id);
    }
    const segment = await services.media.segment(actor.id, params.id, Number.parseInt(params.file, 10));
    const stat = await fs.promises.stat(segment);
    reply.header("Content-Type", "video/mp2t");
    reply.header("Content-Length", String(stat.size));
    return reply.send(fs.createReadStream(segment));
  });
  app.delete("/api/media/sessions/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string().min(1) }).parse(request.params);
    services.media.close(actor.id, params.id);
    return { ok: true };
  });

  app.post("/api/fs/mkdir", async (request) => {
    const actor = requireActor(request);
    const input = mkdirSchema.parse(request.body);
    return services.fsService.mkdir(actor, input.rootSlug, input.path, input.name);
  });
  app.post("/api/fs/rename", async (request) => {
    const actor = requireActor(request);
    const input = renameSchema.parse(request.body);
    return services.fsService.rename(actor, input.rootSlug, input.path, input.name);
  });
  app.put("/api/fs/finder-tags", async (request) => services.fsService.setFinderTags(requireActor(request), finderTagsSchema.parse(request.body)));
  app.post("/api/fs/upload", async (request) => {
    const actor = requireActor(request);
    // Files are streamed straight to their destination, so an upload is bounded by free disk space rather than by a temp copy.
    const fields: Record<string, unknown> = {};
    const uploaded = [];
    for await (const part of request.parts()) {
      if (part.type === "field") {
        fields[part.fieldname] = part.value;
        continue;
      }
      // The destination fields are sent ahead of the files.
      const input = uploadRequestSchema.parse(fields);
      uploaded.push(await services.fsService.upload(actor, input.rootSlug, input.path, part.filename, part.file));
    }
    if (uploaded.length === 0) throw new AppError(400, "At least one file is required", "UPLOAD_FILE_REQUIRED");
    return { items: uploaded };
  });

  app.get("/api/tasks", async (request) => services.tasks.list(requireActor(request)));
  app.post("/api/tasks", async (request) => services.tasks.create(requireActor(request), taskInputSchema.parse(request.body)));
  app.get("/api/tasks/:id", async (request) => {
    const actor = requireActor(request);
    return services.tasks.getForActor(actor, z.object({ id: z.string() }).parse(request.params).id);
  });
  app.get("/api/tasks/:id/download", async (request, reply) => {
    const actor = requireActor(request);
    const file = await services.tasks.openDownload(actor, z.object({ id: z.string() }).parse(request.params).id);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Length", String(file.size));
    reply.header("Content-Disposition", contentDisposition("attachment", file.fileName));
    return fs.createReadStream(file.path);
  });
  app.post("/api/tasks/:id/cancel", async (request) => {
    const actor = requireActor(request);
    return services.tasks.cancel(actor, z.object({ id: z.string() }).parse(request.params).id);
  });
  app.post("/api/tasks/:id/retry", async (request) => {
    const actor = requireActor(request);
    return services.tasks.retry(actor, z.object({ id: z.string() }).parse(request.params).id);
  });
  app.post("/api/tasks/:id/pause", async (request) => {
    const actor = requireActor(request);
    return services.tasks.pause(actor, z.object({ id: z.string() }).parse(request.params).id);
  });
  app.post("/api/tasks/:id/resume", async (request) => {
    const actor = requireActor(request);
    return services.tasks.resume(actor, z.object({ id: z.string() }).parse(request.params).id);
  });

  app.get("/api/trash", async (request) => services.tasks.listTrash(requireActor(request)));
  app.delete("/api/trash", async (request) => services.tasks.emptyTrash(requireActor(request)));
  app.post("/api/trash/:id/restore", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    return services.tasks.createRestoreTrash(actor, params.id);
  });

  app.get("/api/shelves", async (request) => services.shelves.list(requireActor(request)));
  app.post("/api/shelves", async (request) => {
    const actor = requireActor(request);
    const body = z.object({ name: z.string().min(1) }).parse(request.body);
    return services.shelves.create(actor, body.name);
  });
  app.post("/api/shelves/:id/items", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ rootSlug: z.string(), path: z.string() }).parse(request.body);
    return services.shelves.addItem(actor, params.id, body.rootSlug, body.path);
  });
  app.delete("/api/shelves/:id/items/:itemId", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string(), itemId: z.string() }).parse(request.params);
    services.shelves.removeItem(actor, params.id, params.itemId);
    return { ok: true };
  });
  app.post("/api/shelves/:id/tasks", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({
      type: z.enum(["copy", "move", "compress"]),
      destination: z.object({ rootSlug: z.string(), path: z.string() })
    }).parse(request.body);
    const items = services.shelves.itemsForTask(actor, params.id);
    return services.tasks.create(actor, {
      type: body.type,
      sources: items.map((item) => ({ rootSlug: item.root_slug, path: item.path })),
      destination: body.destination
    });
  });

  app.get("/api/tags", async (request) => services.tags.list(requireActor(request)));
  app.post("/api/tags", async (request) => services.tags.create(requireActor(request), tagSchema.parse(request.body)));
  app.get("/api/tags/file", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    return services.tags.getFileTags(actor, query.rootSlug, query.path);
  });
  app.put("/api/tags/file", async (request) => {
    const actor = requireActor(request);
    const body = z.object({ rootSlug: z.string(), path: z.string(), tagIds: z.array(z.string()) }).parse(request.body);
    return services.tags.setFileTags(actor, body.rootSlug, body.path, body.tagIds);
  });

  app.get("/api/permissions", async (request) => {
    const actor = requireActor(request);
    const query = z.object({
      rootId: z.string().optional(),
      rootSlug: z.string().optional(),
      path: z.string().optional()
    }).parse(request.query);
    const root = query.rootSlug ? services.roots.getBySlug(query.rootSlug) : query.rootId ? services.roots.getById(query.rootId) : null;
    const rootId = root?.id;
    if (!root && actor.role !== "ADMIN") throw new AppError(400, "rootId or rootSlug is required", "ROOT_REQUIRED");
    if (query.path && !rootId) throw new AppError(400, "rootId or rootSlug is required for path lookups", "ROOT_REQUIRED");
    if (root) {
      const permissionPath = services.paths.normalizeLogicalPath(query.path ?? "/");
      services.permissions.require(actor, "manage_permissions", root, permissionPath);
    }
    if (query.path && rootId) return services.permissions.listForPath(rootId, services.paths.normalizeLogicalPath(query.path));
    return services.permissions.list(rootId);
  });
  app.post("/api/permissions", async (request) => {
    const actor = requireActor(request);
    const input = permissionInputSchema.parse(request.body);
    const root = services.roots.getById(input.rootId);
    const pathPrefix = services.paths.normalizeLogicalPath(input.pathPrefix);
    services.permissions.require(actor, "manage_permissions", root, pathPrefix);
    const item = services.permissions.create({ ...input, pathPrefix });
    services.audit.write({ actorType: "user", actorId: actor.id, action: "permission_change", rootId: item.root_id, target: item, result: "success" });
    publishPermissionUpdated(actor, item.principal_type, item.principal_id);
    return item;
  });
  app.delete("/api/permissions/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const rule = services.permissions.get(params.id);
    const root = services.roots.getById(rule.root_id);
    services.permissions.require(actor, "manage_permissions", root, rule.path_prefix);
    services.permissions.delete(params.id);
    services.audit.write({ actorType: "user", actorId: actor.id, action: "permission_change", target: { ruleId: params.id, deleted: true }, result: "success" });
    publishPermissionUpdated(actor, rule.principal_type, rule.principal_id);
    return { ok: true };
  });

  app.get("/api/shares", async (request) => services.shares.list(requireActor(request)));
  app.post("/api/shares", async (request) => services.shares.create(requireActor(request), shareSchema.parse(request.body)));
  app.patch("/api/shares/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ disabled: z.boolean().optional() }).parse(request.body);
    return services.shares.patch(actor, params.id, body);
  });
  app.delete("/api/shares/:id", async (request) => {
    const actor = requireActor(request);
    services.shares.delete(actor, z.object({ id: z.string() }).parse(request.params).id);
    return { ok: true };
  });

  app.get("/api/audit", async (request) => {
    requireAdmin(request);
    return services.audit.list();
  });

  app.get("/s/:token", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    if (wantsHtml(request)) {
      return reply.sendFile("index.html");
    }
    return services.shares.publicInfo(params.token, shareAccessCookie(request, params.token));
  });

  app.post("/s/:token/auth", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const body = z.object({ password: z.string().min(1) }).parse(request.body);
    const auth = await services.shares.authenticatePublicShare(params.token, body.password);
    reply.setCookie(shareAccessCookieName(params.token), auth.accessToken, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.protocol === "https",
      path: `/s/${params.token}`,
      maxAge: 60 * 60 * 12
    });
    return { ok: true, shareId: auth.shareId };
  });

  app.get("/s/:token/download", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const safe = await services.shares.publicDownload(params.token, shareAccessCookie(request, params.token));
    const stat = await fs.promises.stat(safe.absolutePath);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    reply.header("Content-Disposition", contentDisposition("attachment", path.basename(safe.absolutePath)));
    return sendFile(request, reply, safe.absolutePath, stat, lookup(safe.absolutePath) || "application/octet-stream");
  });

  app.get("/s/:token/preview", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const safe = await services.shares.publicPreview(params.token, shareAccessCookie(request, params.token));
    const stat = await fs.promises.stat(safe.absolutePath);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    const contentType = lookup(safe.absolutePath) || "application/octet-stream";
    if (!isBrowserViewable(contentType)) throw new AppError(415, "This kind of file cannot be viewed in the browser", "PREVIEW_UNSUPPORTED");
    reply.header("Content-Disposition", contentDisposition("inline", path.basename(safe.absolutePath)));
    reply.header("X-Content-Type-Options", "nosniff");
    // Opened in a tab of its own, an SVG is a document: without this its scripts would run as Kago.
    if (contentType === "image/svg+xml") reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    return sendFile(request, reply, safe.absolutePath, stat, contentType);
  });

  app.post("/s/:token/upload", async (request) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const target = await services.shares.publicUploadTarget(params.token, shareAccessCookie(request, params.token));
    const parts = request.parts();
    const uploaded = [];
    let fileCount = 0;
    for await (const part of parts) {
      if (part.type === "file") {
        fileCount += 1;
        if (fileCount > maxUploadFiles) throw new AppError(413, "Too many files in one upload", "TOO_MANY_UPLOAD_FILES");
        uploaded.push(await services.fsService.publicUpload(target.safe.root.slug, target.safe.logicalPath, part.filename, part.file, target.share.id));
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

function wantsHtml(request: FastifyRequest): boolean {
  const accept = request.headers.accept ?? "";
  return accept.includes("text/html") && !accept.includes("application/json");
}

function assertAllowedWebSocketOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (!origin) return;
  const host = request.headers.host;
  if (!host) throw new AppError(403, "WebSocket origin is not allowed", "WS_ORIGIN_DENIED");
  try {
    if (new URL(origin).host === host) return;
  } catch {
    // Fall through to the shared denial below.
  }
  throw new AppError(403, "WebSocket origin is not allowed", "WS_ORIGIN_DENIED");
}

const uploadRequestSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1)
});
