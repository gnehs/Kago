import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Env } from "../config/env.js";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { hashPassword, randomToken, sha256, verifyPassword } from "../lib/crypto.js";
import { attemptKeyPart, AttemptLimiter } from "../lib/attempts.js";
import { AppError } from "../lib/errors.js";
import { id, now } from "../lib/ids.js";
import type { Actor, PublicUser, User } from "./types.js";

/** How many wrong passwords one address may try for one account, and for all accounts, before it is made to wait. */
const LOGIN_TRIES = 5;
const LOGIN_TRIES_PER_ADDRESS = 50;

/** No address or password is this long; one that is was written to be costly to handle. */
const MAX_EMAIL = 320;
export const MAX_PASSWORD = 1024;

/** Stored for an account that has no password of its own: nothing typed at the sign-in form matches it. */
const NO_PASSWORD = "none";
const hasPassword = (user: User) => user.password_hash.startsWith("scrypt:");

export const loginSchema = z.object({
  email: z.string().email().max(MAX_EMAIL),
  password: z.string().min(1).max(MAX_PASSWORD)
});

export const createUserSchema = z.object({
  email: z.string().email().max(MAX_EMAIL),
  password: z.string().min(8).max(MAX_PASSWORD),
  displayName: z.string().min(1).max(120),
  role: z.enum(["ADMIN", "USER"]).default("USER")
});

export const setupAdminSchema = createUserSchema.extend({
  role: z.literal("ADMIN").default("ADMIN")
});

export const patchUserSchema = z.object({
  displayName: z.string().min(1).max(120).optional(),
  role: z.enum(["ADMIN", "USER"]).optional(),
  disabled: z.boolean().optional()
});

export const changePasswordSchema = z.object({
  /** Left out by an account that has no password yet and is setting its first. */
  currentPassword: z.string().min(1).max(MAX_PASSWORD).optional(),
  newPassword: z.string().min(8).max(MAX_PASSWORD)
});

export const resetPasswordSchema = z.object({ password: z.string().min(8).max(MAX_PASSWORD) });

