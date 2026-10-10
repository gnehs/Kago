import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Db } from "../db/db.js";
import { row, rows } from "../db/db.js";
import { AttemptLimiter } from "../lib/attempts.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { AppError } from "../lib/errors.js";
import { TokenError, UnknownKeyError, verifyIdToken, type IdTokenClaims, type Jwk } from "../lib/id-token.js";
import { id, now } from "../lib/ids.js";
import { logger } from "../lib/logger.js";
import type { SecretBox } from "../lib/secret-box.js";
import type { EventPublisher } from "../ws/events.js";
import type { AuditService } from "./audit.service.js";
import type { AuthService } from "./auth.service.js";
import type { Actor } from "./types.js";

/** Holds what a sign-in under way has to remember between leaving for the provider and coming back. */
const FLOW_COOKIE = "kago_oidc";
const FLOW_PATH = "/api/auth/oidc";
/** How long someone has to finish signing in at the provider. */
const FLOW_SECONDS = 10 * 60;
/** For how long what the provider says about itself, and its keys, are believed before being asked for again. */
const METADATA_MS = 60 * 60_000;
/** A provider that did not answer is not asked again for this long: anyone can open the page that starts a sign-in. */
const UNREACHABLE_MS = 15_000;
/** Keys are fetched afresh when a token names one that is not known, but not more often than this. */
const KEYS_RETRY_MS = 60_000;
/** How often a session that came with a refresh token asks the provider whether it still stands. */
const REVALIDATE_SECONDS = 60 * 60;
/** When the provider could not be asked, how soon it is asked again. */
const RETRY_SECONDS = 5 * 60;
const TIMEOUT_MS = 10_000;
const MAX_BODY = 1024 * 1024;
/** How many answers from the provider one address may bring back in a stretch of time; each costs a request to the provider. */
const CALLBACK_TRIES = 30;
const MAX_WATCHED = 20_000;
const MAX_GROUPS = 1000;
const MAX_RETURN_TO = 512;

const isHttpUrl = (value: string) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

const withoutTrailingSlash = (value: string) => value.replace(/\/+$/, "");
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** The way RFC 6749 wants a client's name and secret written before they go into a Basic header. */
const formEncode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);

export const oidcConfigSchema = z.object({
  enabled: z.boolean(),
  /** What the sign-in button calls the provider. */
  name: z.string().trim().max(60).default(""),
  issuer: z.string().trim().max(2048).default(""),
  clientId: z.string().trim().max(512).default(""),
  /** Left out, the secret already kept stays; `null` forgets it, for a public client that has none. */
  clientSecret: z.string().max(4096).nullable().optional(),
  /** The address people reach Kago at, which the provider sends them back to. */
  publicUrl: z.string().trim().max(2048).default(""),
  scopes: z.string().trim().max(512).default("openid profile email"),
  /** Whether someone the provider vouches for, and Kago has never seen, is given an account. */
  autoCreate: z.boolean().default(false),
  /** Whether someone not signed in is sent straight to the provider. */
  autoRedirect: z.boolean().default(false),
  syncGroups: z.boolean().default(false),
  groupsClaim: z.string().trim().min(1).max(120).default("groups"),
  /** Which of the provider's groups puts someone into which of Kago's. */
  groupMappings: z.array(z.object({ external: z.string().trim().min(1).max(255), groupId: z.string().min(1).max(64) })).max(200).default([])
});

export type OidcConfigInput = z.infer<typeof oidcConfigSchema>;
/** As kept: the secret sealed. */
type OidcConfig = Omit<OidcConfigInput, "clientSecret"> & { clientSecret: string | null };

const storedSchema = oidcConfigSchema.omit({ clientSecret: true }).extend({ clientSecret: z.string().nullable().default(null) });

const endpoint = z.string().max(2048).refine(isHttpUrl);
const providerSchema = z.object({
  issuer: z.string().min(1).max(2048),
  authorization_endpoint: endpoint,
  token_endpoint: endpoint,
  jwks_uri: endpoint,
  userinfo_endpoint: endpoint.optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
  id_token_signing_alg_values_supported: z.array(z.string()).optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
  scopes_supported: z.array(z.string()).optional()
});
type Provider = z.infer<typeof providerSchema>;

