import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { Actor, PublicUser, User } from "./types.js";

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  displayName: z.string().min(1).max(120),
  role: z.enum(["ADMIN", "USER", "GUEST"]).default("USER")
});

export const setupAdminSchema = createUserSchema.extend({
  role: z.literal("ADMIN").default("ADMIN")
});

export const patchUserSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  role: z.enum(["ADMIN", "USER", "GUEST"]).optional(),
  disabled: z.boolean().optional()
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8)
});

export const resetPasswordSchema = z.object({ password: z.string().min(8) });

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly env: Env
  ) {}

  async ensureInitialAdminFromEnv(): Promise<void> {
    const count = row<{ count: number }>(this.db.prepare("SELECT COUNT(*) AS count FROM users").get())?.count ?? 0;
    if (count > 0) return;
    if (!this.env.initialAdminEmail || !this.env.initialAdminPassword) return;
    await this.createUser({
      email: this.env.initialAdminEmail,
      password: this.env.initialAdminPassword,
      displayName: "Kago Admin",
      role: "ADMIN"
    });
  }

  needsSetup(): boolean {
    const count = row<{ count: number }>(this.db.prepare("SELECT COUNT(*) AS count FROM users").get())?.count ?? 0;
    return count === 0;
  }

  async setupAdmin(request: FastifyRequest, reply: FastifyReply, input: z.infer<typeof setupAdminSchema>): Promise<Actor> {
    if (!this.needsSetup()) throw new AppError(409, "Kago is already initialized", "SETUP_ALREADY_DONE");
    await this.createUser({ ...input, role: "ADMIN" });
    return this.login(request, reply, input.email, input.password);
  }

  async createUser(input: z.infer<typeof createUserSchema>): Promise<PublicUser> {
    const ts = now();
    const user: User = {
      id: id("user"),
      email: input.email.toLowerCase(),
      password_hash: await hashPassword(input.password),
      display_name: input.displayName,
      role: input.role,
      disabled: 0,
      created_at: ts,
      updated_at: ts
    };
    this.db
      .prepare(
        `INSERT INTO users
        (id, email, password_hash, display_name, role, disabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        user.id,
        user.email,
        user.password_hash,
        user.display_name,
        user.role,
        user.disabled,
        user.created_at,
        user.updated_at
      );
    return this.publicUser(user);
  }

  listUsers(): PublicUser[] {
    return rows<User>(this.db.prepare("SELECT * FROM users ORDER BY created_at ASC").all()).map((user) =>
      this.publicUser(user)
    );
  }

  /** Who a user without access can turn to. Deliberately limited to name and email. */
  listAdminContacts(): Array<{ displayName: string; email: string }> {
    return rows<User>(this.db.prepare("SELECT * FROM users WHERE role = 'ADMIN' AND disabled = 0 ORDER BY created_at ASC").all()).map((user) => ({
      displayName: user.display_name,
      email: user.email
    }));
  }

  patchUser(userId: string, input: z.infer<typeof patchUserSchema>): PublicUser {
    const user = this.getUser(userId);
    const nextRole = input.role ?? user.role;
    const nextDisabled = input.disabled === undefined ? user.disabled : input.disabled ? 1 : 0;
    if (user.role === "ADMIN" && (nextRole !== "ADMIN" || nextDisabled)) {
      this.assertAnotherEnabledAdmin(userId);
    }
    this.db
      .prepare("UPDATE users SET display_name = ?, role = ?, disabled = ?, updated_at = ? WHERE id = ?")
      .run(
        input.displayName ?? user.display_name,
        nextRole,
        nextDisabled,
        now(),
        userId
      );
    return this.publicUser(this.getUser(userId));
  }

  /** Changes the caller's own password after re-checking the current one. */
  async changePassword(request: FastifyRequest, actor: Actor, input: z.infer<typeof changePasswordSchema>): Promise<void> {
    if (!(await verifyPassword(input.currentPassword, this.getUser(actor.id).password_hash))) {
      throw new AppError(403, "Current password is incorrect", "INVALID_CURRENT_PASSWORD");
    }
    await this.setPassword(request, actor.id, input.newPassword);
  }

  /** Stores a new password and signs the user out everywhere except the session making the request. */
  async setPassword(request: FastifyRequest, userId: string, password: string): Promise<void> {
    this.getUser(userId);
    this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").run(await hashPassword(password), now(), userId);
    this.db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").run(userId, sha256(request.cookies.kago_session ?? ""));
  }

  async login(request: FastifyRequest, reply: FastifyReply, email: string, password: string): Promise<Actor> {
    const user = row<User>(this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()));
    if (!user || user.disabled || !(await verifyPassword(password, user.password_hash))) {
      throw new AppError(401, "Invalid email or password", "INVALID_LOGIN");
    }

    const token = randomToken();
    const ts = now();
    this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(id("sess"), user.id, sha256(token), ts + 60 * 60 * 24 * 30, ts, ts);

    reply.setCookie("kago_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.protocol === "https",
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });

    return this.actorFromUser(user);
  }

  logout(request: FastifyRequest, reply: FastifyReply): void {
    const token = request.cookies.kago_session;
    if (token) this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(sha256(token));
    reply.clearCookie("kago_session", { path: "/" });
  }

  actorFromRequest(request: FastifyRequest): Actor | null {
    const token = request.cookies.kago_session;
    if (!token) return null;
    const ts = now();
    const user = row<User>(
      this.db
        .prepare(
          `SELECT users.* FROM sessions
          JOIN users ON users.id = sessions.user_id
          WHERE sessions.token_hash = ? AND sessions.expires_at > ?`
        )
        .get(sha256(token), ts)
    );
    if (!user || user.disabled) return null;
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(ts, sha256(token));
    return this.actorFromUser(user);
  }

  requireActor(request: FastifyRequest): Actor {
    const actor = this.actorFromRequest(request);
    if (!actor) throw new AppError(401, "Authentication required", "AUTH_REQUIRED");
    return actor;
  }

  getUser(userId: string): User {
    const user = row<User>(this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId));
    if (!user) throw new AppError(404, "User not found", "USER_NOT_FOUND");
    return user;
  }

  private assertAnotherEnabledAdmin(userId: string): void {
    const count = row<{ count: number }>(
      this.db
        .prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND disabled = 0 AND id != ?")
        .get(userId)
    )?.count ?? 0;
    if (count === 0) throw new AppError(409, "Cannot remove the last enabled admin", "LAST_ADMIN_REQUIRED");
  }

  private publicUser(user: User): PublicUser {
    const { password_hash: _passwordHash, ...publicUser } = user;
    return publicUser;
  }

  private actorFromUser(user: User): Actor {
    return {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      disabled: Boolean(user.disabled)
    };
  }
}
