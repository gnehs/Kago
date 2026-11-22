import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { taskInputSchema, transferCheckSchema } from "../services/task.service.js";
import { contentDisposition } from "./respond.js";
import type { Services } from "./services.js";
import { guards } from "./guards.js";

export function register(app: FastifyInstance, s: Services) {
  const { requireActor } = guards(s);

  app.get("/api/tasks", async (request) => s.tasks.list(requireActor(request)));
  app.post("/api/tasks", async (request) => s.tasks.create(requireActor(request), taskInputSchema.parse(request.body)));
  app.post("/api/tasks/conflicts", async (request) => s.tasks.transferConflicts(requireActor(request), transferCheckSchema.parse(request.body)));
  app.delete("/api/tasks", async (request) => s.tasks.clearFinished(requireActor(request)));
  app.get("/api/tasks/:id", async (request) => {
    const actor = requireActor(request);
    return s.tasks.getForActor(actor, z.object({ id: z.string() }).parse(request.params).id);
  });
  app.get("/api/tasks/:id/download", async (request, reply) => {
    const actor = requireActor(request);
    const file = await s.tasks.openDownload(actor, z.object({ id: z.string() }).parse(request.params).id);
    reply.header("Content-Type", "application/zip");
    reply.header("Content-Length", String(file.size));
    reply.header("Content-Disposition", contentDisposition("attachment", file.fileName));
    return fs.createReadStream(file.path);
  });
  app.post("/api/tasks/:id/cancel", async (request) => {
    const actor = requireActor(request);
    return s.tasks.cancel(actor, z.object({ id: z.string() }).parse(request.params).id);
  });
  app.post("/api/tasks/:id/retry", async (request) => {
    const actor = requireActor(request);
    const task = s.tasks.retryable(actor, z.object({ id: z.string() }).parse(request.params).id);
    return (await s.sync.retryRun(actor, task)) ?? (await s.convertJobs.retryRun(actor, task)) ?? s.tasks.retry(actor, task.id);
  });
  app.post("/api/tasks/:id/pause", async (request) => {
    const actor = requireActor(request);
    return s.tasks.pause(actor, z.object({ id: z.string() }).parse(request.params).id);
  });
  app.post("/api/tasks/:id/resume", async (request) => {
    const actor = requireActor(request);
    return s.tasks.resume(actor, z.object({ id: z.string() }).parse(request.params).id);
  });

  app.get("/api/trash", async (request) => s.tasks.listTrash(requireActor(request)));
  app.delete("/api/trash", async (request) => s.tasks.emptyTrash(requireActor(request)));
  app.post("/api/trash/cost", async (request) => s.tasks.trashCost(requireActor(request), z.object({ sources: z.array(z.object({ rootSlug: z.string().min(1), path: z.string().min(1) })) }).parse(request.body).sources));
  app.post("/api/trash/:id/restore", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    return s.tasks.createRestoreTrash(actor, params.id);
  });

  app.get("/api/shelves", async (request) => s.shelves.list(requireActor(request)));
  app.post("/api/shelves", async (request) => {
    const actor = requireActor(request);
    const body = z.object({ name: z.string().min(1).max(120) }).parse(request.body);
    return s.shelves.create(actor, body.name);
  });
  app.post("/api/shelves/:id/items", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string() }).parse(request.params);
    const body = z.object({ rootSlug: z.string(), path: z.string() }).parse(request.body);
    return s.shelves.addItem(actor, params.id, body.rootSlug, body.path);
  });
  app.delete("/api/shelves/:id/items/:itemId", async (request) => {
    const actor = requireActor(request);
    const params = z.object({ id: z.string(), itemId: z.string() }).parse(request.params);
    s.shelves.removeItem(actor, params.id, params.itemId);
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
    const items = s.shelves.itemsForTask(actor, params.id);
    return s.tasks.create(actor, {
      type: body.type,
      sources: items.map((item) => ({ rootSlug: item.root_slug, path: item.path })),
      destination: body.destination,
      options: body.options
    });
  });
}
