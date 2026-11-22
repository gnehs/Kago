import { z } from "zod";
import { syncJobSchema } from "../services/sync.service.js";
import { convertInputSchema, remuxInputSchema } from "../services/convert.service.js";
import { convertJobSchema } from "../services/convert-job.service.js";
import { idParams } from "./schemas.js";
import { signedIn } from "./guards.js";

export const register = signedIn((app, s) => {
  app.get("/api/sync-jobs", async (request) => s.sync.list(request.actor));
  app.post("/api/sync-jobs", async (request) => s.sync.create(request.actor, syncJobSchema.parse(request.body)));
  app.put("/api/sync-jobs/:id", async (request) => {
    const params = idParams.parse(request.params);
    return s.sync.update(request.actor, params.id, syncJobSchema.parse(request.body));
  });
  app.delete("/api/sync-jobs/:id", async (request) => {
    s.sync.delete(request.actor, idParams.parse(request.params).id);
    return { ok: true };
  });
  app.get("/api/sync-jobs/:id/trial", async (request) => s.sync.trial(request.actor, idParams.parse(request.params).id));
  app.get("/api/sync-jobs/:id/runs", async (request) => s.sync.runs(request.actor, idParams.parse(request.params).id));
  app.post("/api/sync-jobs/:id/run", async (request) => s.sync.run(request.actor, idParams.parse(request.params).id));

  app.post("/api/convert", async (request) => s.tasks.createConvert(request.actor, convertInputSchema.parse(request.body)));
  app.get("/api/convert/support", async () => s.tasks.convert.support());
  app.post("/api/remux", async (request) => s.tasks.createRemux(request.actor, remuxInputSchema.parse(request.body)));
  app.get("/api/convert-jobs", async (request) => s.convertJobs.list(request.actor));
  app.post("/api/convert-jobs", async (request) => s.convertJobs.create(request.actor, convertJobSchema.parse(request.body)));
  app.put("/api/convert-jobs/:id", async (request) => {
    const params = idParams.parse(request.params);
    return s.convertJobs.update(request.actor, params.id, convertJobSchema.parse(request.body));
  });
  app.delete("/api/convert-jobs/:id", async (request) => {
    s.convertJobs.delete(request.actor, idParams.parse(request.params).id);
    return { ok: true };
  });
  app.get("/api/convert-jobs/:id/runs", async (request) => s.convertJobs.runs(request.actor, idParams.parse(request.params).id));
  app.get("/api/convert-jobs/:id/runs/:taskId/files", async (request) => {
    const params = z.object({ id: z.string(), taskId: z.string() }).parse(request.params);
    return s.convertJobs.runFiles(request.actor, params.id, params.taskId);
  });
  app.post("/api/convert-jobs/:id/run", async (request) => s.convertJobs.run(request.actor, idParams.parse(request.params).id));
  app.post("/api/convert-jobs/:id/structure", async (request) => s.convertJobs.copyStructure(request.actor, idParams.parse(request.params).id));
});
