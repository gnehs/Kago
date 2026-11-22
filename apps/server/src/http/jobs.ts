import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { syncJobSchema } from "../services/sync.service.js";
import { convertInputSchema, remuxInputSchema } from "../services/convert.service.js";
import { convertJobSchema } from "../services/convert-job.service.js";
import { idParams } from "./schemas.js";
import type { Services } from "./services.js";
import { guards } from "./guards.js";

export function register(app: FastifyInstance, s: Services) {
  const { requireActor } = guards(s);

  app.get("/api/sync-jobs", async (request) => s.sync.list(requireActor(request)));
  app.post("/api/sync-jobs", async (request) => s.sync.create(requireActor(request), syncJobSchema.parse(request.body)));
  app.put("/api/sync-jobs/:id", async (request) => {
    const params = idParams.parse(request.params);
    return s.sync.update(requireActor(request), params.id, syncJobSchema.parse(request.body));
  });
  app.delete("/api/sync-jobs/:id", async (request) => {
    s.sync.delete(requireActor(request), idParams.parse(request.params).id);
    return { ok: true };
  });
  app.get("/api/sync-jobs/:id/trial", async (request) => s.sync.trial(requireActor(request), idParams.parse(request.params).id));
  app.get("/api/sync-jobs/:id/runs", async (request) => s.sync.runs(requireActor(request), idParams.parse(request.params).id));
  app.post("/api/sync-jobs/:id/run", async (request) => s.sync.run(requireActor(request), idParams.parse(request.params).id));

  app.post("/api/convert", async (request) => s.tasks.createConvert(requireActor(request), convertInputSchema.parse(request.body)));
  app.get("/api/convert/support", async (request) => {
    requireActor(request);
    return s.tasks.convert.support();
  });
  app.post("/api/remux", async (request) => s.tasks.createRemux(requireActor(request), remuxInputSchema.parse(request.body)));
  app.get("/api/convert-jobs", async (request) => s.convertJobs.list(requireActor(request)));
  app.post("/api/convert-jobs", async (request) => s.convertJobs.create(requireActor(request), convertJobSchema.parse(request.body)));
  app.put("/api/convert-jobs/:id", async (request) => {
    const params = idParams.parse(request.params);
    return s.convertJobs.update(requireActor(request), params.id, convertJobSchema.parse(request.body));
  });
  app.delete("/api/convert-jobs/:id", async (request) => {
    s.convertJobs.delete(requireActor(request), idParams.parse(request.params).id);
    return { ok: true };
  });
  app.get("/api/convert-jobs/:id/runs", async (request) => s.convertJobs.runs(requireActor(request), idParams.parse(request.params).id));
  app.get("/api/convert-jobs/:id/runs/:taskId/files", async (request) => {
    const params = z.object({ id: z.string(), taskId: z.string() }).parse(request.params);
    return s.convertJobs.runFiles(requireActor(request), params.id, params.taskId);
  });
  app.post("/api/convert-jobs/:id/run", async (request) => s.convertJobs.run(requireActor(request), idParams.parse(request.params).id));
  app.post("/api/convert-jobs/:id/structure", async (request) => s.convertJobs.copyStructure(requireActor(request), idParams.parse(request.params).id));
}