export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly env: Env
  ) {}

  private readonly attempts = new AttemptLimiter();
  private decoy: Promise<string> | undefined;

  /** Told of each request a session makes, by the hash of its token; single sign-on uses it to ask the provider whether the session still stands. */
  onSession: ((tokenHash: string) => void) | undefined;

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
    await this.createUser({ ...input, role: "ADMIN" }, true);
    return this.login(request, reply, input.email, input.password);
  }

  /** `first` makes the user only where there is none yet: of two people setting Kago up at once, one is its administrator. */
  async createUser(input: z.infer<typeof createUserSchema>, first = false): Promise<PublicUser> {
    const ts = now();
    const user: User = {
      id: id("user"),
      email: input.email.toLowerCase(),
      password_hash: await hashPassword(input.password),
      display_name: input.displayName,
      role: input.role,
      disabled: 0,
      avatar_at: null,
      created_at: ts,
      updated_at: ts
    };
    // Asked again here, after the wait for the password to be hashed, with nothing between the question and the insert.
    if (first && !this.needsSetup()) throw new AppError(409, "Kago is already initialized", "SETUP_ALREADY_DONE");
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

  /**
   * An account for someone the identity provider vouched for. It has no password: it is entered through the provider
   * until its owner, or an administrator, gives it one. Never an administrator: what the provider says decides who
   * someone is, not what they may do.
   */
  createExternalUser(input: { email: string; displayName: string }): User {
    const ts = now();
    const user: User = { id: id("user"), email: input.email.toLowerCase(), password_hash: NO_PASSWORD, display_name: input.displayName, role: "USER", disabled: 0, avatar_at: null, created_at: ts, updated_at: ts };
    this.db
      .prepare("INSERT INTO users (id, email, password_hash, display_name, role, disabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(user.id, user.email, user.password_hash, user.display_name, user.role, user.disabled, user.created_at, user.updated_at);
    return user;
  }

  findUserByEmail(email: string): User | null {
    return row<User>(this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()));
  }

  hasPassword(userId: string): boolean {
    return hasPassword(this.getUser(userId));
  }

  listUsers(): Array<PublicUser & { has_password: boolean }> {
    return rows<User>(this.db.prepare("SELECT * FROM users ORDER BY created_at ASC").all()).map((user) => ({
      ...this.publicUser(user),
      has_password: hasPassword(user)
    }));
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

  /** Notes that a person's profile picture was set just now, or that they have none any more. */
  setAvatar(userId: string, present: boolean): Actor {
    this.db.prepare("UPDATE users SET avatar_at = ?, updated_at = ? WHERE id = ?").run(present ? Date.now() : null, now(), userId);
    return this.actorFromUser(this.getUser(userId));
  }

  /** Changes the caller's own password after re-checking the current one. */
  async changePassword(request: FastifyRequest, actor: Actor, input: z.infer<typeof changePasswordSchema>): Promise<void> {
    const user = this.getUser(actor.id);
    // An account made through single sign-on has no password to ask for before its first is set.
    if (hasPassword(user)) {
      // Whoever holds a session that is not theirs does not get to find the password out by trying.
      const attempt = this.attempts.begin([{ key: `password:${actor.id}`, limit: LOGIN_TRIES }]);
      if (!input.currentPassword || !(await verifyPassword(input.currentPassword, user.password_hash))) {
        throw new AppError(403, "Current password is incorrect", "INVALID_CURRENT_PASSWORD");
      }
      attempt.succeeded();
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
    const address = request.ip ?? "";
    // Counted before the password is looked at: checking one is the costly part, and is what a guesser wants done for free.
    const attempt = this.attempts.begin([
      { key: `login:${address}:${attemptKeyPart(email.toLowerCase())}`, limit: LOGIN_TRIES },
      { key: `login-from:${address}`, limit: LOGIN_TRIES_PER_ADDRESS }
    ]);
    const user = row<User>(this.db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase()));
    // An address without an account, or whose account has no password, is checked against a password all the same,
    // so how long the answer takes does not tell which addresses have one.
    const usable = user && !user.disabled && hasPassword(user) ? user : undefined;
    const matches = await verifyPassword(password, usable?.password_hash ?? (await (this.decoy ??= hashPassword(randomToken()))));
    if (!usable || !matches) {
      throw new AppError(401, "Invalid email or password", "INVALID_LOGIN");
    }
    attempt.succeeded();
    return this.startSession(request, reply, usable).actor;
  }

  /** Signs `user` in on this browser. Whoever calls has already made sure it is them. */
  startSession(request: FastifyRequest, reply: FastifyReply, user: User): { actor: Actor; sessionId: string } {
    const token = randomToken();
    const sessionId = id("sess");
    const ts = now();
    // Sessions that have run out are of no use to anyone; signing in is as good a moment as any to clear them.
    this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(ts);
    this.db
      .prepare(
        "INSERT INTO sessions (id, user_id, token_hash, expires_at, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .run(sessionId, user.id, sha256(token), ts + 60 * 60 * 24 * 30, ts, ts);

    reply.setCookie("kago_session", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: request.protocol === "https",
      path: "/",
      maxAge: 60 * 60 * 24 * 30
    });

    return { actor: this.actorFromUser(user), sessionId };
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
    const actor = this.actorForSessionAt(token, ts);
    if (!actor) return null;
    const tokenHash = sha256(token);
    this.db.prepare("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?").run(ts, tokenHash);
    this.onSession?.(tokenHash);
    return actor;
  }

  /** Checks a session without changing last_seen_at, for long-lived connections that revalidate on events. */
  actorForSession(token: string | undefined): Actor | null {
    if (!token) return null;
    return this.actorForSessionAt(token, now());
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
      disabled: Boolean(user.disabled),
      avatar: user.avatar_at
    };
  }

  private actorForSessionAt(token: string, ts: number): Actor | null {
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
    return this.actorFromUser(user);
  }
}
