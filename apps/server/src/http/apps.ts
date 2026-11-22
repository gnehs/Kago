import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { lookup } from "mime-types";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { sendFile } from "../lib/send-file.js";
import { ICON_TYPES } from "../lib/icon-image.js";
import { appUrl, externalAppOrderSchema, externalAppSchema } from "../services/external-app.service.js";
import { framingHost, PLUGIN_PREFIX, pluginPolicy } from "../services/plugin.service.js";
import { FRAME_POLICY, framePage, sandboxContent } from "./respond.js";
import { idParams } from "./schemas.js";
import type { Services } from "./services.js";
import { guards } from "./guards.js";

export function register(app: FastifyInstance, s: Services) {
  const { requireActor } = guards(s);

  // Shortcuts on the desktop to other services: one's own, and the ones an administrator shares with everyone.
  app.get("/api/external-apps", async (request) => s.apps.list(requireActor(request)));
  app.post("/api/external-apps", async (request) => s.apps.create(requireActor(request), externalAppSchema.parse(request.body)));
  app.put("/api/external-apps/order", async (request) => s.apps.arrange(requireActor(request), externalAppOrderSchema.parse(request.body).ids));
  app.put("/api/external-apps/:id", async (request) => {
    const params = idParams.parse(request.params);
    return s.apps.update(requireActor(request), params.id, externalAppSchema.parse(request.body));
  });
  app.delete("/api/external-apps/:id", async (request) => {
    await s.apps.remove(requireActor(request), idParams.parse(request.params).id);
    return { ok: true };
  });
  app.get("/api/external-apps/:id/icon", async (request, reply) => {
    const icon = s.apps.iconFile(requireActor(request), idParams.parse(request.params).id);
    const stat = await fs.promises.stat(icon.file).catch(() => null);
    if (!stat) throw new AppError(404, "Icon not found", "ICON_NOT_FOUND");
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    // An icon may be an SVG. It was rewritten when it was taken in, and is still sent as something that cannot run.
    sandboxContent(reply);
    return sendFile(request, reply, icon.file, stat, icon.contentType);
  });
  // Opening a shortcut that has a sign-in goes through here: the browser is sent on to the address with the sign-in in it.
  app.get("/api/external-apps/:id/open", async (request, reply) => {
    const target = s.apps.openTarget(requireActor(request), idParams.parse(request.params).id);
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    return reply.redirect(target);
  });
  // Whether a service lets itself be shown inside Kago, asked of the service itself before a blank window says so.
  // The page the question is for is named by the browser, not by the request's own say-so.
  app.post("/api/external-apps/probe", async (request) => {
    const actor = requireActor(request);
    const body = z.object({ url: z.string().trim().min(1).max(2048) }).parse(request.body);
    return { verdict: await s.frameProbe.ask(actor.id, appUrl(body.url), String(request.headers.origin ?? "")) };
  });
  // A shortcut that is shown inside Kago is shown through this page: a frame around the service and nothing else.
  app.get("/api/external-apps/:id/frame", async (request, reply) => {
    const target = s.apps.frameTarget(requireActor(request), idParams.parse(request.params).id);
    reply.header("Content-Type", "text/html; charset=utf-8");
    reply.header("Cache-Control", "no-store");
    reply.header("Content-Security-Policy", FRAME_POLICY);
    return framePage(target);
  });
  // The previewers plugins add, for files none of the interface's own viewers open.
  app.get("/api/plugins", async (request) => {
    requireActor(request);
    return { previewers: s.plugins.previewers() };
  });
  // A plugin's own files. Its page runs sandboxed, in a frame of the interface's, under a policy that lets it load
  // these files and nothing else; it reaches the file it shows only through messages to the interface.
  app.get(`${PLUGIN_PREFIX}:token/*`, async (request, reply) => {
    const params = z.object({ token: z.string().max(64), "*": z.string().max(400) }).parse(request.params);
    const found = await s.plugins.file(params.token, params["*"]);
    if (!found) throw new AppError(404, "Not found", "NOT_FOUND");
    const origin = z.object({ _o: z.string().max(300).optional() }).parse(request.query)._o;
    const framedBy = framingHost(origin, request.headers["sec-fetch-site"], request.headers["sec-fetch-dest"]);
    reply.header("Content-Security-Policy", pluginPolicy(params.token, [request.headers.host, framedBy]));
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    // Names looked up ahead of time are a way out that the policy does not cover.
    reply.header("X-DNS-Prefetch-Control", "off");
    // The page is a sandboxed document, so the module scripts and stylesheets it loads are asked for from "null".
    reply.header("Access-Control-Allow-Origin", "null");
    // The token changes whenever the plugin or the server does, but its files are read as they are on disk, and a
    // plugin rebuilt meanwhile names new ones from its page. So the page is asked for each time; what it names is
    // named by its content, as a build names it, and never changes.
    reply.header("Cache-Control", found.file.endsWith(".html") ? "private, no-cache" : "private, max-age=31536000, immutable");
    return sendFile(request, reply, found.file, found, lookup(found.file) || "application/octet-stream");
  });
  // The icon libraries, asked by this server so that no browser has to: which icons answer to a name, and what one looks like.
  app.get("/api/app-icons", async (request) => {
    requireActor(request);
    return s.iconLibrary.search(z.object({ q: z.string().max(80) }).parse(request.query).q);
  });
  app.get("/api/app-icons/:source/:name", async (request, reply) => {
    requireActor(request);
    const params = z.object({ source: z.string().max(40), name: z.string().max(80) }).parse(request.params);
    const icon = await s.iconLibrary.icon(params.source, params.name);
    reply.header("Cache-Control", "private, max-age=86400");
    sandboxContent(reply);
    return sendFile(request, reply, icon.file, await fs.promises.stat(icon.file), ICON_TYPES[icon.type]);
  });
}
