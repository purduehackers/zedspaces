import { jwtVerify, SignJWT, type JWTPayload } from "jose";
import { infraPorts } from "./env";
import { newJti, timingSafeEqualString } from "./ids";
import { keyResolver, loadSigningKeys, mapJoseError, TokenError, type SigningKeys } from "./tokens";

/** Maximum bootstrap-token age b8's verifier accepts (`BOOTSTRAP_MAX_AGE_SECS`). */
export const PORT_BOOTSTRAP_TTL_SECS = 600;
/** Query parameter carrying the bootstrap token on `/__zs/auth` (D8; b8 `BOOTSTRAP_PARAM`). */
export const PORT_BOOTSTRAP_PARAM = "zs_port_token";

/**
 * `${audience}/ports`: the audience of private-port bootstrap tokens. It
 * differs from the RPC audience so that b2's `/rpc` verifier and
 * `verifySessionToken` reject a bootstrap token; the manifest emits it as
 * `jwt.portAudience`.
 */
export function portAudience(audience: string): string {
  return `${audience}/ports`;
}

/** Claims of a bootstrap token (b8 `BootstrapClaims`). */
export interface PortBootstrapClaims {
  iss: string;
  sub: string;
  ws: string;
  sid: `port:${number}`;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

/** Inputs of {@link mintPortBootstrapToken}. */
export interface PortBootstrapInput {
  userId: string;
  workspaceId: string;
  /** The workspace's RPC audience; the token carries `portAudience(audience)`. */
  audience: string;
  port: number;
}

/**
 * Mints the 10-minute ES256 bootstrap token the `/open` route redirects with
 * (`sid = "port:<port>"`, `aud = <audience>/ports`), signed with the session
 * key so b8 verifies it with `manifest.jwt.publicKeys`.
 */
export async function mintPortBootstrapToken(
  input: PortBootstrapInput,
  keys?: SigningKeys,
): Promise<{ token: string; jti: string; expiresAt: Date }> {
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535 || infraPorts().includes(input.port)) {
    throw new TokenError("port", `port ${input.port} cannot be forwarded`);
  }
  const signing = keys ?? (await loadSigningKeys());
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + PORT_BOOTSTRAP_TTL_SECS;
  const jti = newJti();
  const token = await new SignJWT({ ws: input.workspaceId, sid: `port:${input.port}` })
    .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: signing.active.kid })
    .setIssuer(signing.issuer)
    .setSubject(input.userId)
    .setAudience(portAudience(input.audience))
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(jti)
    .sign(signing.active.privateKey);
  return { token, jti, expiresAt: new Date(exp * 1000) };
}

const REQUIRED_CLAIMS = ["exp", "aud", "iss", "sub", "ws", "sid", "jti", "iat"];

/**
 * Mirrors b8's `BootstrapVerifier` (tests only): audience
 * `portAudience(expect.audience)`, ES256, 30 s leeway, required claims, `ws`
 * match, `sid` of the form `port:<n>` with `n` a forwardable port, and
 * `exp - iat <= 600`.
 */
export async function verifyPortBootstrapToken(
  token: string,
  expect: { audience: string; workspaceId: string },
  keys?: SigningKeys,
): Promise<{ port: number; claims: PortBootstrapClaims }> {
  const signing = keys ?? (await loadSigningKeys());
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, keyResolver(signing), {
      issuer: signing.issuer,
      audience: portAudience(expect.audience),
      algorithms: ["ES256"],
      clockTolerance: 30,
      requiredClaims: REQUIRED_CLAIMS,
    }));
  } catch (err) {
    throw mapJoseError(err);
  }
  const { iss, sub, aud, iat, exp, jti } = payload;
  const ws = payload.ws;
  const sid = payload.sid;
  const audience = Array.isArray(aud) ? aud[0] : aud;
  if (
    typeof iss !== "string" ||
    typeof sub !== "string" ||
    typeof ws !== "string" ||
    typeof sid !== "string" ||
    typeof jti !== "string" ||
    typeof audience !== "string" ||
    typeof iat !== "number" ||
    typeof exp !== "number"
  ) {
    throw new TokenError("malformed", "claims have unexpected types");
  }
  if (exp - iat > PORT_BOOTSTRAP_TTL_SECS) throw new TokenError("expired", "bootstrap token lifetime exceeds 600 s");
  if (!timingSafeEqualString(ws, expect.workspaceId)) throw new TokenError("workspace", "token is for another workspace");
  const match = /^port:(\d{1,5})$/.exec(sid);
  const port = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || infraPorts().includes(port)) {
    throw new TokenError("port", "sid does not name a forwardable port");
  }
  return { port, claims: { iss, sub, ws, sid: `port:${port}`, aud: audience, iat, exp, jti } };
}
