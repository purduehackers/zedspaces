import { createPublicKey } from "node:crypto";
import {
  errors as joseErrors,
  importPKCS8,
  importSPKI,
  jwtVerify,
  SignJWT,
  type CryptoKey,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { env, type Env } from "./env";
import { newJti, timingSafeEqualString } from "./ids";

/** Claims of a session token (CONTRACTS.md §6.1). */
export interface SessionClaims extends JWTPayload {
  iss: string;
  sub: string;
  /** Workspace id `ws_…` – the stable identity b2 compares with `--workspace-id` (D1). */
  ws: string;
  /** Per-connect id `con_…` – informational (D1). */
  sid: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

/** The active signing key, the previous public key during rotation, and the issuer. */
export interface SigningKeys {
  active: { kid: string; privateKey: CryptoKey; publicKey: CryptoKey; publicSpkiPem: string };
  previous?: { kid: string; publicKey: CryptoKey; publicSpkiPem: string };
  issuer: string;
}

/** Failure codes of {@link verifySessionToken} and the port-token verifier. */
export type TokenErrorCode =
  | "audience"
  | "issuer"
  | "workspace"
  | "expired"
  | "not_yet_valid"
  | "signature"
  | "algorithm"
  | "malformed"
  | "missing_claim"
  | "unknown_kid"
  | "port"
  | "config";

/** Thrown by the token functions. The message never contains the token. */
export class TokenError extends Error {
  constructor(
    public readonly code: TokenErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TokenError";
  }
}

/** Default and maximum session-token lifetime in seconds (BUILD-SPEC §4.3). */
export const SESSION_TOKEN_TTL_SECS = 3600;

/**
 * Normalizes a PEM that arrived through an environment variable (`\n`
 * escapes, stray whitespace). The result has no trailing newline, matching
 * jose's `exportSPKI`/`exportPKCS8` output.
 */
export function normalizePem(raw: string): string {
  return raw.replace(/\\n/g, "\n").trim();
}

/** SPKI PEM (no trailing newline) of the public half of a PKCS#8 private key PEM. */
export function publicSpkiPemOf(privatePkcs8Pem: string): string {
  return createPublicKey(privatePkcs8Pem).export({ type: "spki", format: "pem" }).toString().trim();
}

let cache: { fingerprint: string; keys: Promise<SigningKeys> } | null = null;

/**
 * Loads `ZS_JWT_PRIVATE_KEY` (PKCS#8, P-256) as the active key, derives its
 * SPKI PEM, and `ZS_JWT_PREVIOUS_PUBLIC_KEY`/`_KID` when set. Memoized on the
 * variable values, so a changed environment (tests, rotation) reloads.
 */
export function loadSigningKeys(e: Env = env()): Promise<SigningKeys> {
  const fingerprint = JSON.stringify([
    e.ZS_JWT_PRIVATE_KEY,
    e.ZS_JWT_KID,
    e.ZS_JWT_PREVIOUS_PUBLIC_KEY,
    e.ZS_JWT_PREVIOUS_KID,
    e.ZS_JWT_ISSUER,
  ]);
  if (cache && cache.fingerprint === fingerprint) return cache.keys;
  const keys = (async (): Promise<SigningKeys> => {
    if (!e.ZS_JWT_PRIVATE_KEY) throw new TokenError("config", "ZS_JWT_PRIVATE_KEY is not set");
    const privatePem = normalizePem(e.ZS_JWT_PRIVATE_KEY);
    let privateKey: CryptoKey;
    let publicSpkiPem: string;
    try {
      privateKey = await importPKCS8(privatePem, "ES256");
      publicSpkiPem = publicSpkiPemOf(privatePem);
    } catch {
      throw new TokenError("config", "ZS_JWT_PRIVATE_KEY is not a PKCS#8 P-256 private key");
    }
    const publicKey = await importSPKI(publicSpkiPem, "ES256");
    const result: SigningKeys = {
      active: { kid: e.ZS_JWT_KID, privateKey, publicKey, publicSpkiPem },
      issuer: e.ZS_JWT_ISSUER,
    };
    if (e.ZS_JWT_PREVIOUS_PUBLIC_KEY) {
      if (!e.ZS_JWT_PREVIOUS_KID) throw new TokenError("config", "ZS_JWT_PREVIOUS_KID is required with ZS_JWT_PREVIOUS_PUBLIC_KEY");
      const previousPem = normalizePem(e.ZS_JWT_PREVIOUS_PUBLIC_KEY);
      let previousKey: CryptoKey;
      try {
        previousKey = await importSPKI(previousPem, "ES256");
      } catch {
        throw new TokenError("config", "ZS_JWT_PREVIOUS_PUBLIC_KEY is not an SPKI P-256 public key");
      }
      result.previous = { kid: e.ZS_JWT_PREVIOUS_KID, publicKey: previousKey, publicSpkiPem: previousPem };
    }
    return result;
  })();
  cache = { fingerprint, keys };
  keys.catch(() => {
    cache = null;
  });
  return keys;
}

/** Drops the memoized keys. Tests only. */
export function _resetSigningKeysForTests(): void {
  cache = null;
}

/** SPKI PEMs, active first then previous – the manifest's `jwt.publicKeys`. */
export function publicKeyPems(keys: SigningKeys): string[] {
  const pems = [keys.active.publicSpkiPem];
  if (keys.previous) pems.push(keys.previous.publicSpkiPem);
  return pems;
}

/** Inputs of {@link mintSessionToken}. */
export interface MintInput {
  userId: string;
  workspaceId: string;
  /** The per-connect `con_…` id (D1). */
  sessionId: string;
  audience: string;
  /** Default and maximum 3600. */
  ttlSeconds?: number;
}

/** The minted token and its metadata. */
export interface MintedToken {
  token: string;
  jti: string;
  expiresAt: Date;
  kid: string;
}

/**
 * Mints an ES256 session token: header `{ alg, typ: "JWT", kid }`, claims
 * `{ iss, sub: userId, ws: workspaceId, sid: sessionId, aud, iat, exp, jti }`.
 * `ttlSeconds` is clamped to `[1, 3600]`.
 */
export async function mintSessionToken(input: MintInput, keys?: SigningKeys): Promise<MintedToken> {
  const signing = keys ?? (await loadSigningKeys());
  const ttl = Math.min(SESSION_TOKEN_TTL_SECS, Math.max(1, Math.trunc(input.ttlSeconds ?? SESSION_TOKEN_TTL_SECS)));
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + ttl;
  const jti = newJti();
  const token = await new SignJWT({ ws: input.workspaceId, sid: input.sessionId })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: signing.active.kid })
    .setIssuer(signing.issuer)
    .setSubject(input.userId)
    .setAudience(input.audience)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(signing.active.privateKey);
  return { token, jti, expiresAt: new Date(exp * 1000), kid: signing.active.kid };
}

