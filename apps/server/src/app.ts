import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { lookup } from "mime-types";
import { z } from "zod";
import type { Env } from "./config/env.js";
import { openDb } from "./db/db.js";
import { AppError, publicError, systemAccount } from "./lib/errors.js";
import { isPictureFormat } from "./lib/subtitles.js";
import { nfc } from "./lib/filename.js";
import { logger } from "./lib/logger.js";
import { randomToken } from "./lib/crypto.js";
import { SecretBox } from "./lib/secret-box.js";
import { sendFile, sendSource } from "./lib/send-file.js";
import { FrameProbe } from "./lib/frame-probe.js";
import { ICON_TYPES } from "./lib/icon-image.js";
import { ensureSshKey } from "./lib/ssh-key.js";
import { zipStream } from "./lib/zip-stream.js";
import { isBrowserViewable } from "./lib/viewable.js";
import { AuditService } from "./services/audit.service.js";
import { AuthService, MAX_PASSWORD, changePasswordSchema, createUserSchema, loginSchema, patchUserSchema, resetPasswordSchema, setupAdminSchema } from "./services/auth.service.js";
import { FsService, finderTagsSchema, fsQuerySchema, maxUploadFiles, mkdirSchema, renameSchema, sqliteRowsSchema, writeTextSchema, zipQuerySchema } from "./services/fs.service.js";
import { ImageService } from "./services/image.service.js";
import { appUrl, externalAppSchema, ExternalAppService } from "./services/external-app.service.js";
import { createGroupSchema, GroupService } from "./services/group.service.js";
import { IconLibraryService } from "./services/icon-library.service.js";
import { MediaService, mediaAudioSchema, mediaSessionSchema, mediaStreamSchema } from "./services/media.service.js";
import { oidcConfigSchema, OidcService } from "./services/oidc.service.js";
import { PathService } from "./services/path.service.js";
import { permissionInputSchema, permissionSetSchema, PermissionService } from "./services/permission.service.js";
import { folderViewQuerySchema, folderViewSchema, PreferenceService, settingsSchema } from "./services/preference.service.js";
import { remoteRootPatchSchema, remoteRootSchema, rootPatchSchema, RootService } from "./services/root.service.js";
import { SHARE_VISIT_SECONDS, ShareService, shareSchema, type ShareVisitor } from "./services/share.service.js";
import { ShelfService } from "./services/shelf.service.js";
import { StorageService } from "./services/storage.service.js";
import { syncJobSchema, SyncService } from "./services/sync.service.js";
import { TagService, tagSchema } from "./services/tag.service.js";
import { archivePasswordSchema } from "./services/archive-password.service.js";
import { taskInputSchema, TaskService } from "./services/task.service.js";
import { workspaceSchema, WorkspaceService } from "./services/workspace.service.js";
import { WorkerManager } from "./workers/worker-manager.js";
import { normalizeRemoteConfig, providers, remoteConfigSchema } from "./storage/providers.js";
import { RcloneClient, rcloneSocketPath } from "./storage/rclone-client.js";
import { RemoteManager } from "./storage/remote-manager.js";
import { isRemote, RemoteStorage } from "./storage/remote-storage.js";
import { EventHub } from "./ws/events.js";

