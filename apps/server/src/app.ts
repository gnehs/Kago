import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "./config/env.js";
import { openDb } from "./db/db.js";
import { AppError, publicError } from "./lib/errors.js";
import { AuditService } from "./services/audit.service.js";
import { AuthService, createUserSchema, loginSchema } from "./services/auth.service.js";
import { FsService, fsQuerySchema, mkdirSchema, renameSchema } from "./services/fs.service.js";
import { createGroupSchema, GroupService } from "./services/group.service.js";
import { PathService } from "./services/path.service.js";
import { permissionInputSchema, PermissionService } from "./services/permission.service.js";
import { rootInputSchema, RootService } from "./services/root.service.js";
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
  const permissions = new PermissionService(db);
  const auth = new AuthService(db, env);
  const fsService = new FsService(paths, permissions, audit);
  const workspace = new WorkspaceService(db, roots);
  const tasks = new TaskService(db, paths, permissions, audit, events, env.appDataDir);
  const shelves = new ShelfService(db, paths, permissions, events);
  const tags = new TagService(db, paths, permissions);
  const shares = new ShareService(db, paths, permissions, audit);
  const groups = new GroupService(db);
  const workers = new WorkerManager(tasks, auth);

  await app.register(cookie, { secret: env.sessionSecret });
  await app.register(multipart);
  await app.register(websocket);

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      void reply.status(400).send({ error: "Invalid input", code: "INVALID_INPUT", issues: error.issues });
      return;
    }
    const safe = publicError(error);
    void reply.status(safe.statusCode).send(safe.body);
  });

  app.addHook("preHandler", async (request) => {
    if (!request.url.startsWith("/api/")) return;
    if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
    if (request.headers["x-kago-csrf"] !== "1") {
      throw new AppError(403, "Missing CSRF header", "CSRF_REQUIRED");
    }
  });

  await auth.ensureAdmin();
  registerApi(app, { auth, audit, roots, paths, permissions, fsService, workspace, tasks, shelves, tags, shares, groups, db });

  app.get("/ws", { websocket: true }, (socket) => {
    events.add(socket);
    socket.send(JSON.stringify({ type: "connected" }));
  });

  const webDist = path.resolve(import.meta.dirname, "../../web/dist");
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
    workers.stop();
    db.close();
  });

  workers.start();
  return app;
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
  db: ReturnType<typeof openDb>;
};

