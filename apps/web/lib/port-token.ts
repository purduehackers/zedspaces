import { SignJWT } from "jose";
import { infraPorts } from "./env";
import { newJti } from "./ids";
import { loadSigningKeys, TokenError, type SigningKeys } from "./tokens";

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