export async function buildApp(env: Env) {
  const proxies = env.trustProxy ?? false;
  // A number is how many proxies stand in front: that many hops of what they forward are believed, and no more.
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 * 25, trustProxy: typeof proxies === "number" ? (_address: string, hop: number) => hop < proxies : proxies });
  const db = openDb(env);
  const events = new EventHub();
  const audit = new AuditService(db);
  const secrets = new SecretBox(env.appDataDir);
  const roots = new RootService(db, env.dataDir, secrets);
  const rclone = new RcloneClient(rcloneSocketPath(env.appDataDir));
  const remote = new RemoteStorage(rclone, roots, env);
  const remotes = new RemoteManager(rclone, roots, env.appDataDir);
  const storage = new StorageService(remote);
  const paths = new PathService(roots, remote);
  const permissions = new PermissionService(db, audit);
  const auth = new AuthService(db, env);
  const images = new ImageService(env.appDataDir);
  const preferences = new PreferenceService(db, roots, paths, events);
  const fsService = new FsService(paths, permissions, audit, storage, env.appDataDir, preferences, images);
  const workspace = new WorkspaceService(db, roots, paths);
  const tasks = new TaskService(db, paths, permissions, audit, events, env.appDataDir, fsService, storage, preferences);
  const shelves = new ShelfService(db, paths, permissions, events, audit, storage);
  const tags = new TagService(db, paths, permissions, audit);
  const shares = new ShareService(db, paths, permissions, audit, events, storage);
  const sync = new SyncService(db, tasks, auth, audit);
  const groups = new GroupService(db);
  const oidc = new OidcService(db, secrets, auth, audit, events);
  const media = new MediaService(env.appDataDir);
  const iconLibrary = new IconLibraryService(env.appDataDir);
  const apps = new ExternalAppService(db, env.appDataDir, iconLibrary, events, audit);
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

  // Nothing of Kago's is meant to be shown inside another site's page, or taken for a type it was not sent as.
  app.addHook("onRequest", async (request, reply) => {
    reply.header("X-Frame-Options", "SAMEORIGIN");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    // The page itself; a response that carries someone's file replaces this with a stricter one of its own.
    reply.header("Content-Security-Policy", pagePolicy(request.headers.host));
  });

  await auth.ensureInitialAdminFromEnv();
  roots.syncFromDataDir();
  // Said once in the log as well, where whoever set the container up looks first.
  for (const access of roots.localAccess()) {
    const root = roots.getById(access.id);
    if (!access.readable || !(access.writable || root.readonly)) {
      const account = systemAccount();
      logger.warn(`Kago${account ? ` runs as uid ${account.uid}, gid ${account.gid} and` : ""} cannot ${access.readable ? "write to" : "read"} ${root.base_path}; check PUID / PGID or the folder's ownership`);
    }
  }
  await remotes.start();
  registerApi(app, { auth, audit, roots, paths, permissions, fsService, workspace, preferences, tasks, shelves, tags, shares, groups, oidc, media, images, apps, iconLibrary, frameProbe: new FrameProbe(), events, db, storage, remotes, sync, env });

  app.get("/ws", {
    websocket: true,
    preValidation: async (request) => {
      assertAllowedWebSocketOrigin(request);
      auth.requireActor(request);
    }
  }, (socket, request) => {
    auth.requireActor(request);
    events.add(socket, () => auth.actorForSession(request.cookies.kago_session));
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
    events.close();
    await workers.stop();
    sync.stop();
    clearInterval(pruning);
    clearInterval(pruningPictures);
    remotes.stop();
    media.stop();
    await images.stop();
    db.close();
  });

  workers.start();
  sync.start();
  const pruning = setInterval(() => void remote.pruneLocalCopies().catch(() => undefined), 60 * 60 * 1000);
  pruning.unref();
  void remote.pruneLocalCopies().catch(() => undefined);
  const prunePictures = () =>
    void Promise.all([fsService.pruneThumbnails(), images.prune(), iconLibrary.prune(), apps.prune()]).then(
      ([thumbnails, renditions, libraryIcons, appIcons]) => {
        if (thumbnails + renditions > 0) logger.info(`removed ${thumbnails} thumbnails and ${renditions} converted pictures unused for a month`);
        if (libraryIcons + appIcons > 0) logger.info(`removed ${libraryIcons + appIcons} app icons no longer in use`);
      },
      () => undefined
    );
  const pruningPictures = setInterval(() => {
    prunePictures();
    audit.prune();
  }, 24 * 60 * 60 * 1000);
  pruningPictures.unref();
  prunePictures();
  audit.prune();
  return app;
}

/**
 * What the interface may load and run. Its own scripts only, never ones written into the page or built from a
 * string, so markup that found its way into the page through some file's contents has nothing to run with.
 * WebAssembly and workers made from blobs are what the PDF, subtitle, video and 3D viewers are built on; styles
 * are set inline by every one of them. Pictures may come from anywhere, as a Markdown file may link to them.
 */
function pagePolicy(host: string | undefined): string {
  // Older Safari does not take `'self'` to cover the WebSocket of the same host.
  const sockets = host && /^[\w.\-:[\]]+$/.test(host) ? ` ws://${host} wss://${host}` : "";
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob: data:",
    "font-src 'self' data: blob:",
    `connect-src 'self' blob: data:${sockets}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'"
  ].join("; ");
}

/**
 * The page that holds another service inside Kago. The interface frames this page, and this page frames the
 * service, so the interface itself stays unable to frame anything but Kago: the one place a frame from elsewhere
 * can stand is here, around an address that was checked when it was saved. Whatever the service then goes to
 * inside its frame (its sign-in page, say) is its own affair.
 */
const FRAME_POLICY = "default-src 'none'; frame-src http: https:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

/**
 * What the framed service may do: run, keep its own sign-in, open tabs and save files. It is not given the tab
 * Kago is in: without `allow-top-navigation` it cannot take the person away from their desktop.
 */
const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation allow-orientation-lock allow-storage-access-by-user-activation";

function framePage(url: string): string {
  const address = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html,body{height:100%;margin:0;background:#fff}iframe{display:block;width:100%;height:100%;border:0}</style></head><body><iframe src="${address}" sandbox="${FRAME_SANDBOX}" allow="fullscreen; autoplay; clipboard-write; encrypted-media; picture-in-picture" referrerpolicy="no-referrer"></iframe></body></html>`;
}

