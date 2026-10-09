import crypto from "node:crypto";

/** A key as an identity provider publishes it. */
export type Jwk = { kty?: string; kid?: string; use?: string; alg?: string; crv?: string; [name: string]: unknown };

/** What a verified ID token says about who signed in. */
export type IdTokenClaims = Record<string, unknown> & { iss: string; sub: string };

export class TokenError extends Error {}

/** None of the keys at hand is the one the token was signed with; the provider may have changed them since they were fetched. */
export class UnknownKeyError extends TokenError {}

type Scheme = { kty: "RSA" | "EC" | "OKP"; hash: string | null; crv?: string; pss?: boolean };

/**
 * The ways a provider may sign a token. Each needs a private key only the provider holds: `none`, and the HMAC family
 * where whoever can check a signature can also make one, are not here to be asked for.
 */
const schemes: Record<string, Scheme> = {
  RS256: { kty: "RSA", hash: "sha256" },
  RS384: { kty: "RSA", hash: "sha384" },
  RS512: { kty: "RSA", hash: "sha512" },
  PS256: { kty: "RSA", hash: "sha256", pss: true },
  PS384: { kty: "RSA", hash: "sha384", pss: true },
  PS512: { kty: "RSA", hash: "sha512", pss: true },
  ES256: { kty: "EC", hash: "sha256", crv: "P-256" },
  ES384: { kty: "EC", hash: "sha384", crv: "P-384" },
  ES512: { kty: "EC", hash: "sha512", crv: "P-521" },
  EdDSA: { kty: "OKP", hash: null, crv: "Ed25519" }
};

export const signingAlgorithms = Object.keys(schemes);

const keyTypes: Record<Scheme["kty"], string> = { RSA: "rsa", EC: "ec", OKP: "ed25519" };

/** A token with a great many groups in it is still far smaller than this. */
const MAX_TOKEN = 64 * 1024;
/** How far the provider's clock and this one may disagree, in seconds. */
const CLOCK_SKEW = 60;
/** With no key named in the token, each published key of the right kind is tried, up to this many. */
const MAX_KEYS_TRIED = 8;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function decodePart(part: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(part)) throw new TokenError("ID token is malformed");
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
  } catch {
    throw new TokenError("ID token is malformed");
  }
  if (!isRecord(value)) throw new TokenError("ID token is malformed");
  return value;
}

function signedBy(scheme: Scheme, jwk: Jwk, data: Buffer, signature: Buffer): boolean {
  try {
    const key = crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
    if (key.asymmetricKeyType !== keyTypes[scheme.kty]) return false;
    if (scheme.kty === "RSA") {
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) return false;
      const padded = scheme.pss ? { key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : key;
      return crypto.verify(scheme.hash, data, padded, signature);
    }
    // A JWT carries an ECDSA signature as the two numbers side by side, not in the DER wrapping OpenSSL expects.
    if (scheme.kty === "EC") return crypto.verify(scheme.hash, data, { key, dsaEncoding: "ieee-p1363" }, signature);
    return crypto.verify(null, data, key, signature);
  } catch {
    return false;
  }
}

/**
 * Checks that `token` was signed by one of the provider's `keys` and was issued by that provider, for this client,
 * for the sign-in that carried `nonce`, and has not run out. Returns what it claims, or throws a `TokenError`.
 */
export function verifyIdToken(
  token: string,
  keys: Jwk[],
  expected: { issuer: string; audience: string; nonce?: string; algorithms?: string[]; now?: number }
): IdTokenClaims {
  const parts = token.split(".");
  if (token.length > MAX_TOKEN || parts.length !== 3) throw new TokenError("ID token is malformed");
  const [head, body, tail] = parts as [string, string, string];
  const header = decodePart(head);
  const alg = typeof header.alg === "string" ? header.alg : "";
  const scheme = Object.hasOwn(schemes, alg) ? schemes[alg] : undefined;
  if (!scheme || (expected.algorithms && !expected.algorithms.includes(alg))) throw new TokenError(`ID token is signed with an algorithm that is not accepted (${alg.slice(0, 16) || "none"})`);
  // An extension the token says must be understood, and that nothing here understands.
  if (header.crit !== undefined) throw new TokenError("ID token carries an unknown critical header");
  if (!/^[A-Za-z0-9_-]+$/.test(tail)) throw new TokenError("ID token is malformed");

  const kid = typeof header.kid === "string" ? header.kid : undefined;
  const candidates = keys.filter(
    (key) =>
      isRecord(key) &&
      key.kty === scheme.kty &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === alg) &&
      (scheme.crv === undefined || key.crv === scheme.crv) &&
      (kid === undefined || key.kid === kid)
  );
  if (candidates.length === 0) throw new UnknownKeyError("ID token is signed with a key the provider does not publish");
  const data = Buffer.from(`${head}.${body}`, "ascii");
  const signature = Buffer.from(tail, "base64url");
  if (!candidates.slice(0, MAX_KEYS_TRIED).some((key) => signedBy(scheme, key, data, signature))) {
    // A token that names no key may simply have been signed with one newer than those fetched.
    throw new (kid === undefined ? UnknownKeyError : TokenError)("ID token signature does not match");
  }

  const claims = decodePart(body);
  const now = expected.now ?? Date.now() / 1000;
  if (claims.iss !== expected.issuer) throw new TokenError("ID token was issued by someone else");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(expected.audience)) throw new TokenError("ID token was issued for another client");
  // A token good for several clients has to say which one asked for it.
  if (audience.length > 1 ? claims.azp !== expected.audience : claims.azp !== undefined && claims.azp !== expected.audience) throw new TokenError("ID token was issued for another client");
  if (typeof claims.exp !== "number" || claims.exp <= now - CLOCK_SKEW) throw new TokenError("ID token has expired");
  if (typeof claims.iat !== "number" || claims.iat > now + CLOCK_SKEW) throw new TokenError("ID token is dated in the future");
  if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now + CLOCK_SKEW)) throw new TokenError("ID token is not valid yet");
  if (expected.nonce !== undefined && claims.nonce !== expected.nonce) throw new TokenError("ID token belongs to another sign-in");
  if (typeof claims.sub !== "string" || claims.sub.length === 0 || claims.sub.length > 255) throw new TokenError("ID token does not say who signed in");
  return claims as IdTokenClaims;
}