/** Resolves the verification key by `kid`: active, previous, or `unknown_kid`. A missing kid tries the active key. */
export function keyResolver(keys: SigningKeys): JWTVerifyGetKey {
  return async (header) => {
    if (header.kid === undefined || header.kid === keys.active.kid) return keys.active.publicKey;
    if (keys.previous && header.kid === keys.previous.kid) return keys.previous.publicKey;
    throw new TokenError("unknown_kid", "token signed with an unknown key id");
  };
}

/** Maps a jose failure onto a {@link TokenError} without echoing the token. */
export function mapJoseError(err: unknown): TokenError {
  if (err instanceof TokenError) return err;
  if (err instanceof joseErrors.JWTExpired) return new TokenError("expired", "token expired");
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    if (err.reason === "missing") return new TokenError("missing_claim", `missing claim ${err.claim}`);
    switch (err.claim) {
      case "aud":
        return new TokenError("audience", "unexpected audience");
      case "iss":
        return new TokenError("issuer", "unexpected issuer");
      case "nbf":
        return new TokenError("not_yet_valid", "token not yet valid");
      case "iat":
        return new TokenError("not_yet_valid", "token issued in the future");
      default:
        return new TokenError("malformed", `claim ${err.claim} failed validation`);
    }
  }
  if (err instanceof joseErrors.JOSEAlgNotAllowed || err instanceof joseErrors.JOSENotSupported) {
    return new TokenError("algorithm", "algorithm not allowed");
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) return new TokenError("signature", "bad signature");
  if (err instanceof joseErrors.JOSEError) return new TokenError("malformed", "malformed token");
  return new TokenError("malformed", "malformed token");
}

const REQUIRED_SESSION_CLAIMS = ["exp", "aud", "iss", "sub", "ws", "sid", "jti", "iat"];

/**
 * Verifies a session token the way b2's `/rpc` does: ES256 only, issuer and
 * audience must match, 30 s clock tolerance, every claim of
 * {@link SessionClaims} present, and `ws` compared in constant time. Used by
 * tests and by control-plane routes that accept a session token.
 */
export async function verifySessionToken(
  token: string,
  expect: { audience: string; workspaceId: string },
  keys?: SigningKeys,
): Promise<SessionClaims> {
  const signing = keys ?? (await loadSigningKeys());
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keyResolver(signing), {
      issuer: signing.issuer,
      audience: expect.audience,
      algorithms: ["ES256"],
      clockTolerance: 30,
      requiredClaims: REQUIRED_SESSION_CLAIMS,
    }));
  } catch (err) {
    throw mapJoseError(err);
  }
  const claims = asSessionClaims(payload);
  if (!timingSafeEqualString(claims.ws, expect.workspaceId)) {
    throw new TokenError("workspace", "token is for another workspace");
  }
  return claims;
}

/** Narrows a verified payload to {@link SessionClaims}, rejecting wrongly typed claims. */
export function asSessionClaims(payload: JWTPayload): SessionClaims {
  const { iss, sub, aud, iat, exp, jti } = payload;
  const ws = payload.ws;
  const sid = payload.sid;
  if (
    typeof iss !== "string" ||
    typeof sub !== "string" ||
    typeof ws !== "string" ||
    typeof sid !== "string" ||
    typeof jti !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number"
  ) {
    throw new TokenError("malformed", "claims have unexpected types");
  }
  const audience = Array.isArray(aud) ? aud[0] : aud;
  if (typeof audience !== "string") throw new TokenError("malformed", "aud must be a string");
  return { ...payload, iss, sub, ws, sid, aud: audience, iat, exp, jti };
}