const callbackSchema = z.object({
  code: z.string().min(1).max(4096).optional(),
  state: z.string().min(1).max(512),
  iss: z.string().max(2048).optional(),
  error: z.string().max(512).optional()
});

const flowSchema = z.object({
  state: z.string(),
  nonce: z.string(),
  verifier: z.string(),
  returnTo: z.string(),
  /** The user who asked to link an identity to their account, when that is what this sign-in is for. */
  link: z.string().nullable(),
  issuer: z.string(),
  expires: z.number()
});
type Flow = z.infer<typeof flowSchema>;

type Identity = {
  id: string;
  user_id: string;
  issuer: string;
  subject: string;
  email: string | null;
  display_name: string | null;
  created_at: number;
  last_login_at: number | null;
};

type Profile = { issuer: string; subject: string; email: string | null; /** Whether the provider says it has checked that the address is theirs. */ emailVerified: boolean; displayName: string; groups: string[] | null };

export type OidcOutcome =
  | { kind: "login"; actor: Actor; /** A new account was made for them. */ created: boolean; /** Their identity was linked to the account that has their email address. */ merged: boolean; returnTo: string }
  | { kind: "link"; actor: Actor; returnTo: string };

/** Where someone is sent after signing in: a page of Kago's own, never another site and never the API. */
export function safeReturnTo(value: string | undefined): string {
  if (!value || value.length > MAX_RETURN_TO || !/^\/(?![/\\])[\x21-\x7e]*$/.test(value) || value.startsWith("/api/")) return "/";
  return value;
}

async function fetchJson(url: string, init: RequestInit = {}): Promise<{ status: number; body: unknown }> {
  // A provider that answers with a redirect is not followed: the request, and the secret in it, goes where it was sent.
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: "application/json", ...init.headers } });
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of (response.body ?? []) as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_BODY) throw new Error("The answer is too large");
    chunks.push(Buffer.from(chunk));
  }
  let body: unknown = null;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // Left as null: whoever asked decides what an answer that is not JSON means.
  }
  return { status: response.status, body };
}

/** The provider's groups someone is in, or `null` when the provider did not say: then nothing is changed. */
function groupsOf(claims: Record<string, unknown>, claim: string): string[] | null {
  const value = claims[claim];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return null;
  return value.filter((group): group is string => typeof group === "string" && group.length > 0 && group.length <= 255).slice(0, MAX_GROUPS);
}

/**
 * Sign-in through an OpenID Connect provider. Kago is only ever the client: the provider says who someone is, by its
 * issuer and their subject (and, the first time, by an email address it has verified), and Kago's own users, groups
 * and rules go on deciding what they may do.
 */
export class OidcService {
  private readonly attempts = new AttemptLimiter();
  private discovered: { issuer: string; provider: Provider; at: number } | undefined;
  private keys: { uri: string; keys: Jwk[]; at: number } | undefined;
  private unreachable: { issuer: string; error: unknown; at: number } | undefined;
  /** When each session, by the hash of its token, is next worth looking at. */
  private readonly due = new Map<string, number>();

  constructor(
    private readonly db: Db,
    private readonly box: SecretBox,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly events: EventPublisher
  ) {
    auth.onSession = (tokenHash) => this.seen(tokenHash);
  }

  config(): OidcConfig {
    const stored = row<{ value_json: string }>(this.db.prepare("SELECT value_json FROM app_settings WHERE key = 'oidc'").get());
    let value: unknown = { enabled: false };
    try {
      if (stored) value = JSON.parse(stored.value_json);
    } catch {
      // Unreadable settings are the same as none: single sign-on is off until it is set up again.
    }
    const parsed = storedSchema.safeParse(value);
    return parsed.success ? parsed.data : storedSchema.parse({ enabled: false });
  }

