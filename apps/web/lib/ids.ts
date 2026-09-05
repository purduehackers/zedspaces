import { createHash, timingSafeEqual } from "node:crypto";

/** Prefixes of the ids the control plane mints. */
export type IdPrefix = "ws" | "sb" | "ses" | "con" | "repo";

/** Crockford base32 alphabet (no I, L, O, U); matches `[0-9A-HJKMNP-TV-Z]`. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Regular expression a workspace id must match (`ws_` + 20 Crockford base32 chars). */
export const WORKSPACE_ID_RE = /^ws_[0-9A-HJKMNP-TV-Z]{20}$/;
/** Regular expression a repo id must match. */
export const REPO_ID_RE = /^repo_[0-9A-HJKMNP-TV-Z]{20}$/;

/** Workspace sandbox names. */
export const SANDBOX_NAME_RE = /^sb-[a-z0-9-]{1,60}$/;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

/** `${prefix}_` followed by 20 Crockford base32 characters from a CSPRNG. */
export function newId(prefix: IdPrefix): string {
  const bytes = randomBytes(20);
  let body = "";
  // 256 % 32 === 0, so masking a byte to five bits is unbiased.
  for (const byte of bytes) body += CROCKFORD[byte & 31];
  return `${prefix}_${body}`;
}

/**
 * The per-connect session id (D1): the JWT `sid`, `ConnectInfo.sessionId` and
 * `Hello.session_id`. Fresh on every successful `/connect`, never a
 * persistence key.
 */
export function newConnectId(): string {
  return newId("con");
}

/** 22-character base64url JWT id (16 random bytes). */
export function newJti(): string {
  return base64url(randomBytes(16));
}

function envShort(): "prod" | "prev" | "dev" {
  switch (process.env.VERCEL_ENV) {
    case "production":
      return "prod";
    case "preview":
      return "prev";
    default:
      return "dev";
  }
}

/**
 * Immutable sandbox name for a workspace generation:
 * `sb-<env>-<workspace id body>-g<generation>`. The env segment keeps preview
 * and production sandboxes apart when they share a Vercel project.
 */
export function newSandboxName(workspaceId: string, generation: number): string {
  return `sb-${envShort()}-${workspaceId.slice(3).toLowerCase()}-g${generation}`;
}

/**
 * A fresh sandbox identity token (`zsb_` + base64url of 32 random bytes) and
 * the sha256 hex the database stores. The plaintext is returned exactly once.
 */
export function newSandboxToken(): { token: string; hash: string } {
  const token = `zsb_${base64url(randomBytes(32))}`;
  return { token, hash: sha256Hex(token) };
}

/** Lowercase hex sha256 of a UTF-8 string. */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two hex digests. Returns `false` (without
 * leaking timing on the contents) when the lengths differ or either input is
 * not hex.
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Constant-time comparison of two strings of arbitrary content. */
export function timingSafeEqualString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
