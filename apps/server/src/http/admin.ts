import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditQuerySchema } from "../services/audit.service.js";
import { createUserSchema, patchUserSchema, resetPasswordSchema } from "../services/auth.service.js";
import { createGroupSchema } from "../services/group.service.js";
import { oidcConfigSchema } from "../services/oidc.service.js";
import { permissionSetSchema } from "../services/permission.service.js";
import { idParams } from "./schemas.js";
import type { Services } from "./services.js";
import { guards } from "./guards.js";

export function register(app: FastifyInstance, s: Services) {
  const { requireActor, requireAdmin, auditAs } = guards(s);

  const publishPermissionUpdated = (actor: ReturnType<typeof requireActor>, principalType: string, principalId: string) => {
    s.events.publish({ type: "permission.updated", userId: actor.id });
    if (principalType === "user" && principalId !== actor.id) {
      s.events.publish({ type: "permission.updated", userId: principalId });
    }
  };

  app.get("/api/sso", async (request) => {
    requireAdmin(request);
    return s.oidc.adminView();
  });
  app.put("/api/sso", async (request) => {
    const actor = requireAdmin(request);
    const config = await s.oidc.save(oidcConfigSchema.parse(request.body));
    auditAs(actor, "sso_update", { enabled: config.enabled, issuer: config.issuer, autoCreate: config.autoCreate, syncGroups: config.syncGroups });
    return config;
  });
  app.post("/api/sso/test", async (request) => {
    requireAdmin(request);
    return s.oidc.test(oidcConfigSchema.parse(request.body));
  });
  app.get("/api/users", async (request) => {
    requireAdmin(request);
    const identities = s.oidc.identitiesByUser();
    return s.auth.listUsers().map((user) => ({ ...user, identities: identities.get(user.id) ?? [] }));
  });
  app.post("/api/users", async (request) => {
    const actor = requireAdmin(request);
    const user = await s.auth.createUser(createUserSchema.parse(request.body));
    auditAs(actor, "user_create", user);
    return user;
  });
  app.patch("/api/users/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = idParams.parse(request.params);
    const body = patchUserSchema.parse(request.body);
    const user = s.auth.patchUser(params.id, body);
    if (body.disabled !== undefined) {
      auditAs(actor, "user_disable", { userId: params.id, disabled: body.disabled });
    }
    if (body.displayName !== undefined || body.role !== undefined) {
      auditAs(actor, "user_update", { userId: params.id, displayName: body.displayName, role: body.role });
    }
    return user;
  });

  app.post("/api/users/:id/password", async (request) => {
    const actor = requireAdmin(request);
    const params = idParams.parse(request.params);
    await s.auth.setPassword(request, params.id, resetPasswordSchema.parse(request.body).password);
    auditAs(actor, "password_reset", { userId: params.id });
    return { ok: true };
  });
  app.delete("/api/users/:id/identities/:identityId", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string(), identityId: z.string() }).parse(request.params);
    s.oidc.unlink(params.id, params.identityId, { request });
    auditAs(actor, "sso_unlink", { userId: params.id });
    return { ok: true };
  });
  app.get("/api/groups", async (request) => {
    requireAdmin(request);
    return s.groups.list();
  });
  app.post("/api/groups", async (request) => {
    const actor = requireAdmin(request);
    const group = s.groups.create(createGroupSchema.parse(request.body).name);
    auditAs(actor, "group_create", group);
    return group;
  });
  app.patch("/api/groups/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = idParams.parse(request.params);
    const group = s.groups.rename(params.id, createGroupSchema.parse(request.body).name);
    auditAs(actor, "group_rename", group);
    return group;
  });
  app.delete("/api/groups/:id", async (request) => {
    const actor = requireAdmin(request);
    const params = idParams.parse(request.params);
    const removed = s.groups.remove(params.id);
    auditAs(actor, "group_delete", removed);
    return { ok: true };
  });
  app.post("/api/groups/:id/members", async (request) => {
    const actor = requireAdmin(request);
    const params = idParams.parse(request.params);
    const body = z.object({ userId: z.string() }).parse(request.body);
    s.groups.addMember(params.id, body.userId);
    auditAs(actor, "group_member_add", { groupId: params.id, userId: body.userId });
    return { ok: true };
  });
  app.delete("/api/groups/:id/members/:userId", async (request) => {
    const actor = requireAdmin(request);
    const params = z.object({ id: z.string(), userId: z.string() }).parse(request.params);
    s.groups.removeMember(params.id, params.userId);
    auditAs(actor, "group_member_remove", { groupId: params.id, userId: params.userId });
    return { ok: true };
  });
  app.post("/api/compatibility/server", async (request, reply) => {
    requireAdmin(request);
    reply.header("Cache-Control", "no-store");
    return s.compatibility.check();
  });

  app.get("/api/permissions", async (request) => {
    requireAdmin(request);
    const query = z.object({ rootId: z.string().optional() }).parse(request.query);
    return s.permissions.list(query.rootId);
  });
  app.put("/api/permissions", async (request) => {
    const actor = requireAdmin(request);
    const input = permissionSetSchema.parse(request.body);
    s.roots.getById(input.rootId);
    const item = s.permissions.set(input);
    auditAs(actor, "permission_change", item ?? { principalType: input.principalType, principalId: input.principalId, deleted: true }, input.rootId);
    publishPermissionUpdated(actor, input.principalType, input.principalId);
    return { rule: item };
  });

  app.get("/api/audit", async (request) => {
    requireAdmin(request);
    return s.audit.list(auditQuerySchema.parse(request.query));
  });
}