  /** What the sign-in page may know before anyone has signed in. */
  publicInfo(): { name: string; autoRedirect: boolean } | null {
    const config = this.config();
    return config.enabled ? { name: config.name, autoRedirect: config.autoRedirect } : null;
  }

  adminView() {
    const { clientSecret, ...config } = this.config();
    return {
      ...config,
      hasClientSecret: clientSecret !== null,
      /** What has to be registered with the provider as this client's redirect address. */
      redirectUri: config.publicUrl ? this.redirectUri(config.publicUrl) : null
    };
  }

  /** Asks the provider at `input.issuer` about itself, without keeping anything. */
  async test(input: OidcConfigInput) {
    const { issuer, scopes } = this.checked(input);
    const provider = await this.discover(issuer);
    const offered = provider.scopes_supported;
    return {
      issuer: provider.issuer,
      /** Asked for, and not among the scopes the provider lists; it may refuse the sign-in over them. */
      unlistedScopes: offered ? scopes.split(" ").filter((scope) => !offered.includes(scope)) : []
    };
  }

  async save(input: OidcConfigInput) {
    const previous = this.config();
    const checked = this.checked(input);
    const groups = new Set(rows<{ id: string }>(this.db.prepare("SELECT id FROM groups").all()).map((group) => group.id));
    const mappings = new Map(input.groupMappings.filter((mapping) => groups.has(mapping.groupId)).map((mapping) => [`${mapping.external}\n${mapping.groupId}`, mapping]));
    const config: OidcConfig = {
      ...input,
      ...checked,
      // The issuer as the provider itself writes it is what its tokens carry, and what identities are kept under.
      issuer: input.enabled ? (await this.discover(checked.issuer)).issuer : checked.issuer,
      clientSecret: input.clientSecret === undefined ? previous.clientSecret : input.clientSecret ? this.box.seal(input.clientSecret) : null,
      groupMappings: [...mappings.values()]
    };
    this.db
      .prepare("INSERT INTO app_settings (key, value_json, updated_at) VALUES ('oidc', ?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at")
      .run(JSON.stringify(config), now());
    this.discovered = undefined;
    this.unreachable = undefined;
    this.keys = undefined;
    this.due.clear();
    return this.adminView();
  }