/** Header values must be latin1, so non-ASCII names travel in the RFC 5987 `filename*` form. */
function contentDisposition(kind: "attachment" | "inline", rawFileName: string): string {
  const fileName = nfc(rawFileName);
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replaceAll('"', "");
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * Anything that is, or was made out of, someone's file is sent as inert content: an SVG holds scripts, and one opened
 * at its own address would run them as the application. The page still shows it in an `<img>`, where nothing runs.
 */
function sandboxContent(reply: FastifyReply): void {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; sandbox");
}

/** Raw user files must never run scripts with the application's origin when opened directly. */
function protectFilePreview(reply: FastifyReply, contentType: string, fileName: string): void {
  // Fetch-based code and office viewers can still read attachments; direct navigation downloads active documents.
  reply.header("Content-Disposition", contentDisposition(isBrowserViewable(contentType) ? "inline" : "attachment", fileName));
  sandboxContent(reply);
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
  preferences: PreferenceService;
  tasks: TaskService;
  shelves: ShelfService;
  tags: TagService;
  shares: ShareService;
  groups: GroupService;
  oidc: OidcService;
  media: MediaService;
  images: ImageService;
  apps: ExternalAppService;
  iconLibrary: IconLibraryService;
  frameProbe: FrameProbe;
  events: EventHub;
  db: ReturnType<typeof openDb>;
  storage: StorageService;
  remotes: RemoteManager;
  sync: SyncService;
  env: Env;
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

  // `oidc` is what the sign-in page needs to offer single sign-on: nothing of how it is set up.
  app.get("/api/auth/setup", async () => ({ needsSetup: services.auth.needsSetup(), oidc: services.oidc.publicInfo() }));
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
      services.audit.write({ actorType: "system", action: "login_failed", target: { email: input.email }, result: "failure", ip: request.ip, userAgent: request.headers["user-agent"] });
      throw error;
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const actor = services.auth.actorFromRequest(request);
    services.auth.logout(request, reply);
    if (actor) services.audit.write({ actorType: "user", actorId: actor.id, action: "logout", result: "success" });
    return { ok: true };
  });

  // Single sign-on. These two are pages the browser is sent to, not calls the interface makes: whatever goes wrong
  // ends in a redirect back to the sign-in page, which says what it was.
  const ssoFailure = (error: unknown) => (error instanceof AppError ? error.code : "OIDC_FAILED");
  app.get("/api/auth/oidc/start", async (request, reply) => {
    const query = z.object({ returnTo: z.string().optional() }).safeParse(request.query);
    reply.header("Cache-Control", "no-store");
    try {
      return reply.redirect(await services.oidc.begin(reply, { returnTo: query.data?.returnTo }));
    } catch (error) {
      if (!(error instanceof AppError)) logger.error("single sign-on could not be started", error);
      return reply.redirect(`/login?sso_error=${ssoFailure(error)}`);
    }
  });
  app.get("/api/auth/oidc/callback", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    // Kept out of the Referer of whatever the page loads next: the address carries the code.
    reply.header("Referrer-Policy", "no-referrer");
    const seen = { ip: request.ip, userAgent: request.headers["user-agent"] };
    try {
      const outcome = await services.oidc.finish(request, reply);
      if (outcome.kind === "link") {
        services.audit.write({ actorType: "user", actorId: outcome.actor.id, action: "sso_link", result: "success", ...seen });
        return reply.redirect("/_kago/settings?sso=linked");
      }
      if (outcome.merged) services.audit.write({ actorType: "user", actorId: outcome.actor.id, action: "sso_link", target: { method: "email" }, result: "success", ...seen });
      if (outcome.created) services.audit.write({ actorType: "system", action: "user_create", target: { userId: outcome.actor.id, email: outcome.actor.email, method: "sso" }, result: "success", ...seen });
      services.audit.write({ actorType: "user", actorId: outcome.actor.id, action: "login_success", target: { method: "sso" }, result: "success", ...seen });
      return reply.redirect(outcome.returnTo);
    } catch (error) {
      if (!(error instanceof AppError)) logger.error("single sign-on failed", error);
      const actor = services.auth.actorFromRequest(request);
      services.audit.write({ actorType: actor ? "user" : "system", actorId: actor?.id, action: actor ? "sso_link" : "login_failed", target: { method: "sso", code: ssoFailure(error) }, result: "failure", ...seen });
      // Someone signed in was linking an identity, and goes back to where they asked for it.
      return reply.redirect(`${actor ? "/_kago/settings" : "/login"}?sso_error=${ssoFailure(error)}`);
    }
  });
  // Linking is asked for with a request another site cannot make, so nobody is led into linking an identity that is not theirs.
  app.post("/api/auth/oidc/link", async (request, reply) => {
    const actor = requireActor(request);
    return { url: await services.oidc.begin(reply, { returnTo: "/_kago/settings", linkUserId: actor.id }) };
  });
  app.get("/api/auth/identities", async (request) => {
    const actor = requireActor(request);
    return { sso: services.oidc.publicInfo(), hasPassword: services.auth.hasPassword(actor.id), identities: services.oidc.identitiesOf(actor.id) };
  });
  app.delete("/api/auth/identities/:id", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    services.oidc.unlink(actor.id, params.id, { keepWayIn: true, request });
    services.audit.write({ actorType: "user", actorId: actor.id, action: "sso_unlink", target: { userId: actor.id }, result: "success" });
    return { ok: true };
  });

  app.get("/api/sso", async (request) => {
    requireAdmin(request);
    return services.oidc.adminView();
  });
  app.put("/api/sso", async (request) => {
    const actor = requireAdmin(request);
    const config = await services.oidc.save(oidcConfigSchema.parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "sso_update", target: { enabled: config.enabled, issuer: config.issuer, autoCreate: config.autoCreate, syncGroups: config.syncGroups }, result: "success" });
    return config;
  });
  app.post("/api/sso/test", async (request) => {
    requireAdmin(request);
    return services.oidc.test(oidcConfigSchema.parse(request.body));
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
    const identities = services.oidc.identitiesByUser();
    return services.auth.listUsers().map((user) => ({ ...user, identities: identities.get(user.id) ?? [] }));
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
  app.delete("/api/users/:id/identities/:identityId", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string(), identityId: z.string() }).parse(request.params);
    services.oidc.unlink(params.id, params.identityId, { request });
    services.audit.write({ actorType: "user", actorId: actor.id, action: "sso_unlink", target: { userId: params.id }, result: "success" });
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
        services.permissions.can(actor, "view", root, "/").allowed ||
        services.permissions.canReachDescendant(actor, root, "/")
      )
      .map((root) => services.roots.publicRoot(root));
  });
  app.patch("/api/roots/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const root = services.roots.patch(params.id, rootPatchSchema.parse(request.body));
    services.audit.write({ actorType: "user", actorId: actor.id, action: "root_update", rootId: root.id, result: "success" });
    services.events.publish({ type: "roots.updated" });
    return services.roots.publicRoot(root);
  });

  // How locations are kept: the kinds of remote there are, the ones set up, whether rclone is there to reach them, and what the disk allows in the local ones.
  app.get("/api/storage", async (request) => {
    requireAdmin(request);
    return {
      available: await services.remotes.available(),
      providers,
      roots: services.roots.listRemote().map((root) => services.roots.publicRoot(root, true)),
      // What the disk itself allows the server's account in each local location, whatever Kago's own rules say.
      account: systemAccount(),
      local: services.roots.localAccess()
    };
  });
  app.post("/api/storage/test", async (request) => {
    requireAdmin(request);
    const body = z.object({ rootId: z.string().optional(), config: remoteConfigSchema }).parse(request.body);
    // An existing location is tried with the secrets it already has, unless new ones were typed.
    const previous = body.rootId ? services.roots.remoteConfig(services.roots.getById(body.rootId)) : undefined;
    return services.remotes.test(normalizeRemoteConfig(body.config, previous));
  });
  app.get("/api/storage/ssh-key", async (request) => {
    requireAdmin(request);
    return { publicKey: (await ensureSshKey(services.env.appDataDir)).publicKey };
  });
  app.post("/api/roots/remote", async (request) => {
    const actor = requireAdmin(request);
    const root = services.roots.createRemote(remoteRootSchema.parse(request.body));
    await services.remotes.configure(root);
    services.audit.write({ actorType: "user", actorId: actor.id, action: "root_create", rootId: root.id, target: { provider: root.provider }, result: "success" });
    services.events.publish({ type: "roots.updated" });
    return services.roots.publicRoot(root, true);
  });
  app.put("/api/roots/:id/remote", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const root = services.roots.updateRemote(params.id, remoteRootPatchSchema.parse(request.body));
    await services.remotes.configure(root);
    services.audit.write({ actorType: "user", actorId: actor.id, action: "root_update", rootId: root.id, target: { provider: root.provider }, result: "success" });
    services.events.publish({ type: "roots.updated" });
    return services.roots.publicRoot(root, true);
  });
  app.delete("/api/roots/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const root = services.roots.deleteRemote(params.id);
    await services.remotes.forget(root);
    services.audit.write({ actorType: "user", actorId: actor.id, action: "root_delete", target: { rootId: root.id, slug: root.slug, provider: root.provider }, result: "success" });
    services.events.publish({ type: "roots.updated" });
    return { ok: true };
  });

  // ffmpeg reads a remote file here, from this machine only, at an address signed for that one file.
  app.get("/api/internal/blob/:root/:signature/*", async (request, reply) => {
    const params = z.object({ root: z.string(), signature: z.string(), "*": z.string() }).parse(request.params);
    const logicalPath = `/${params["*"]}`;
    // The connection itself is asked where it comes from: what a proxy says about the caller is not what is meant here.
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.raw.socket.remoteAddress ?? "") || !services.storage.remote.verifyInputUrl(params.root, logicalPath, params.signature)) {
      throw new AppError(404, "Not found", "NOT_FOUND");
    }
    const safe = await services.paths.resolveRootById(params.root, logicalPath);
    if (!isRemote(safe.root)) throw new AppError(404, "Not found", "NOT_FOUND");
    const stat = await services.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(404, "Not found", "NOT_FOUND");
    return sendSource(request, reply, services.storage.source(safe, stat), "application/octet-stream");
  });

  app.get("/api/sync-jobs", async (request) => services.sync.list(requireActor(request)));
  app.post("/api/sync-jobs", async (request) => services.sync.create(requireActor(request), syncJobSchema.parse(request.body)));
  app.put("/api/sync-jobs/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return services.sync.update(requireActor(request), params.id, syncJobSchema.parse(request.body));
  });
  app.delete("/api/sync-jobs/:id", async (request) => {
    services.sync.delete(requireActor(request), z.object({ id: z.string() }).parse(request.params).id);
    return { ok: true };
  });
  app.get("/api/sync-jobs/:id/trial", async (request) => services.sync.trial(requireActor(request), z.object({ id: z.string() }).parse(request.params).id));
  app.get("/api/sync-jobs/:id/runs", async (request) => services.sync.runs(requireActor(request), z.object({ id: z.string() }).parse(request.params).id));
  app.post("/api/sync-jobs/:id/run", async (request) => services.sync.run(requireActor(request), z.object({ id: z.string() }).parse(request.params).id));

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

  app.get("/api/settings", async (request) => services.preferences.get(requireActor(request).id));
  app.patch("/api/settings", async (request) => services.preferences.patchSettings(requireActor(request).id, settingsSchema.parse(request.body)));
  app.get("/api/archive-passwords", async (request) => services.tasks.archivePasswords.list(requireActor(request).id));
  app.post("/api/archive-passwords", async (request) => services.tasks.archivePasswords.add(requireActor(request).id, archivePasswordSchema.parse(request.body)));
  app.delete("/api/archive-passwords/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return services.tasks.archivePasswords.remove(requireActor(request).id, params.id);
  });
  app.put("/api/folder-views", async (request) => services.preferences.setFolderView(requireActor(request).id, folderViewSchema.parse(request.body)));
  app.delete("/api/folder-views", async (request) => services.preferences.resetFolderView(requireActor(request).id, folderViewQuerySchema.parse(request.query)));

  // One desktop background per person, kept as a picture of its own so the file it came from can move or go.
  app.get("/api/wallpaper", async (request, reply) => {
    const file = services.fsService.wallpaperPath(requireActor(request).id);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) throw new AppError(404, "No desktop background is set", "NO_WALLPAPER");
    // The address names the time it was set, so a new one is never answered from the browser's cache.
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    sandboxContent(reply);
    return sendFile(request, reply, file, stat, "image/avif");
  });
  app.post("/api/wallpaper", async (request) => {
    const actor = requireActor(request);
    const body = fsQuerySchema.parse(request.body);
    await services.fsService.setWallpaper(actor, body.rootSlug, body.path);
    return services.preferences.setWallpaper(actor.id, true);
  });
  app.delete("/api/wallpaper", async (request) => {
    const actor = requireActor(request);
    await services.fsService.clearWallpaper(actor);
    return services.preferences.setWallpaper(actor.id, false);
  });

  // Shortcuts on the desktop to other services: one's own, and the ones an administrator shares with everyone.
  app.get("/api/external-apps", async (request) => services.apps.list(requireActor(request)));
  app.post("/api/external-apps", async (request) => services.apps.create(requireActor(request), externalAppSchema.parse(request.body)));
  app.put("/api/external-apps/:id", async (request) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    return services.apps.update(requireActor(request), params.id, externalAppSchema.parse(request.body));
  });
  app.delete("/api/external-apps/:id", async (request) => {
    await services.apps.remove(requireActor(request), z.object({ id: z.string() }).parse(request.params).id);
    return { ok: true };
  });
  app.get("/api/external-apps/:id/icon", async (request, reply) => {
    const icon = services.apps.iconFile(requireActor(request), z.object({ id: z.string() }).parse(request.params).id);
    const stat = await fs.promises.stat(icon.file).catch(() => null);
    if (!stat) throw new AppError(404, "Icon not found", "ICON_NOT_FOUND");
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    // An icon may be an SVG. It was rewritten when it was taken in, and is still sent as something that cannot run.
    sandboxContent(reply);
    return sendFile(request, reply, icon.file, stat, icon.contentType);
  });
  // Whether a service lets itself be shown inside Kago, asked of the service itself before a blank window says so.
  // The page the question is for is named by the browser, not by the request's own say-so.
  app.post("/api/external-apps/probe", async (request) => {
    const actor = requireActor(request);
    const body = z.object({ url: z.string().trim().min(1).max(2048) }).parse(request.body);
    return { verdict: await services.frameProbe.ask(actor.id, appUrl(body.url), String(request.headers.origin ?? "")) };
  });
  // A shortcut that is shown inside Kago is shown through this page: a frame around the service and nothing else.
  app.get("/api/external-apps/:id/frame", async (request, reply) => {
    const target = services.apps.frameTarget(requireActor(request), z.object({ id: z.string() }).parse(request.params).id);
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", FRAME_POLICY);
    return framePage(target);
  });
  // The icon libraries, asked by this server so that no browser has to: which icons answer to a name, and what one looks like.
  app.get("/api/app-icons", async (request) => {
    requireActor(request);
    return services.iconLibrary.search(z.object({ q: z.string().max(80) }).parse(request.query).q);
  });
  app.get("/api/app-icons/:source/:name", async (request, reply) => {
    requireActor(request);
    const params = z.object({ source: z.string().max(40), name: z.string().max(80) }).parse(request.params);
    const icon = await services.iconLibrary.icon(params.source, params.name);
    reply.header("Cache-Control", "private, max-age=86400");
    sandboxContent(reply);
    return sendFile(request, reply, icon.file, await fs.promises.stat(icon.file), ICON_TYPES[icon.type]);
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
    reply.header("Content-Disposition", contentDisposition("attachment", file.name));
    return sendSource(request, reply, file.source, file.contentType);
  });
  // Folders and selections as one archive, at an address that can be handed to the browser before anything is prepared.
  app.get("/api/fs/download-zip", async (request, reply) => {
    const actor = requireActor(request);
    const query = zipQuerySchema.parse(request.query);
    const archive = await services.fsService.downloadZip(actor, query.rootSlug, query.path);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Disposition", contentDisposition("attachment", archive.fileName));
    reply.header("X-Accel-Buffering", "no");
    return reply.send(Readable.from(zipStream(archive.entries)));
  });
  app.get("/api/fs/preview", async (request, reply) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.preview(actor, query.rootSlug, query.path);
    protectFilePreview(reply, file.contentType, file.name);
    return sendSource(request, reply, file.source, file.contentType);
  });
  app.put("/api/fs/content", async (request) => services.fsService.writeText(requireActor(request), writeTextSchema.parse(request.body)));
  app.get("/api/fs/sqlite", async (request) => {
    const query = fsQuerySchema.parse(request.query);
    return services.fsService.sqliteOverview(requireActor(request), query.rootSlug, query.path);
  });
  app.get("/api/fs/sqlite/rows", async (request) => services.fsService.sqliteRows(requireActor(request), sqliteRowsSchema.parse(request.query)));
  app.get("/api/fs/image", async (request, reply) => {
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.localFile(requireActor(request), query.rootSlug, query.path);
    const rendition = await services.images.rendition(file.localPath, file.stat);
    reply.header("Cache-Control", "private, max-age=86400");
    sandboxContent(reply);
    return sendFile(request, reply, rendition, await fs.promises.stat(rendition), "image/jpeg");
  });
  app.get("/api/fs/exif", async (request) => {
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.localFile(requireActor(request), query.rootSlug, query.path);
    return services.images.metadata(file.localPath);
  });
  app.get("/api/fs/thumbnail", async (request, reply) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const thumbnail = await services.fsService.thumbnail(actor, query.rootSlug, query.path);
    reply.header("Content-Type", thumbnail.contentType);
    reply.header("Cache-Control", "private, max-age=86400");
    // A picture ffmpeg could not draw is sent as the file itself, and that file may be an SVG.
    sandboxContent(reply);
    if ("data" in thumbnail) return thumbnail.data;
    reply.header("Content-Length", String(thumbnail.size));
    return fs.createReadStream(thumbnail.path);
  });
  app.get("/api/media/info", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.media(actor, query.rootSlug, query.path);
    return services.media.info(file.input, file.stat);
  });
  app.get("/api/media/subtitles", async (request) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.media(actor, query.rootSlug, query.path);
    const sidecars = await services.fsService.subtitles(actor, query.rootSlug, query.path);
    // Something ffprobe cannot read simply has no streams of its own to offer.
    const info = await services.media.info(file.input, file.stat).catch(() => null);
    const own = new URLSearchParams({ rootSlug: query.rootSlug, path: query.path }).toString();
    const embedded = info?.subtitles ?? [];
    // A DVD index holds a stream for each language; they are listed apart, and say their own language where the name does not.
    const pictureFiles = info?.transcode
      ? (
          await Promise.all(
            sidecars.map(async ({ path: sidecarPath, name, absolutePath, stat, ...track }) => {
              if (!isPictureFormat(track.format) || !absolutePath || !stat) return [];
              const streams = await services.media.pictureStreams({ absolutePath, stat, format: track.format });
              return streams.map((stream) => ({
                ...track,
                language: track.language || stream.language,
                id: streams.length > 1 ? `file:${sidecarPath}#${stream.index}` : `file:${sidecarPath}`,
                embedded: false,
                url: "",
                file: sidecarPath,
                stream: stream.index
              }));
            })
          )
        ).flat()
      : [];
    return {
      tracks: [
        ...sidecars
          .filter((sidecar) => !isPictureFormat(sidecar.format))
          .map(({ path: sidecarPath, name, absolutePath, stat, ...track }) => ({
            ...track,
            id: `file:${sidecarPath}`,
            embedded: false,
            url: `/api/fs/preview?${new URLSearchParams({ rootSlug: query.rootSlug, path: sidecarPath }).toString()}`
          })),
        ...embedded
          .filter((stream) => stream.text)
          .map(({ index, codec, text, picture, ...track }) => ({
            ...track,
            format: codec === "ass" || codec === "ssa" ? "ass" : "srt",
            id: `stream:${index}`,
            embedded: true,
            url: `/api/media/subtitle?${own}&index=${index}`
          })),
        // Picture subtitles (Blu-ray, DVD) come after the text ones: showing one means transcoding, as it is drawn into the frames.
        ...pictureFiles,
        ...embedded
          .filter((stream) => stream.picture && info?.transcode)
          .map(({ index, codec, text, picture, ...track }) => ({
            ...track,
            format: PICTURE_FORMATS[codec] ?? "picture",
            id: `stream:${index}`,
            embedded: true,
            url: "",
            stream: index
          }))
      ],
      fonts: (info?.fonts ?? []).map((font) => `/api/media/attachment?${own}&index=${font.index}`),
      /** Subtitles in a form that can be neither handed to the browser nor drawn into the picture. */
      unsupported: embedded.filter((stream) => !stream.text && !(stream.picture && info?.transcode)).length
    };
  });
  app.get("/api/media/subtitle", async (request, reply) => {
    const actor = requireActor(request);
    const query = mediaStreamSchema.parse(request.query);
    const file = await services.fsService.media(actor, query.rootSlug, query.path);
    const subtitle = await services.media.subtitle(file.input, file.stat, query.index);
    reply.header("Cache-Control", "private, max-age=3600");
    sandboxContent(reply);
    return sendFile(request, reply, subtitle.file, await fs.promises.stat(subtitle.file), "text/plain; charset=utf-8");
  });
  app.get("/api/media/attachment", async (request, reply) => {
    const actor = requireActor(request);
    const query = mediaStreamSchema.parse(request.query);
    const file = await services.fsService.media(actor, query.rootSlug, query.path);
    const font = await services.media.font(file.input, file.stat, query.index);
    reply.header("Cache-Control", "private, max-age=3600");
    sandboxContent(reply);
    return sendFile(request, reply, font, await fs.promises.stat(font), "application/octet-stream");
  });
  app.get("/api/media/cover", async (request, reply) => {
    const actor = requireActor(request);
    const query = fsQuerySchema.parse(request.query);
    const file = await services.fsService.media(actor, query.rootSlug, query.path);
    const cover = await services.media.cover(file.input, file.stat);
    reply.header("Cache-Control", "private, max-age=3600");
    sandboxContent(reply);
    return sendFile(request, reply, cover, await fs.promises.stat(cover), "image/jpeg");
  });
  app.get("/api/media/audio", async (request, reply) => {
    const actor = requireActor(request);
    const query = mediaAudioSchema.parse(request.query);
    const file = await services.fsService.media(actor, query.rootSlug, query.path);
    const audio = await services.media.audioStream(actor.id, file.input, file.stat, query.start);
    // A player that seeks or closes drops the connection, and the encoder with it.
    reply.raw.on("close", audio.stop);
    // One that left while the file was still being looked at will never be heard from again.
    if (request.raw.socket.destroyed || reply.raw.destroyed) audio.stop();
    reply.header("Content-Type", "audio/webm");
    sandboxContent(reply);
    reply.header("Cache-Control", "no-store");
    return reply.send(audio.stream);
  });
  app.post("/api/media/sessions", async (request) => {
    const actor = requireActor(request);
    const input = mediaSessionSchema.parse(request.body);
    const file = await services.fsService.media(actor, input.rootSlug, input.path);
    // A subtitle file is taken only from among the ones found for this video, never as a path of the caller's choosing.
    const sidecar = input.subtitlePath === null ? null : (await services.fsService.subtitles(actor, input.rootSlug, input.path)).find((item) => item.path === input.subtitlePath);
    const subtitleFile = sidecar && isPictureFormat(sidecar.format) && sidecar.absolutePath && sidecar.stat ? { absolutePath: sidecar.absolutePath, stat: sidecar.stat, format: sidecar.format } : null;
    if (input.subtitlePath !== null && !subtitleFile) throw new AppError(400, "Unsupported subtitle", "INVALID_INPUT");
    const session = await services.media.createSession(actor.id, file.input, file.stat, { ...input, subtitleFile });
    return { id: session.id, hdr: session.hdr, playlistUrl: `/api/media/sessions/${session.id}/index.m3u8` };
  });
  app.get("/api/media/sessions/:id/:file", async (request, reply) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string().min(1), file: z.string().regex(/^(index\.m3u8|init\.mp4|\d{1,9}\.(ts|m4s))$/) }).parse(request.params);
    reply.header("Cache-Control", "no-store");
    if (params.file === "index.m3u8") {
      reply.header("Content-Type", "application/vnd.apple.mpegurl");
      return services.media.playlist(actor.id, params.id);
    }
    const segment = params.file === "init.mp4" ? await services.media.initSegment(actor.id, params.id) : await services.media.segment(actor.id, params.id, Number.parseInt(params.file, 10));
    const stat = await fs.promises.stat(segment);
    reply.header("Content-Type", params.file.endsWith(".ts") ? "video/mp2t" : "video/mp4");
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
  app.delete("/api/tasks", async (request) => services.tasks.clearFinished(requireActor(request)));
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
    const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
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
      destination: z.object({ rootSlug: z.string(), path: z.string() }),
      options: taskInputSchema.shape.options
    }).parse(request.body);
    const items = services.shelves.itemsForTask(actor, params.id);
    return services.tasks.create(actor, {
      type: body.type,
      sources: items.map((item) => ({ rootSlug: item.root_slug, path: item.path })),
      destination: body.destination,
      options: body.options
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
    const body = z.object({ rootSlug: z.string(), path: z.string(), tagIds: z.array(z.string()).max(200) }).parse(request.body);
    return services.tags.setFileTags(actor, body.rootSlug, body.path, body.tagIds);
  });

  app.get("/api/permissions", async (request) => {
    requireAdmin(request);
    const query = z.object({
      rootId: z.string().optional(),
      rootSlug: z.string().optional(),
      path: z.string().optional()
    }).parse(request.query);
    const rootId = query.rootSlug ? services.roots.getBySlug(query.rootSlug).id : query.rootId;
    if (query.path && !rootId) throw new AppError(400, "rootId or rootSlug is required for path lookups", "ROOT_REQUIRED");
    if (query.path && rootId) return services.permissions.listForPath(rootId, services.paths.normalizeLogicalPath(query.path));
    return services.permissions.list(rootId);
  });
  app.post("/api/permissions", async (request) => {
    const actor = requireAdmin(request);
    const input = permissionInputSchema.parse(request.body);
    services.roots.getById(input.rootId);
    const pathPrefix = services.paths.normalizeLogicalPath(input.pathPrefix);
    const item = services.permissions.create({ ...input, pathPrefix });
    services.audit.write({ actorType: "user", actorId: actor.id, action: "permission_change", rootId: item.root_id, target: item, result: "success" });
    publishPermissionUpdated(actor, item.principal_type, item.principal_id);
    return item;
  });
  app.put("/api/permissions", async (request) => {
    const actor = requireAdmin(request);
    const input = permissionSetSchema.parse(request.body);
    services.roots.getById(input.rootId);
    const pathPrefix = services.paths.normalizeLogicalPath(input.pathPrefix);
    const item = services.permissions.set({ ...input, pathPrefix });
    services.audit.write({ actorType: "user", actorId: actor.id, action: "permission_change", rootId: input.rootId, path: pathPrefix, target: item ?? { principalType: input.principalType, principalId: input.principalId, deleted: true }, result: "success" });
    publishPermissionUpdated(actor, input.principalType, input.principalId);
    return { rule: item };
  });
  app.delete("/api/permissions/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const rule = services.permissions.get(params.id);
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
    return services.shares.publicInfo(params.token, shareAccessCookie(request, params.token), visitor);
  });

  app.post("/s/:token/auth", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const body = z.object({ password: z.string().min(1).max(MAX_PASSWORD) }).parse(request.body);
    const auth = await services.shares.authenticatePublicShare(params.token, body.password, request.ip, shareVisitor(request, params.token));
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
    const safe = await services.shares.publicDownload(params.token, shareVisitor(request, params.token), shareAccessCookie(request, params.token));
    const stat = await services.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    reply.header("Content-Disposition", contentDisposition("attachment", services.storage.name(safe)));
    return sendSource(request, reply, services.storage.source(safe, stat), lookup(safe.logicalPath) || "application/octet-stream");
  });

  app.get("/s/:token/preview", async (request, reply) => {
    const params = z.object({ token: z.string().min(1) }).parse(request.params);
    const safe = await services.shares.publicPreview(params.token, shareVisitor(request, params.token), shareAccessCookie(request, params.token));
    const stat = await services.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(400, "Path is not a file", "NOT_FILE");
    const contentType = lookup(safe.logicalPath) || "application/octet-stream";
    if (!isBrowserViewable(contentType)) throw new AppError(415, "This kind of file cannot be viewed in the browser", "PREVIEW_UNSUPPORTED");
    protectFilePreview(reply, contentType, services.storage.name(safe));
    return sendSource(request, reply, services.storage.source(safe, stat), contentType);
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

/** What the player calls each kind of picture subtitle. */
const PICTURE_FORMATS: Record<string, string> = { hdmv_pgs_subtitle: "pgs", dvd_subtitle: "vobsub", dvb_subtitle: "dvb" };

const uploadRequestSchema = z.object({
  rootSlug: z.string().min(1),
  path: z.string().min(1)
});
