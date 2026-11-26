import fs from "node:fs";
import path from "node:path";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import Fastify, { type FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "./config/env.js";
import { openDb } from "./db/db.js";
import { AppError, publicError, systemAccount } from "./lib/errors.js";
import { logger } from "./lib/logger.js";
import { SecretBox } from "./lib/secret-box.js";
import { FrameProbe } from "./lib/frame-probe.js";
import { AuditService } from "./services/audit.service.js";
import { AuthService } from "./services/auth.service.js";
import { CompatibilityService } from "./services/compatibility.service.js";
import { FsService, maxUploadFiles } from "./services/fs.service.js";
import { ImageService } from "./services/image.service.js";
import { ExternalAppService } from "./services/external-app.service.js";
import { GroupService } from "./services/group.service.js";
import { PluginService } from "./services/plugin.service.js";
import { IconLibraryService } from "./services/icon-library.service.js";
import { MediaService } from "./services/media.service.js";
import { OidcService } from "./services/oidc.service.js";
import { PathService } from "./services/path.service.js";
import { PermissionService } from "./services/permission.service.js";
import { PreferenceService } from "./services/preference.service.js";
import { RootService } from "./services/root.service.js";
import { ShareService } from "./services/share.service.js";
import { ShelfService } from "./services/shelf.service.js";
import { StorageService } from "./services/storage.service.js";
import { SyncService } from "./services/sync.service.js";
import { ConvertJobService } from "./services/convert-job.service.js";
import { TaskService } from "./services/task.service.js";
import { WorkspaceService } from "./services/workspace.service.js";
import { WorkerManager } from "./workers/worker-manager.js";
import { RcloneClient, rcloneSocketPath } from "./storage/rclone-client.js";
import { RemoteManager } from "./storage/remote-manager.js";
import { RemoteStorage } from "./storage/remote-storage.js";
import { EventHub } from "./ws/events.js";
import { register as registerAdmin } from "./http/admin.js";
import { register as registerApps } from "./http/apps.js";
import { register as registerAuth } from "./http/auth.js";
import { register as registerFs } from "./http/fs.js";
import { register as registerJobs } from "./http/jobs.js";
import { register as registerMedia } from "./http/media.js";
import { register as registerPrefs } from "./http/prefs.js";
import { register as registerRoots } from "./http/roots.js";
import { register as registerShares } from "./http/shares.js";
import { register as registerTasks } from "./http/tasks.js";
import type { Services } from "./http/services.js";

export async function buildApp(env: Env) {
  const proxies = env.trustProxy ?? false;
  // A number is how many proxies stand in front: that many hops of what they forward are believed, and no more.
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 * 25, trustProxy: typeof proxies === "number" ? (_address: string, hop: number) => hop < proxies : proxies });
  const db = openDb(env);
  const audit = new AuditService(db);
  const secrets = new SecretBox(env.appDataDir);
  const roots = new RootService(db, env.dataDir, secrets);
  const rclone = new RcloneClient(rcloneSocketPath(env.appDataDir));
  const remote = new RemoteStorage(rclone, roots, env);
  const remotes = new RemoteManager(rclone, roots, env.appDataDir);
  const storage = new StorageService(remote);
  const paths = new PathService(roots, remote);
  const permissions = new PermissionService(db, audit);
  // A change in a location is told only to those who may see what is in it.
  const events = new EventHub((actor, rootSlug) => {
    try {
      return permissions.can(actor, "view", roots.getBySlug(rootSlug)).allowed;
    } catch {
      return false;
    }
  });
  const auth = new AuthService(db, env);
  const images = new ImageService(env.appDataDir);
  const preferences = new PreferenceService(db, roots, paths, events);
  const fsService = new FsService(paths, permissions, audit, storage, env.appDataDir, preferences, images, events);
  const workspace = new WorkspaceService(db, roots, paths);
  const tasks = new TaskService(db, paths, permissions, audit, events, env.appDataDir, fsService, storage, preferences);
  const shelves = new ShelfService(db, paths, permissions, events, audit, storage);
  const shares = new ShareService(db, paths, permissions, audit, events, storage, fsService, env.sessionSecret, secrets);
  const sync = new SyncService(db, tasks, auth, audit, remotes);
  const convertJobs = new ConvertJobService(db, tasks, auth, audit);
  const groups = new GroupService(db);
  const oidc = new OidcService(db, secrets, auth, audit, events);
  const media = new MediaService(env.appDataDir);
  const compatibility = new CompatibilityService();
  const iconLibrary = new IconLibraryService(env.appDataDir);
  const apps = new ExternalAppService(db, env.appDataDir, iconLibrary, events, audit, secrets);
  const plugins = new PluginService([resolveBundledPlugins(), path.join(env.appDataDir, "plugins")]);
  const workers = new WorkerManager(tasks, env, events);
  // Conversions wait in a line of their own, so a long one holds up no copy or move.
  const mediaWorkers = new WorkerManager(tasks, env, events, "media");

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
    if (!(error instanceof AppError && error.recorded)) auditRequestFailure(request, safe.body.code, safe.statusCode);
    // A browser still sending the body reads no answer until the connection ends, and an idle one is kept for a minute.
    if (!request.raw.complete) void reply.header("connection", "close");
    void reply.status(safe.statusCode).send(safe.body);
  });

  function auditRequestFailure(request: FastifyRequest, code: string, statusCode: number): void {
    const route = auditRoute(request);
    if (!route.startsWith("/api/") && !route.startsWith("/s/")) return;
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

  // Asked of every changing method whatever the raw URL says: the router decodes `/%61pi/` into `/api/`.
  app.addHook("preHandler", async (request) => {
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

  // A plugin's frame has an origin of its own, which the browser names "null". It has no business with the API, and
  // its policy already lets it reach nothing; should that ever fail, what it asks for is still refused here.
  app.addHook("onRequest", async (request) => {
    if (request.headers.origin === "null" && (request.routeOptions.url ?? request.url).startsWith("/api/")) {
      throw new AppError(403, "Requests from a sandboxed frame are not accepted", "SANDBOXED_ORIGIN");
    }
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
  const services: Services = { auth, audit, roots, paths, permissions, fsService, workspace, preferences, tasks, trash: tasks.trash, shelves, shares, groups, oidc, media, compatibility, images, apps, iconLibrary, frameProbe: new FrameProbe(), events, db, storage, remotes, sync, convertJobs, plugins, env };
  for (const register of [registerAuth, registerAdmin, registerRoots, registerJobs, registerPrefs, registerApps, registerFs, registerMedia, registerTasks, registerShares]) register(app, services);

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
    await Promise.all([workers.stop(), mediaWorkers.stop()]);
    sync.stop();
    convertJobs.stop();
    clearInterval(pruning);
    clearInterval(pruningPictures);
    remotes.stop();
    media.stop();
    await images.stop();
    db.close();
  });

  workers.start();
  mediaWorkers.start();
  sync.start();
  convertJobs.start();
  const pruning = setInterval(() => void remote.pruneLocalCopies().catch(() => undefined), 60 * 60 * 1000);
  pruning.unref();
  void remote.pruneLocalCopies().catch(() => undefined);
  const prunePictures = () =>
    void Promise.all([fsService.pruneThumbnails(), images.prune(), iconLibrary.prune(), apps.prune(), media.pruneStoryboards()]).then(
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

/** Kago's own plugins: beside the server in an image, at the top of the repository in a checkout. */
function resolveBundledPlugins(): string {
  const candidates = [path.resolve(import.meta.dirname, "../plugins"), path.resolve(import.meta.dirname, "../../../plugins")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]!;
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