  /**
   * Starts a sign-in and returns the provider's address to send the browser to. With `linkUserId` the identity that
   * comes back is linked to that user, who is already signed in, instead of signing anyone in.
   */
  async begin(reply: FastifyReply, options: { returnTo?: string; linkUserId?: string }): Promise<string> {
    const config = this.enabledConfig();
    const provider = await this.provider(config.issuer);
    const flow: Flow = {
      state: randomToken(),
      nonce: randomToken(),
      verifier: randomToken(),
      returnTo: safeReturnTo(options.returnTo),
      link: options.linkUserId ?? null,
      issuer: provider.issuer,
      expires: now() + FLOW_SECONDS
    };
    // Sealed, so the browser carries it without being able to read or change it; nothing is kept here until it returns.
    reply.setCookie(FLOW_COOKIE, this.box.seal(JSON.stringify(flow)), {
      httpOnly: true,
      // Lax, not strict: the way back from the provider is a navigation that starts on its site.
      sameSite: "lax",
      secure: config.publicUrl.startsWith("https:"),
      path: FLOW_PATH,
      maxAge: FLOW_SECONDS
    });
    const url = new URL(provider.authorization_endpoint);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: this.redirectUri(config.publicUrl),
      scope: config.scopes,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: crypto.createHash("sha256").update(flow.verifier).digest("base64url"),
      code_challenge_method: "S256"
    })) {
      url.searchParams.set(name, value);
    }
    return url.toString();
  }

  /** Takes the provider's answer: checks it belongs to a sign-in this browser began, and signs in or links whoever it names. */
  async finish(request: FastifyRequest, reply: FastifyReply): Promise<OidcOutcome> {
    const flow = this.openFlow(request.cookies[FLOW_COOKIE]);
    // Good for one answer only, whichever way it turns out.
    reply.clearCookie(FLOW_COOKIE, { path: FLOW_PATH });
    const query = callbackSchema.safeParse(request.query);
    const mismatch = () => new AppError(400, "This sign-in was not started from this browser, or took too long", "OIDC_FLOW_INVALID");
    if (!flow || !query.success || !crypto.timingSafeEqual(Buffer.from(sha256(query.data.state)), Buffer.from(sha256(flow.state)))) throw mismatch();

    const config = this.enabledConfig();
    const provider = await this.provider(config.issuer);
    // The provider changed while this sign-in was under way, or the answer says it comes from another one.
    if (provider.issuer !== flow.issuer || (query.data.iss !== undefined && query.data.iss !== provider.issuer)) throw mismatch();
    if (query.data.error || !query.data.code) {
      throw new AppError(403, "The identity provider did not sign you in", "OIDC_PROVIDER_REFUSED");
    }

    const attempt = this.attempts.begin([{ key: `oidc:${request.ip ?? ""}`, limit: CALLBACK_TRIES }]);
    const answer = await this.tokenRequest(config, provider, {
      grant_type: "authorization_code",
      code: query.data.code,
      redirect_uri: this.redirectUri(config.publicUrl),
      code_verifier: flow.verifier
    });
    if (answer.status !== 200) {
      logger.warn(`single sign-on: the provider refused the code (${answer.status} ${String(answer.body.error ?? "").slice(0, 80)})`);
      throw new AppError(502, "The identity provider did not complete the sign-in", "OIDC_TOKEN_FAILED");
    }
    const claims = await this.verified(config, provider, answer.body.id_token, flow.nonce);
    const profile = await this.profile(config, provider, claims, answer.body.access_token);
    attempt.succeeded();

    if (flow.link) {
      const actor = this.auth.actorFromRequest(request);
      // Linked only to whoever asked for it, and only while they are still the one signed in here.
      if (!actor || actor.id !== flow.link) throw new AppError(401, "Sign in to Kago again before linking an identity", "OIDC_LINK_SESSION");
      this.link(actor.id, profile);
      return { kind: "link", actor, returnTo: flow.returnTo };
    }

    const { identity, created, merged } = this.resolve(config, profile);
    const user = this.auth.getUser(identity.user_id);
    if (user.disabled) throw new AppError(403, "This account is disabled", "ACCOUNT_DISABLED");
    this.db
      .prepare("UPDATE user_identities SET email = ?, display_name = ?, last_login_at = ? WHERE id = ?")
      .run(profile.email, profile.displayName, now(), identity.id);
    if (config.syncGroups && profile.groups) this.syncGroups(config, user.id, profile.groups);
    const session = this.auth.startSession(request, reply, user);
    const refresh = typeof answer.body.refresh_token === "string" && answer.body.refresh_token ? this.box.seal(answer.body.refresh_token) : null;
    this.db.prepare("UPDATE sessions SET identity_id = ?, oidc_refresh = ?, oidc_checked_at = ? WHERE id = ?").run(identity.id, refresh, now(), session.sessionId);
    return { kind: "login", actor: session.actor, created, merged, returnTo: flow.returnTo };
  }

  identitiesOf(userId: string) {
    return rows<Identity>(this.db.prepare("SELECT * FROM user_identities WHERE user_id = ? ORDER BY created_at ASC").all(userId)).map(publicIdentity);
  }

  /** Every user's identities, by user. */
  identitiesByUser(): Map<string, Array<ReturnType<typeof publicIdentity>>> {
    const byUser = new Map<string, Array<ReturnType<typeof publicIdentity>>>();
    for (const identity of rows<Identity>(this.db.prepare("SELECT * FROM user_identities ORDER BY created_at ASC").all())) {
      byUser.set(identity.user_id, [...(byUser.get(identity.user_id) ?? []), publicIdentity(identity)]);
    }
    return byUser;
  }

  /**
   * Takes an identity off a user, and ends the sessions it began. `keepWayIn` refuses when that would leave the user
   * with no way to sign in; `request` is the session that is doing the unlinking, which is left signed in.
   */
  unlink(userId: string, identityId: string, options: { keepWayIn?: boolean; request?: FastifyRequest } = {}): void {
    const identity = row<Identity>(this.db.prepare("SELECT * FROM user_identities WHERE id = ? AND user_id = ?").get(identityId, userId));
    if (!identity) throw new AppError(404, "Identity not found", "IDENTITY_NOT_FOUND");
    if (options.keepWayIn && !this.auth.hasPassword(userId) && this.identitiesOf(userId).length <= 1) {
      throw new AppError(409, "Set a password first, or there would be no way left to sign in", "OIDC_LAST_SIGN_IN");
    }
    const own = sha256(options.request?.cookies.kago_session ?? "");
    this.db.prepare("DELETE FROM user_identities WHERE id = ?").run(identity.id);
    this.db.prepare("DELETE FROM sessions WHERE identity_id = ? AND token_hash != ?").run(identity.id, own);
    this.db.prepare("UPDATE sessions SET identity_id = NULL, oidc_refresh = NULL WHERE identity_id = ?").run(identity.id);
    this.due.clear();
  }

  private redirectUri(publicUrl: string): string {
    return `${publicUrl}${FLOW_PATH}/callback`;
  }

  private enabledConfig(): OidcConfig {
    const config = this.config();
    if (!config.enabled) throw new AppError(404, "Single sign-on is not set up", "OIDC_DISABLED");
    return config;
  }

  /** What was typed, tidied; and, when single sign-on is being turned on, complete. */
  private checked(input: OidcConfigInput): { issuer: string; publicUrl: string; scopes: string } {
    const scopes = [...new Set(["openid", ...input.scopes.split(/\s+/).filter(Boolean)])];
    if (scopes.some((scope) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) throw new AppError(400, "A scope has a character it may not contain", "OIDC_CONFIG_INVALID");
    // Kago answers at the root of its address, so only the origin of what was typed is kept.
    const publicUrl = isHttpUrl(input.publicUrl) ? new URL(input.publicUrl).origin : "";
    if (input.enabled && (!isHttpUrl(input.issuer) || !input.clientId || !publicUrl)) {
      throw new AppError(400, "The issuer URL, the client ID and Kago’s own address are needed to turn single sign-on on", "OIDC_CONFIG_INCOMPLETE");
    }
    return { issuer: input.issuer, publicUrl, scopes: scopes.join(" ") };
  }

  private async reach(url: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    try {
      return await fetchJson(url, init);
    } catch (error) {
      logger.warn(`single sign-on: ${new URL(url).host} could not be reached`, messageOf(error));
      throw new AppError(502, "Could not reach the identity provider", "OIDC_PROVIDER_UNREACHABLE");
    }
  }

  /** What the provider at `issuer` says about itself, asked for afresh. */
  private async discover(issuer: string): Promise<Provider> {
    const base = withoutTrailingSlash(issuer);
    const found = await this.reach(`${base}/.well-known/openid-configuration`);
    const parsed = providerSchema.safeParse(found.body);
    if (found.status !== 200 || !parsed.success) throw new AppError(502, "That address does not answer as an OpenID Connect provider", "OIDC_DISCOVERY_FAILED");
    // A provider is only believed about itself: one that names another issuer could have its tokens taken for that one's.
    if (withoutTrailingSlash(parsed.data.issuer) !== base) throw new AppError(502, "The provider names a different issuer than the one entered", "OIDC_ISSUER_MISMATCH");
    const methods = parsed.data.code_challenge_methods_supported;
    if (methods && !methods.includes("S256")) throw new AppError(502, "The provider does not support PKCE with S256", "OIDC_PKCE_UNSUPPORTED");
    this.discovered = { issuer, provider: parsed.data, at: Date.now() };
    return parsed.data;
  }

  private async provider(issuer: string): Promise<Provider> {
    const known = this.discovered;
    if (known && known.issuer === issuer && Date.now() - known.at < METADATA_MS) return known.provider;
    const failed = this.unreachable;
    if (failed && failed.issuer === issuer && Date.now() - failed.at < UNREACHABLE_MS) throw failed.error;
    try {
      return await this.discover(issuer);
    } catch (error) {
      this.unreachable = { issuer, error, at: Date.now() };
      throw error;
    }
  }

  private async jwks(provider: Provider, afresh = false): Promise<Jwk[]> {
    const known = this.keys;
    if (known && known.uri === provider.jwks_uri && Date.now() - known.at < (afresh ? KEYS_RETRY_MS : METADATA_MS)) return known.keys;
    const found = await this.reach(provider.jwks_uri);
    const keys = isRecord(found.body) && Array.isArray(found.body.keys) ? (found.body.keys.filter(isRecord) as Jwk[]) : null;
    if (found.status !== 200 || !keys) throw new AppError(502, "Could not reach the identity provider", "OIDC_PROVIDER_UNREACHABLE");
    this.keys = { uri: provider.jwks_uri, keys, at: Date.now() };
    return keys;
  }

  private async verified(config: OidcConfig, provider: Provider, token: unknown, nonce?: string): Promise<IdTokenClaims> {
    const expected = { issuer: provider.issuer, audience: config.clientId, nonce, algorithms: provider.id_token_signing_alg_values_supported };
    try {
      if (typeof token !== "string") throw new TokenError("The provider sent no ID token");
      try {
        return verifyIdToken(token, await this.jwks(provider), expected);
      } catch (error) {
        // The provider may have changed its keys since they were fetched; they are asked for once more.
        if (!(error instanceof UnknownKeyError)) throw error;
        return verifyIdToken(token, await this.jwks(provider, true), expected);
      }
    } catch (error) {
      if (!(error instanceof TokenError)) throw error;
      logger.warn(`single sign-on: ${error.message}`);
      throw new AppError(502, "The identity provider’s answer could not be verified", "OIDC_TOKEN_INVALID");
    }
  }

  private async tokenRequest(config: OidcConfig, provider: Provider, params: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
    const body = new URLSearchParams(params);
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    const secret = config.clientSecret ? this.box.open(config.clientSecret) : "";
    const methods = provider.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
    if (!secret) {
      // A public client: the code verifier is what proves the request comes from whoever began the sign-in.
      body.set("client_id", config.clientId);
    } else if (methods.includes("client_secret_basic") || !methods.includes("client_secret_post")) {
      headers.authorization = `Basic ${Buffer.from(`${formEncode(config.clientId)}:${formEncode(secret)}`).toString("base64")}`;
    } else {
      body.set("client_id", config.clientId);
      body.set("client_secret", secret);
    }
    const answer = await this.reach(provider.token_endpoint, { method: "POST", headers, body: body.toString() });
    return { status: answer.status, body: isRecord(answer.body) ? answer.body : {} };
  }

  /** Who the token names. What it leaves out is asked of the provider's user info, when it has one. */
  private async profile(config: OidcConfig, provider: Provider, claims: IdTokenClaims, accessToken: unknown): Promise<Profile> {
    let known: Record<string, unknown> = claims;
    const lacking = typeof claims.email !== "string" || (typeof claims.name !== "string" && typeof claims.preferred_username !== "string") || (config.syncGroups && claims[config.groupsClaim] === undefined);
    if (lacking && provider.userinfo_endpoint && typeof accessToken === "string") {
      try {
        const info = await fetchJson(provider.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
        // About the same person or not at all; and never over what the signed token already says.
        if (info.status === 200 && isRecord(info.body) && info.body.sub === claims.sub) known = { ...info.body, ...claims };
      } catch (error) {
        logger.warn("single sign-on: the provider's user info could not be read", messageOf(error));
      }
    }
    const email = z.string().email().max(320).safeParse(known.email);
    const name = [known.name, known.preferred_username, email.success ? email.data.split("@")[0] : undefined].find((value): value is string => typeof value === "string" && value.trim().length > 0);
    return {
      issuer: provider.issuer,
      subject: claims.sub,
      email: email.success ? email.data.toLowerCase() : null,
      emailVerified: known.email_verified === true || known.email_verified === "true",
      displayName: (name ?? "User").trim().slice(0, 120),
      groups: groupsOf(known, config.groupsClaim)
    };
  }

  private findIdentity(profile: Profile): Identity | null {
    return row<Identity>(this.db.prepare("SELECT * FROM user_identities WHERE issuer = ? AND subject = ?").get(profile.issuer, profile.subject));
  }

  private insertIdentity(userId: string, profile: Profile): Identity {
    const identity: Identity = { id: id("ident"), user_id: userId, issuer: profile.issuer, subject: profile.subject, email: profile.email, display_name: profile.displayName, created_at: now(), last_login_at: null };
    this.db
      .prepare("INSERT INTO user_identities (id, user_id, issuer, subject, email, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(identity.id, identity.user_id, identity.issuer, identity.subject, identity.email, identity.display_name, identity.created_at, identity.last_login_at);
    return identity;
  }

  private link(userId: string, profile: Profile): void {
    const existing = this.findIdentity(profile);
    if (existing && existing.user_id !== userId) throw new AppError(409, "This identity is already linked to another Kago account", "OIDC_IDENTITY_TAKEN");
    if (!existing) this.insertIdentity(userId, profile);
  }

  /**
   * The Kago account behind an identity. Once linked, it is found by the issuer and subject it was linked under and
   * by nothing else. An identity seen for the first time is linked to the account that has its email address, but
   * only when the provider says it has verified the address: one that people may type in themselves would let
   * anyone walk into another's account by claiming their email.
   */
  private resolve(config: OidcConfig, profile: Profile): { identity: Identity; created: boolean; merged: boolean } {
    const existing = this.findIdentity(profile);
    if (existing) return { identity: existing, created: false, merged: false };
    const account = profile.email ? this.auth.findUserByEmail(profile.email) : null;
    if (account) {
      if (!profile.emailVerified) throw new AppError(403, "A Kago account has this email, but the provider does not say the address is verified; sign in to the account and link the identity from Settings", "OIDC_EMAIL_UNVERIFIED");
      if (account.disabled) throw new AppError(403, "This account is disabled", "ACCOUNT_DISABLED");
      return { identity: this.insertIdentity(account.id, profile), created: false, merged: true };
    }
    if (!config.autoCreate) throw new AppError(403, "No Kago account is linked to this identity yet", "OIDC_NOT_LINKED");
    if (!profile.email) throw new AppError(403, "The identity provider did not share an email address", "OIDC_EMAIL_MISSING");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const user = this.auth.createExternalUser({ email: profile.email, displayName: profile.displayName });
      const identity = this.insertIdentity(user.id, profile);
      this.db.exec("COMMIT");
      return { identity, created: true, merged: false };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Brings a user's membership of the mapped groups in line with the provider's. Only memberships that came from the
   * provider are taken away again; one an administrator gave by hand stays. Returns whether anything changed.
   */
  private syncGroups(config: OidcConfig, userId: string, held: string[]): boolean {
    const existing = new Set(rows<{ id: string }>(this.db.prepare("SELECT id FROM groups").all()).map((group) => group.id));
    let changed = 0;
    for (const groupId of new Set(config.groupMappings.map((mapping) => mapping.groupId))) {
      if (!existing.has(groupId)) continue;
      const wanted = config.groupMappings.some((mapping) => mapping.groupId === groupId && held.includes(mapping.external));
      changed += Number(
        (wanted
          ? this.db.prepare("INSERT OR IGNORE INTO group_members (group_id, user_id, role, source) VALUES (?, ?, 'MEMBER', 'oidc')")
          : this.db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ? AND source = 'oidc'")
        ).run(groupId, userId).changes
      );
    }
    return changed > 0;
  }

  private openFlow(sealed: string | undefined): Flow | null {
    if (!sealed) return null;
    try {
      const flow = flowSchema.parse(JSON.parse(this.box.open(sealed)));
      return flow.expires > now() ? flow : null;
    } catch {
      return null;
    }
  }

  /** A session made a request. When it came with a refresh token and has not been checked for a while, the provider is asked about it. */
  private seen(tokenHash: string): void {
    const ts = now();
    if ((this.due.get(tokenHash) ?? 0) > ts) return;
    if (this.due.size >= MAX_WATCHED) this.due.clear();
    const session = row<WatchedSession>(this.db.prepare("SELECT id, user_id, identity_id, oidc_refresh, oidc_checked_at FROM sessions WHERE token_hash = ?").get(tokenHash));
    const config = this.config();
    if (!session?.oidc_refresh || !session.identity_id || !config.enabled) {
      this.due.set(tokenHash, ts + REVALIDATE_SECONDS);
      return;
    }
    const next = (session.oidc_checked_at ?? 0) + REVALIDATE_SECONDS;
    if (next > ts) {
      this.due.set(tokenHash, next);
      return;
    }
    // Also what keeps a second request from asking while the first is still waiting for its answer.
    this.due.set(tokenHash, ts + RETRY_SECONDS);
    void this.revalidate(config, session as WatchedSession & { identity_id: string; oidc_refresh: string }).catch((error) => logger.warn("single sign-on: a session could not be checked with the provider", messageOf(error)));
  }

  /**
   * Trades a session's refresh token for a new one. A provider that turns it down has ended the sign-in on its side
   * (the account was removed, or its access taken away) and the session ends here too; a provider that cannot be
   * reached leaves it as it was. The groups it reports are applied as at sign-in.
   */
  private async revalidate(config: OidcConfig, session: WatchedSession & { identity_id: string; oidc_refresh: string }): Promise<void> {
    const identity = row<Identity>(this.db.prepare("SELECT * FROM user_identities WHERE id = ?").get(session.identity_id));
    const provider = await this.provider(config.issuer);
    // Signed in through a provider that is no longer the one in use: there is nobody left to ask.
    if (!identity || identity.issuer !== provider.issuer) {
      this.db.prepare("UPDATE sessions SET oidc_refresh = NULL WHERE id = ?").run(session.id);
      return;
    }
    const answer = await this.tokenRequest(config, provider, { grant_type: "refresh_token", refresh_token: this.box.open(session.oidc_refresh) });
    const revoke = (reason: string) => {
      this.db.prepare("DELETE FROM sessions WHERE id = ?").run(session.id);
      this.audit.write({ actorType: "system", action: "session_revoked", target: { userId: session.user_id, reason }, result: "success" });
    };
    if (answer.status === 200 && typeof answer.body.access_token === "string") {
      // Providers that rotate refresh tokens send the next one along; the old one is spent.
      const refresh = typeof answer.body.refresh_token === "string" && answer.body.refresh_token ? this.box.seal(answer.body.refresh_token) : session.oidc_refresh;
      this.db.prepare("UPDATE sessions SET oidc_refresh = ?, oidc_checked_at = ? WHERE id = ?").run(refresh, now(), session.id);
      if (typeof answer.body.id_token !== "string") return;
      const claims = await this.verified(config, provider, answer.body.id_token);
      if (claims.sub !== identity.subject) return revoke("subject_changed");
      const groups = config.syncGroups ? (await this.profile(config, provider, claims, answer.body.access_token)).groups : null;
      if (groups && this.syncGroups(config, session.user_id, groups)) this.events.publish({ type: "permission.updated", userId: session.user_id });
      return;
    }
    if (answer.status >= 400 && answer.status < 500 && answer.body.error === "invalid_grant") revoke("provider_refused");
  }
}

type WatchedSession = { id: string; user_id: string; identity_id: string | null; oidc_refresh: string | null; oidc_checked_at: number | null };

function publicIdentity(identity: Identity) {
  return {
    id: identity.id,
    issuer: identity.issuer,
    subject: identity.subject,
    email: identity.email,
    displayName: identity.display_name,
    createdAt: identity.created_at,
    lastLoginAt: identity.last_login_at
  };
}