function registerApi(app: FastifyInstance, services: Services) {
  const requireActor = (request: FastifyRequest) => services.auth.requireActor(request);
  const requireAdmin = (request: FastifyRequest) => {
    const actor = services.auth.requireActor(request);
    if (actor.role !== "ADMIN") throw new AppError(403, "Admin required", "ADMIN_REQUIRED");
    return actor;
  };

  app.post("/api/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    try {
      const actor = await services.auth.login(reply, input.email, input.password);
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
    requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ displayName: z.string().optional(), role: z.string().optional(), disabled: z.boolean().optional() }).parse(request.body);
    return services.auth.patchUser(params.id, body);
  });

  app.get("/api/groups", async (request) => {
    requireAdmin(request);
    return services.groups.list();
  });
  app.post("/api/groups", async (request) => {
    requireAdmin(request);
    return services.groups.create(createGroupSchema.parse(request.body).name);
  });
  app.post("/api/groups/:id/members", async (request) => {
    requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ userId: z.string() }).parse(request.body);
    services.groups.addMember(params.id, body.userId);
    return { ok: true };
  });
  app.delete("/api/groups/:id/members/:userId", async (request) => {
    requireAdmin(request);
    const params = z.object({ id: z.string(), userId: z.string() }).parse(request.params);
    services.groups.removeMember(params.id, params.userId);
    return { ok: true };
  });

  app.get("/api/roots", async (request) => {
    requireActor(request);
    return services.roots.list().map(({ base_path: _basePath, ...root }) => root);
  });
  app.post("/api/roots", async (request) => {
    const actor = requireAdmin(request);
    const root = services.roots.create(rootInputSchema.parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "root_create", rootId: root.id, result: "success" });
    return { ...root, base_path: undefined };
  });
  app.patch("/api/roots/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const root = services.roots.patch(params.id, rootInputSchema.partial().parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "root_update", rootId: root.id, result: "success" });
    return { ...root, base_path: undefined };
  });
  app.delete("/api/roots/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    services.roots.delete(params.id);
    services.audit.write({ actorType: "user", actorId: actor.id, action: "root_delete", target: params, result: "success" });
    return { ok: true };
  });

  app.get("/api/workspace", async (request) => {
    const actor = requireActor(request);
    return services.workspace.get(actor.id);
  });
  app.put("/api/workspace", async (request) => {
    const actor = requireActor(request);
    const saved = services.workspace.save(actor.id, workspaceSchema.parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "workspace_update", result: "success" });
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
    reply.header("Content-Type", file.contentType);
    reply.header("Content-Length", String(file.stat.size));
    reply.header("Content-Disposition", `attachment; filename="${path.basename(file.safe.absolutePath).replaceAll('"', "")}"`);
    return fs.createReadStream(file.safe.absolutePath);
  });
  app.get("/api/fs/preview", async (request, reply) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.download(actor, query.rootSlug, query.path);
    reply.header("Content-Type", file.contentType);
    reply.header("Content-Length", String(file.stat.size));
    return fs.createReadStream(file.safe.absolutePath);
  });
  app.get("/api/fs/thumbnail", async () => ({ thumbnail: null }));
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
  app.post("/api/fs/upload", async (request) => {
    const actor = requireActor(request);
    const parts = request.parts();
    let rootSlug = "";
    let uploadPath = "/";
    const uploaded = [];
    for await (const part of parts) {
      if (part.type === "field" && part.fieldname === "rootSlug") rootSlug = String(part.value);
      if (part.type === "field" && part.fieldname === "path") uploadPath = String(part.value);
      if (part.type === "file") uploaded.push(await services.fsService.upload(actor, rootSlug, uploadPath, part.filename, part.file));
    }
    return { items: uploaded };
  });

  app.get("/api/tasks", async (request) => services.tasks.list(requireActor(request)));
  app.post("/api/tasks", async (request) => services.tasks.create(requireActor(request), taskInputSchema.parse(request.body)));
  app.get("/api/tasks/:id", async (request) => services.tasks.get(z.object({ id: z.string() }).parse(request.params).id));
  app.post("/api/tasks/:id/cancel", async (request) => services.tasks.cancel(z.object({ id: z.string() }).parse(request.params).id));
  app.post("/api/tasks/:id/pause", async () => ({ ok: false, reason: "Pause is reserved for a later worker version" }));
  app.post("/api/tasks/:id/resume", async () => ({ ok: false, reason: "Task resume is not part of MVP" }));

  app.get("/api/trash", async (request) => services.tasks.listTrash(requireActor(request)));
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
    requireAdmin(request);
    const query = z.object({ rootId: z.string().optional() }).parse(request.query);
    return services.permissions.list(query.rootId);
  });
  app.post("/api/permissions", async (request) => {
    requireAdmin(request);
    const item = services.permissions.create(permissionInputSchema.parse(request.body));
    return item;
  });
  app.delete("/api/permissions/:id", async (request) => {
    requireAdmin(request);
    services.permissions.delete(z.object({ id: z.string() }).parse(request.params).id);
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
    requireActor(request);
    services.shares.delete(z.object({ id: z.string() }).parse(request.params).id);
    return { ok: true };
  });

  app.get("/api/audit", async (request) => {
    requireAdmin(request);
    return services.audit.list();
  });

  app.get("/s/:token", async (request) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    return services.shares.publicInfo(params.token);
  });

  app.get("/s/:token/download", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const safe = await services.shares.publicDownload(params.token);
    reply.header("Content-Disposition", `attachment; filename="${path.basename(safe.absolutePath).replaceAll('"', "")}"`);
    return fs.createReadStream(safe.absolutePath);
  });

  app.post("/s/:token/upload", async (request) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const target = await services.shares.publicUploadTarget(params.token);
    const parts = request.parts();
    const uploaded = [];
    for await (const part of parts) {
      if (part.type === "file") {
        uploaded.push(await services.fsService.publicUpload(target.safe.root.slug, target.safe.logicalPath, part.filename, part.file));
      }
    }
    return { items: uploaded };
  });
}
