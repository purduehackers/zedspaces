import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  EDITOR_COOKIE,
  EDITOR_COOKIE_MAX_LIFETIME_SECS,
  EDITOR_COOKIE_TTL_SECS,
  editorCookieAttributes,
  mintEditorCookie,
  verifyEditorCookie,
} from "@/lib/editor-cookie";
import { newId } from "@/lib/ids";
import { loadSigningKeys } from "@/lib/tokens";

function jar(value: string | undefined) {
  return { get: (name: string) => (name === EDITOR_COOKIE && value !== undefined ? { value } : undefined) };
}

describe("editor cookie", () => {
  it("editor_cookie", async () => {
    const workspaceId = newId("ws");
    const minted = await mintEditorCookie("user_test", workspaceId);

    expect(decodeProtectedHeader(minted.value).alg).toBe("HS256");
    const payload = decodeJwt(minted.value);
    expect(payload.aud).toBe("zs-editor");
    expect((payload.exp as number) - (payload.iat as number)).toBe(EDITOR_COOKIE_TTL_SECS);
    expect(minted.expires.getTime()).toBe((payload.exp as number) * 1000);

    const claims = await verifyEditorCookie(jar(minted.value), workspaceId);
    expect(claims?.sub).toBe("user_test");
    expect(claims?.ws).toBe(workspaceId);

    // Other workspace, absent cookie, garbage.
    expect(await verifyEditorCookie(jar(minted.value), newId("ws"))).toBeNull();
    expect(await verifyEditorCookie(jar(undefined), workspaceId)).toBeNull();
    expect(await verifyEditorCookie(jar("not-a-jwt"), workspaceId)).toBeNull();

    // Expired.
    const secret = new Uint8Array(Buffer.from(process.env.ZS_EDITOR_COOKIE_SECRET as string, "base64"));
    const now = Math.floor(Date.now() / 1000);
    const expired = await new SignJWT({ ws: workspaceId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("user_test")
      .setAudience("zs-editor")
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .setJti("q".repeat(22))
      .sign(secret);
    expect(await verifyEditorCookie(jar(expired), workspaceId)).toBeNull();

    // ES256-signed (the session key) is not an editor cookie.
    const keys = await loadSigningKeys();
    const es256 = await new SignJWT({ ws: workspaceId })
      .setProtectedHeader({ alg: "ES256", typ: "JWT" })
      .setSubject("user_test")
      .setAudience("zs-editor")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .setJti("q".repeat(22))
      .sign(keys.active.privateKey);
    expect(await verifyEditorCookie(jar(es256), workspaceId)).toBeNull();

    const attrs = editorCookieAttributes(workspaceId, minted.expires);
    expect(attrs).toMatchObject({ httpOnly: true, sameSite: "strict", path: `/api/workspaces/${workspaceId}` });
    expect(attrs.expires).toBe(minted.expires);
  });

  it("editor_cookie_lineage_and_epoch", async () => {
    const workspaceId = newId("ws");
    const now = Math.floor(Date.now() / 1000);
    const fresh = await mintEditorCookie("user_test", workspaceId, { epoch: 3 });
    const claims = await verifyEditorCookie(jar(fresh.value), workspaceId);
    expect(claims?.oi).toBe(decodeJwt(fresh.value).iat);
    expect(claims?.ep).toBe(3);

    // A renewal keeps the origin and is capped at the absolute lifetime.
    const renewed = await mintEditorCookie("user_test", workspaceId, { originIat: now - 20 * 3600 });
    const payload = decodeJwt(renewed.value);
    expect(payload.oi).toBe(now - 20 * 3600);
    expect(payload.exp).toBeLessThanOrEqual(now - 20 * 3600 + EDITOR_COOKIE_MAX_LIFETIME_SECS);
    await expect(mintEditorCookie("user_test", workspaceId, { originIat: now - 25 * 3600 })).rejects.toThrow(/lifetime/);

    // A cookie whose lineage is older than 24 h is refused even when its own exp is fine.
    const secret = new Uint8Array(Buffer.from(process.env.ZS_EDITOR_COOKIE_SECRET as string, "base64"));
    const aged = await new SignJWT({ ws: workspaceId, oi: now - 25 * 3600, ep: 0 })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("user_test")
      .setAudience("zs-editor")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .setJti("q".repeat(22))
      .sign(secret);
    expect(await verifyEditorCookie(jar(aged), workspaceId)).toBeNull();
    // A cookie without the lineage claims (an older format) is not accepted either.
    const legacy = await new SignJWT({ ws: workspaceId })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject("user_test")
      .setAudience("zs-editor")
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .setJti("q".repeat(22))
      .sign(secret);
    expect(await verifyEditorCookie(jar(legacy), workspaceId)).toBeNull();
  });
});
