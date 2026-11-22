import fs from "node:fs";
import { z } from "zod";
import { taskInputSchema, transferCheckSchema } from "../services/task.service.js";
import { contentDisposition } from "./respond.js";
import { idParams } from "./schemas.js";
import { signedIn } from "./guards.js";

export const register = signedIn((app, s) => {
  app.get("/api/tasks", async (request) => s.tasks.list(request.actor));
  app.post("/api/tasks", async (request) => s.tasks.create(request.actor, taskInputSchema.parse(request.body)));
  app.post("/api/tasks/conflicts", async (request) => s.tasks.transferConflicts(request.actor, transferCheckSchema.parse(request.body)));
  app.delete("/api/tasks", async (request) => s.tasks.clearFinished(request.actor));
  app.get("/api/tasks/:id", async (request) => s.tasks.getForActor(request.actor, idParams.parse(request.params).id));
  app.get("/api/tasks/:id/download", async (request, reply) => {
    const file = await s.tasks.openDownload(request.actor, idParams.parse(request.params).id);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Length", String(file.size));
    reply.header("Content-Disposition", contentDisposition("attachment", file.fileName));
    return fs.createReadStream(file.path);
  });
  app.post("/api/tasks/:id/cancel", async (request) => s.tasks.cancel(request.actor, idParams.parse(request.params).id));
  app.post("/api/tasks/:id/retry", async (request) => {
    const { actor } = request;
    const task = s.tasks.retryable(actor, idParams.parse(request.params).id);
    return (await s.sync.retryRun(actor, task)) ?? (await s.convertJobs.retryRun(actor, task)) ?? s.tasks.retry(actor, task.id);
  });
  app.post("/api/tasks/:id/pause", async (request) => s.tasks.pause(request.actor, idParams.parse(request.params).id));
  app.post("/api/tasks/:id/resume", async (request) => s.tasks.resume(request.actor, idParams.parse(request.params).id));

  app.get("/api/trash", async (request) => s.tasks.listTrash(request.actor));
  app.delete("/api/trash", async (request) => s.tasks.emptyTrash(request.actor));
  app.post("/api/trash/cost", async (request) => s.tasks.trashCost(request.actor, z.object({ sources: z.array(z.object({ rootSlug: z.string().min(1), path: z.string().min(1) })) }).parse(request.body).sources));
  app.post("/api/trash/:id/restore", async (request) => {
    const params = idParams.parse(request.params);
    return s.tasks.createRestoreTrash(request.actor, params.id);
  });

  app.get("/api/shelves", async (request) => s.shelves.list(request.actor));
  app.post("/api/shelves", async (request) => {
    const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    return s.shelves.create(request.actor, body.name);
  });
  app.post("/api/shelves/:id/items", async (request) => {
    const params = idParams.parse(request.params);
    const body = z.object({ rootSlug: z.string(), path: z.string() }).parse(request.body);
    return s.shelves.addItem(request.actor, params.id, body.rootSlug, body.path);
  });
  app.delete("/api/shelves/:id/items/:itemId", async (request) => {
    const params = z.object({ id: z.string(), itemId: z.string() }).parse(request.params);
    s.shelves.removeItem(request.actor, params.id, params.itemId);
    return { ok: true };
  });
  app.post("/api/shelves/:id/tasks", async (request) => {
    const { actor } = request;
    const params = idParams.parse(request.params);
    const body = z.object({
      type: z.enum(["copy", "move", "compress"]),
      destination: z.object({ rootSlug: z.string(), path: z.string() }),
      options: taskInputSchema.shape.options
    }).parse(request.body);
    const items = s.shelves.itemsForTask(actor, params.id);
    return s.tasks.create(actor, {
      type: body.type,
      sources: items.map((item) => ({ rootSlug: item.root_slug, path: item.path })),
      destination: body.destination,
      options: body.options
    });
  });
});
