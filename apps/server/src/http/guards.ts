import type { FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import type { Actor } from "../services/types.js";
import type { Services } from "./services.js";

export function guards(s: Services) {
  const requireActor = (request: FastifyRequest) => s.auth.requireActor(request);
  const requireAdmin = (request: FastifyRequest) => {
    const actor = s.auth.requireActor(request);
    if (actor.role !== "ADMIN") {
      s.audit.write({
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
  const auditAs = (actor: Actor, action: string, target?: unknown, rootId?: string) =>
    s.audit.write({ actorType: "user", actorId: actor.id, action, rootId, target, result: "success" });
  return { requireActor, requireAdmin, auditAs };
}
