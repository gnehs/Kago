import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { sendFile } from "../lib/send-file.js";
import { avatarSchema, fsQuerySchema } from "../services/fs.service.js";
import { favoriteSchema, folderViewQuerySchema, folderViewSchema, settingsSchema } from "../services/preference.service.js";
import { archivePasswordSchema } from "../services/archive-password.service.js";
import { workspaceSchema } from "../services/workspace.service.js";
import { sandboxContent } from "./respond.js";
import { idParams } from "./schemas.js";
import type { Services } from "./services.js";
import { guards } from "./guards.js";

export function register(app: FastifyInstance, s: Services) {
  const { requireActor, auditAs } = guards(s);

  app.get("/api/workspace", async (request) => {
    const actor = requireActor(request);
    return s.workspace.get(actor.id);
  });
  app.put("/api/workspace", async (request) => {
    const actor = requireActor(request);
    const saved = s.workspace.save(actor.id, workspaceSchema.parse(request.body));
    auditAs(actor, "workspace_update");
    s.events.publish({ type: "workspace.updated", userId: actor.id });
    return saved;
  });

  app.get("/api/settings", async (request) => s.preferences.get(requireActor(request).id));
  app.patch("/api/settings", async (request) => s.preferences.patchSettings(requireActor(request).id, settingsSchema.parse(request.body)));
  app.get("/api/archive-passwords", async (request) => s.tasks.archivePasswords.list(requireActor(request).id));
  app.post("/api/archive-passwords", async (request) => s.tasks.archivePasswords.add(requireActor(request).id, archivePasswordSchema.parse(request.body)));
  app.delete("/api/archive-passwords/:id", async (request) => {
    const params = idParams.parse(request.params);
    return s.tasks.archivePasswords.remove(requireActor(request).id, params.id);
  });
  app.put("/api/folder-views", async (request) => s.preferences.setFolderView(requireActor(request).id, folderViewSchema.parse(request.body)));
  app.delete("/api/folder-views", async (request) => s.preferences.resetFolderView(requireActor(request).id, folderViewQuerySchema.parse(request.query)));
  app.put("/api/favorites", async (request) => s.preferences.addFavorite(requireActor(request).id, favoriteSchema.parse(request.body)));
  app.delete("/api/favorites", async (request) => s.preferences.removeFavorite(requireActor(request).id, favoriteSchema.parse(request.query)));

  // One desktop background per person, kept as a picture of its own so the file it came from can move or go.
  app.get("/api/wallpaper", async (request, reply) => {
    const file = s.fsService.wallpaperPath(requireActor(request).id);
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
    await s.fsService.setWallpaper(actor, body.rootSlug, body.path);
    return s.preferences.setWallpaper(actor.id, true);
  });
  app.delete("/api/wallpaper", async (request) => {
    const actor = requireActor(request);
    await s.fsService.clearWallpaper(actor);
    return s.preferences.setWallpaper(actor.id, false);
  });

  // One profile picture per person, kept the same way. Unlike the background it is shown to others, so anyone signed in may ask for it.
  app.get("/api/users/:id/avatar", async (request, reply) => {
    requireActor(request);
    // Ids are generated here; anything else is not one, and is not looked for on disk.
    const params = z.object({ id: z.string().regex(/^\w+$/) }).parse(request.params);
    const file = s.fsService.avatarPath(params.id);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) throw new AppError(404, "No profile picture is set", "NO_AVATAR");
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    sandboxContent(reply);
    return sendFile(request, reply, file, stat, "image/avif");
  });
  app.post("/api/avatar", async (request) => {
    const actor = requireActor(request);
    const body = avatarSchema.parse(request.body);
    await s.fsService.setAvatar(actor, body.rootSlug, body.path, body.crop);
    const user = s.auth.setAvatar(actor.id, true);
    s.events.publish({ type: "account.updated", userId: actor.id });
    return { user };
  });
  app.delete("/api/avatar", async (request) => {
    const actor = requireActor(request);
    await s.fsService.clearAvatar(actor);
    const user = s.auth.setAvatar(actor.id, false);
    s.events.publish({ type: "account.updated", userId: actor.id });
    return { user };
  });
}
