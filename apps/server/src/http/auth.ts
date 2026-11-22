import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";
import { changePasswordSchema, loginSchema, setupAdminSchema } from "../services/auth.service.js";
import { idParams } from "./schemas.js";
import type { Services } from "./services.js";
import { signedIn, auditor } from "./guards.js";

const userRoutes = signedIn((app, s) => {
  const auditAs = auditor(s);
  // Linking is asked for with a request another site cannot make, so nobody is led into linking an identity that is not theirs.
  app.post("/api/auth/oidc/link", async (request, reply) => ({ url: await s.oidc.begin(reply, { returnTo: "/_kago/account", linkUserId: request.actor.id }) }));
  app.get("/api/auth/identities", async (request) => {
    const { actor } = request;
    return { sso: s.oidc.publicInfo(), hasPassword: s.auth.hasPassword(actor.id), identities: s.oidc.identitiesOf(actor.id) };
  });
  app.delete("/api/auth/identities/:id", async (request) => {
    const { actor } = request;
    const params = idParams.parse(request.params);
    s.oidc.unlink(actor.id, params.id, { keepWayIn: true, request });
    auditAs(actor, "sso_unlink", { userId: actor.id });
    return { ok: true };
  });
  app.post("/api/auth/password", async (request) => {
    const { actor } = request;
    await s.auth.changePassword(request, actor, changePasswordSchema.parse(request.body));
    auditAs(actor, "password_change");
    return { ok: true };
  });

  app.get("/api/admins", async () => s.auth.listAdminContacts());
});

export function register(app: FastifyInstance, s: Services) {
  const auditAs = auditor(s);

  // `oidc` is what the sign-in page needs to offer single sign-on: nothing of how it is set up.
  app.get("/api/auth/setup", async () => ({ needsSetup: s.auth.needsSetup(), oidc: s.oidc.publicInfo() }));
  app.post("/api/auth/setup", async (request, reply) => {
    const actor = await s.auth.setupAdmin(request, reply, setupAdminSchema.parse(request.body));
    auditAs(actor, "setup_admin");
    return { user: actor };
  });

  app.post("/api/auth/login", async (request, reply) => {
    const input = loginSchema.parse(request.body);
    try {
      const actor = await s.auth.login(request, reply, input.email, input.password);
      auditAs(actor, "login_success");
      return { user: actor };
    } catch (error) {
      s.audit.write({ actorType: "system", action: "login_failed", target: { email: input.email }, result: "failure", ip: request.ip, userAgent: request.headers["user-agent"] });
      throw error;
    }
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const actor = s.auth.actorFromRequest(request);
    s.auth.logout(request, reply);
    if (actor) auditAs(actor, "logout");
    return { ok: true };
  });

  // Single sign-on. These two are pages the browser is sent to, not calls the interface makes: whatever goes wrong
  // ends in a redirect back to the sign-in page, which says what it was.
  const ssoFailure = (error: unknown) => (error instanceof AppError ? error.code : "OIDC_FAILED");
  app.get("/api/auth/oidc/start", async (request, reply) => {
    const query = z.object({ returnTo: z.string().optional() }).safeParse(request.query);
    reply.header("Cache-Control", "no-store");
    try {
      return reply.redirect(await s.oidc.begin(reply, { returnTo: query.data?.returnTo }));
    } catch (error) {
      if (!(error instanceof AppError)) logger.error("single sign-on could not be started", error);
      return reply.redirect(`/login?sso_error=${ssoFailure(error)}`);
    }
  });
  app.get("/api/auth/oidc/callback", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    // Kept out of the Referer of whatever the page loads next: the address carries the code.
    reply.header("Referrer-Policy", "no-referrer");
    const seen = { ip: request.ip, userAgent: request.headers["user-agent"] };
    try {
      const outcome = await s.oidc.finish(request, reply);
      if (outcome.kind === "link") {
        s.audit.write({ actorType: "user", actorId: outcome.actor.id, action: "sso_link", result: "success", ...seen });
        return reply.redirect("/_kago/account?sso=linked");
      }
      if (outcome.merged) s.audit.write({ actorType: "user", actorId: outcome.actor.id, action: "sso_link", target: { method: "email" }, result: "success", ...seen });
      if (outcome.created) s.audit.write({ actorType: "system", action: "user_create", target: { userId: outcome.actor.id, email: outcome.actor.email, method: "sso" }, result: "success", ...seen });
      s.audit.write({ actorType: "user", actorId: outcome.actor.id, action: "login_success", target: { method: "sso" }, result: "success", ...seen });
      return reply.redirect(outcome.returnTo);
    } catch (error) {
      if (!(error instanceof AppError)) logger.error("single sign-on failed", error);
      const actor = s.auth.actorFromRequest(request);
      s.audit.write({ actorType: actor ? "user" : "system", actorId: actor?.id, action: actor ? "sso_link" : "login_failed", target: { method: "sso", code: ssoFailure(error) }, result: "failure", ...seen });
      // Someone signed in was linking an identity, and goes back to where they asked for it.
      return reply.redirect(`${actor ? "/_kago/account" : "/login"}?sso_error=${ssoFailure(error)}`);
    }
  });

  app.get("/api/auth/me", async (request) => ({ user: s.auth.actorFromRequest(request) }));
  userRoutes(app, s);
}
