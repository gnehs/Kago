import type { AuditAction } from "@kago/contract";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { AppError } from "../lib/errors.js";
import type { Actor } from "../services/types.js";
import type { Services } from "./services.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Who is signed in. Set only for routes registered through `signedIn` or `adminOnly`. */
    actor: Actor;
  }
}

type Routes = (app: FastifyInstance, s: Services) => void;

/**
 * Routes that only someone signed in may reach. A route registered anywhere else is public, so each file says which
 * it is. The guard runs after the CSRF check and before the handler, which reads `request.actor`.
 */
export const signedIn = (routes: Routes): Routes => guarded(routes, (s, request) => s.auth.requireActor(request));

/** Routes for administrators only; anyone else signed in is turned away and the attempt is recorded. */
export const adminOnly = (routes: Routes): Routes =>
  guarded(routes, (s, request) => {
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
      throw new AppError(403, "Admin required", "ADMIN_REQUIRED", true);
    }
    return actor;
  });

function guarded(routes: Routes, resolve: (s: Services, request: FastifyRequest) => Actor): Routes {
  return (app, s) => {
    void app.register(async (scope) => {
      scope.decorateRequest("actor", null as unknown as Actor);
      scope.addHook("preHandler", async (request) => {
        request.actor = resolve(s, request);
      });
      routes(scope, s);
    });
  };
}

export const auditor = (s: Services) => (actor: Actor, action: AuditAction, target?: unknown, rootId?: string) =>
  s.audit.write({ actorType: "user", actorId: actor.id, action, rootId, target, result: "success" });
