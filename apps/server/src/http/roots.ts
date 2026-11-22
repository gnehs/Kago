import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError, systemAccount } from "../lib/errors.js";
import { sendSource } from "../lib/send-file.js";
import { ensureSshKey } from "../lib/ssh-key.js";
import { remoteRootPatchSchema, remoteRootSchema, rootPatchSchema } from "../services/root.service.js";
import { normalizeRemoteConfig, providers, remoteConfigSchema } from "../storage/providers.js";
import { isRemote } from "../storage/remote-storage.js";
import { idParams } from "./schemas.js";
import type { Services } from "./services.js";
import { guards } from "./guards.js";

export function register(app: FastifyInstance, s: Services) {
  const { requireActor, requireAdmin, auditAs } = guards(s);

  app.get("/api/roots", async (request) => {
    const actor = requireActor(request);
    return s.roots
      .listMounted()
      .filter((root) => s.permissions.can(actor, "view", root).allowed)
      .map((root) => s.roots.publicRoot(root));
  });
  app.patch("/api/roots/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = idParams.parse(request.params);
    const root = s.roots.patch(params.id, rootPatchSchema.parse(request.body));
    auditAs(actor, "root_update", undefined, root.id);
    s.events.publish({ type: "roots.updated" });
    return s.roots.publicRoot(root);
  });

  // How locations are kept: the kinds of remote there are, the ones set up, whether rclone is there to reach them, and what the disk allows in the local ones.
  app.get("/api/storage", async (request) => {
    requireAdmin(request);
    return {
      available: await s.remotes.available(),
      providers,
      roots: s.roots.listRemote().map((root) => s.roots.publicRoot(root, true)),
      // What the disk itself allows the server's account in each local location, whatever Kago's own rules say.
      account: systemAccount(),
      local: s.roots.localAccess()
    };
  });
  app.post("/api/storage/test", async (request) => {
    requireAdmin(request);
    const body = z.object({ rootId: z.string().optional(), config: remoteConfigSchema }).parse(request.body);
    // An existing location is tried with the secrets it already has, unless new ones were typed.
    const previous = body.rootId ? s.roots.remoteConfig(s.roots.getById(body.rootId)) : undefined;
    return s.remotes.test(normalizeRemoteConfig(body.config, previous));
  });
  app.get("/api/storage/ssh-key", async (request) => {
    requireAdmin(request);
    return { publicKey: (await ensureSshKey(s.env.appDataDir)).publicKey };
  });
  app.post("/api/roots/remote", async (request) => {
    const actor = requireAdmin(request);
    const root = s.roots.createRemote(remoteRootSchema.parse(request.body));
    await s.remotes.configure(root);
    auditAs(actor, "root_create", { provider: root.provider }, root.id);
    s.events.publish({ type: "roots.updated" });
    return s.roots.publicRoot(root, true);
  });
  app.put("/api/roots/:id/remote", async (request) => {
    const actor = requireAdmin(request);
    const params = idParams.parse(request.params);
    const root = s.roots.updateRemote(params.id, remoteRootPatchSchema.parse(request.body));
    await s.remotes.configure(root);
    auditAs(actor, "root_update", { provider: root.provider }, root.id);
    s.events.publish({ type: "roots.updated" });
    return s.roots.publicRoot(root, true);
  });
  app.delete("/api/roots/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = idParams.parse(request.params);
    const root = s.roots.deleteRemote(params.id);
    await s.remotes.forget(root);
    auditAs(actor, "root_delete", { rootId: root.id, slug: root.slug, provider: root.provider });
    s.events.publish({ type: "roots.updated" });
    return { ok: true };
  });

  // ffmpeg reads a remote file here, from this machine only, at an address signed for that one file.
  app.get("/api/internal/blob/:root/:signature/*", async (request, reply) => {
    const params = z.object({ root: z.string(), signature: z.string(), "*": z.string() }).parse(request.params);
    const logicalPath = `/${params["*"]}`;
    // The connection itself is asked where it comes from: what a proxy says about the caller is not what is meant here.
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.raw.socket.remoteAddress ?? "") || !s.storage.remote.verifyInputUrl(params.root, logicalPath, params.signature)) {
      throw new AppError(404, "Not found", "NOT_FOUND");
    }
    const safe = await s.paths.resolveRootById(params.root, logicalPath);
    if (!isRemote(safe.root)) throw new AppError(404, "Not found", "NOT_FOUND");
    const stat = await s.storage.stat(safe);
    if (!stat.isFile()) throw new AppError(404, "Not found", "NOT_FOUND");
    return sendSource(request, reply, s.storage.source(safe, stat), "application/octet-stream");
  });
}
