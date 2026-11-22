import fs from "node:fs";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { sendFile } from "../lib/send-file.js";
import { avatarSchema, fsQuerySchema } from "../services/fs.service.js";
import { favoriteSchema, folderViewQuerySchema, folderViewSchema, settingsSchema } from "../services/preference.service.js";
import { archivePasswordSchema } from "../services/archive-password.service.js";
import { workspaceSchema } from "../services/workspace.service.js";
import { sandboxContent } from "./respond.js";
import { idParams } from "./schemas.js";
import { signedIn, auditor } from "./guards.js";

export const register = signedIn((app, s) => {
  const auditAs = auditor(s);

  app.get("/api/workspace", async (request) => s.workspace.get(request.actor.id));
  app.put("/api/workspace", async (request) => {
    const { actor } = request;
    const saved = s.workspace.save(actor.id, workspaceSchema.parse(request.body));
    auditAs(actor, "workspace_update");
    s.events.publish({ type: "workspace.updated", userId: actor.id });
    return saved;
  });

  app.get("/api/settings", async (request) => s.preferences.get(request.actor.id));
  app.patch("/api/settings", async (request) => s.preferences.patchSettings(request.actor.id, settingsSchema.parse(request.body)));
  app.get("/api/archive-passwords", async (request) => s.tasks.archivePasswords.list(request.actor.id));
  app.post("/api/archive-passwords", async (request) => s.tasks.archivePasswords.add(request.actor.id, archivePasswordSchema.parse(request.body)));
  app.delete("/api/archive-passwords/:id", async (request) => {
    const params = idParams.parse(request.params);
    return s.tasks.archivePasswords.remove(request.actor.id, params.id);
  });
  app.put("/api/folder-views", async (request) => s.preferences.setFolderView(request.actor.id, folderViewSchema.parse(request.body)));
  app.delete("/api/folder-views", async (request) => s.preferences.resetFolderView(request.actor.id, folderViewQuerySchema.parse(request.query)));
  app.put("/api/favorites", async (request) => s.preferences.addFavorite(request.actor.id, favoriteSchema.parse(request.body)));
  app.delete("/api/favorites", async (request) => s.preferences.removeFavorite(request.actor.id, favoriteSchema.parse(request.query)));

  // One desktop background per person, kept as a picture of its own so the file it came from can move or go.
  app.get("/api/wallpaper", async (request, reply) => {
    const file = s.fsService.wallpaperPath(request.actor.id);
    const stat = await fs.promises.stat(file).catch(() => null);
    if (!stat) throw new AppError(404, "No desktop background is set", "NO_WALLPAPER");
    // The address names the time it was set, so a new one is never answered from the browser's cache.
    reply.header("Cache-Control", "private, max-age=31536000, immutable");
    sandboxContent(reply);
    return sendFile(request, reply, file, stat, "image/avif");
  });
  app.post("/api/wallpaper", async (request) => {
    const { actor } = request;
    const body = fsQuerySchema.parse(request.body);
    await s.fsService.setWallpaper(actor, body.rootSlug, body.path);
    return s.preferences.setWallpaper(actor.id, true);
  });
  app.delete("/api/wallpaper", async (request) => {
    const { actor } = request;
    await s.fsService.clearWallpaper(actor);
    return s.preferences.setWallpaper(actor.id, false);
  });

  // One profile picture per person, kept the same way. Unlike the background it is shown to others, so anyone signed in may ask for it.
  app.get("/api/users/:id/avatar", async (request, reply) => {
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
    const { actor } = request;
    const body = avatarSchema.parse(request.body);
    await s.fsService.setAvatar(actor, body.rootSlug, body.path, body.crop);
    const user = s.auth.setAvatar(actor.id, true);
    s.events.publish({ type: "account.updated", userId: actor.id });
    return { user };
  });
  app.delete("/api/avatar", async (request) => {
    const { actor } = request;
    await s.fsService.clearAvatar(actor);
    const user = s.auth.setAvatar(actor.id, false);
    s.events.publish({ type: "account.updated", userId: actor.id });
    return { user };
  });
});
