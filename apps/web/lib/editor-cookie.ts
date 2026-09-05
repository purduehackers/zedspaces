import { jwtVerify, SignJWT } from "jose";
import { env } from "./env";
import { newJti, timingSafeEqualString } from "./ids";
import { TokenError } from "./tokens";

/** Name of the first-party editor session cookie. */
export const EDITOR_COOKIE = "zs_editor";
/** Audience of the editor cookie's JWT. */
export const EDITOR_COOKIE_AUDIENCE = "zs-editor";
/** Lifetime of one editor cookie: 12 h. */
export const EDITOR_COOKIE_TTL_SECS = 12 * 3600;
/**
 * Absolute lifetime of a cookie lineage: a cookie may re-mint itself
 * (`POST /api/workspaces/{id}/session`) for at most 24 h after the editor
 * document minted the first one; after that the public page reloads and
 * mints a new lineage. No external identity provider is involved.
 */
export const EDITOR_COOKIE_MAX_LIFETIME_SECS = 24 * 3600;

/** Claims carried by the editor cookie. */
export interface EditorClaims {
  sub: string;
  ws: string;
  aud: "zs-editor";
  iat: number;
  exp: number;
  jti: string;
  /** Origin `iat`: when the editor document started this lineage; renewals carry it forward. */
  oi: number;
  /** The user's `users.auth_epoch` at mint time; a bumped epoch invalidates the cookie. */
  ep: number;
}

/** The minimal cookie jar surface: `cookies()` from `next/headers` and `NextRequest.cookies` both satisfy it. */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** Attributes for `res.cookies.set(EDITOR_COOKIE, value, attrs)`. */
export interface EditorCookieAttributes {
  httpOnly: true;
  secure: boolean;
  sameSite: "strict";
  path: string;
  expires: Date;
}

function secretKey(): Uint8Array {
  const raw = env().ZS_EDITOR_COOKIE_SECRET;
  if (!raw) throw new TokenError("config", "ZS_EDITOR_COOKIE_SECRET is not set");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new TokenError("config", "ZS_EDITOR_COOKIE_SECRET must be 32 bytes of base64");
  return new Uint8Array(key);
}

/** Options of {@link mintEditorCookie}. */
export interface MintEditorCookieOptions {
  /** `users.auth_epoch` of the user; defaults to 0 (a user row that does not exist yet). */
  epoch?: number;
  /** Origin `iat` carried over from the cookie being renewed; defaults to now (a fresh document). */
  originIat?: number;
}

/**
 * Mints the HS256 cookie value for `userId` on `workspaceId` (`exp` +12 h,
 * capped so the lineage never outlives {@link EDITOR_COOKIE_MAX_LIFETIME_SECS}
 * after `originIat`). The cookie binds the internal principal and workspace;
 * it is not an end-user login credential.
 */
export async function mintEditorCookie(
  userId: string,
  workspaceId: string,
  opts?: MintEditorCookieOptions,
): Promise<{ value: string; expires: Date }> {
  const iat = Math.floor(Date.now() / 1000);
  const originIat = opts?.originIat ?? iat;
  const lineageEnd = originIat + EDITOR_COOKIE_MAX_LIFETIME_SECS;
  if (lineageEnd <= iat) throw new TokenError("expired", "The editor session's absolute lifetime has elapsed");
  const exp = Math.min(iat + EDITOR_COOKIE_TTL_SECS, lineageEnd);
  const value = await new SignJWT({ ws: workspaceId, oi: originIat, ep: opts?.epoch ?? 0 })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setSubject(userId)
    .setAudience(EDITOR_COOKIE_AUDIENCE)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(newJti())
    .sign(secretKey());
  return { value, expires: new Date(exp * 1000) };
}

/**
 * Verifies the editor cookie in `jar` for `workspaceId`. Returns the claims,
 * or `null` when the cookie is absent, expired, past its lineage's absolute
 * lifetime, signed otherwise, or for another workspace. Never throws for a
 * bad cookie. The epoch claim is returned for the caller to compare with
 * `users.auth_epoch`.
 */
export async function verifyEditorCookie(jar: CookieReader, workspaceId: string): Promise<EditorClaims | null> {
  const value = jar.get(EDITOR_COOKIE)?.value;
  if (!value) return null;
  try {
    const { payload } = await jwtVerify(value, secretKey(), {
      algorithms: ["HS256"],
      audience: EDITOR_COOKIE_AUDIENCE,
      clockTolerance: 30,
      requiredClaims: ["sub", "ws", "aud", "iat", "exp", "jti", "oi", "ep"],
    });
    const ws = payload.ws;
    const oi = payload.oi;
    const ep = payload.ep;
    if (
      typeof ws !== "string" ||
      typeof payload.sub !== "string" ||
      typeof payload.iat !== "number" ||
      typeof payload.exp !== "number" ||
      typeof payload.jti !== "string" ||
      typeof oi !== "number" ||
      typeof ep !== "number"
    ) {
      return null;
    }
    if (!timingSafeEqualString(ws, workspaceId)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (oi > payload.iat + 30 || now - oi > EDITOR_COOKIE_MAX_LIFETIME_SECS) return null;
    return { sub: payload.sub, ws, aud: "zs-editor", iat: payload.iat, exp: payload.exp, jti: payload.jti, oi, ep };
  } catch (err) {
    if (err instanceof TokenError) throw err; // configuration errors must surface
    return null;
  }
}

/** `HttpOnly; Secure (not in dev); SameSite=Strict; Path=/api/workspaces/<id>; Expires`. */
export function editorCookieAttributes(workspaceId: string, expires: Date): EditorCookieAttributes {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV !== "development",
    sameSite: "strict",
    path: `/api/workspaces/${workspaceId}`,
    expires,
  };
}
