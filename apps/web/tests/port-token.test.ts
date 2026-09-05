import { decodeJwt, decodeProtectedHeader, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import {
  mintPortBootstrapToken,
  PORT_BOOTSTRAP_PARAM,
  PORT_BOOTSTRAP_TTL_SECS,
  portAudience,
  verifyPortBootstrapToken,
} from "@/lib/port-token";
import { loadSigningKeys, mintSessionToken, TokenError } from "@/lib/tokens";

const workspaceId = newId("ws");
const audience = "sb-dev-xyz-g1";
const userId = "user_test";

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof TokenError) return err.code;
    throw err;
  }
  throw new Error("expected a TokenError");
}

describe("private-port bootstrap tokens", () => {
  it("port_bootstrap_matches_b8_verifier", async () => {
    const keys = await loadSigningKeys();
    const minted = await mintPortBootstrapToken({ userId, workspaceId, audience, port: 3000 });

    expect(decodeProtectedHeader(minted.token)).toEqual({ alg: "ES256", typ: "JWT", kid: "k1" });
    const payload = decodeJwt(minted.token);
    expect(payload.iss).toBe("zs");
    expect(payload.aud).toBe(`${audience}/ports`);
    expect(payload.sub).toBe(userId);
    expect(payload.ws).toBe(workspaceId);
    expect(payload.sid).toBe("port:3000");
    expect(payload.exp).toBe((payload.iat as number) + PORT_BOOTSTRAP_TTL_SECS);
    expect(typeof payload.jti).toBe("string");
    expect(PORT_BOOTSTRAP_PARAM).toBe("zs_port_token");
    expect(portAudience(audience)).toBe(`${audience}/ports`);

    const verified = await verifyPortBootstrapToken(minted.token, { audience, workspaceId });
    expect(verified.port).toBe(3000);
    expect(verified.claims.sid).toBe("port:3000");

    const now = Math.floor(Date.now() / 1000);
    const build = (overrides: { sid?: string; ws?: string; iat?: number; exp?: number; aud?: string }) =>
      new SignJWT({ ws: overrides.ws ?? workspaceId, sid: overrides.sid ?? "port:3000" })
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: keys.active.kid })
        .setIssuer(keys.issuer)
        .setSubject(userId)
        .setAudience(overrides.aud ?? portAudience(audience))
        .setIssuedAt(overrides.iat ?? now)
        .setExpirationTime(overrides.exp ?? now + 600)
        .setJti("z".repeat(22))
        .sign(keys.active.privateKey);

    // Infra ports, port 0 and a non-port sid are refused.
    expect(await code(verifyPortBootstrapToken(await build({ sid: "port:8443" }), { audience, workspaceId }))).toBe("port");
    expect(await code(verifyPortBootstrapToken(await build({ sid: "port:8448" }), { audience, workspaceId }))).toBe("port");
    expect(await code(verifyPortBootstrapToken(await build({ sid: "port:0" }), { audience, workspaceId }))).toBe("port");
    expect(await code(verifyPortBootstrapToken(await build({ sid: "sess" }), { audience, workspaceId }))).toBe("port");
    // Lifetime above 600 s and an expired token.
    expect(
      await code(verifyPortBootstrapToken(await build({ iat: now, exp: now + 3600 }), { audience, workspaceId })),
    ).toBe("expired");
    expect(
      await code(verifyPortBootstrapToken(await build({ iat: now - 1200, exp: now - 600 }), { audience, workspaceId })),
    ).toBe("expired");
    // Wrong workspace, session audience.
    expect(await code(verifyPortBootstrapToken(await build({ ws: newId("ws") }), { audience, workspaceId }))).toBe("workspace");
    expect(await code(verifyPortBootstrapToken(await build({ aud: audience }), { audience, workspaceId }))).toBe("audience");
    const session = await mintSessionToken({ userId, workspaceId, sessionId: "con_x", audience });
    expect(await code(verifyPortBootstrapToken(session.token, { audience, workspaceId }))).toBe("audience");

    // HS256 and none.
    const hs256 = await new SignJWT({ ws: workspaceId, sid: "port:3000", iss: "zs", sub: userId, aud: portAudience(audience), iat: now, exp: now + 600, jti: "j".repeat(22) })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .sign(new TextEncoder().encode(keys.active.publicSpkiPem));
    await expect(verifyPortBootstrapToken(hs256, { audience, workspaceId })).rejects.toBeInstanceOf(TokenError);
    const none = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
      JSON.stringify({ ws: workspaceId, sid: "port:3000", iss: "zs", sub: userId, aud: portAudience(audience), iat: now, exp: now + 600, jti: "j" }),
    ).toString("base64url")}.`;
    await expect(verifyPortBootstrapToken(none, { audience, workspaceId })).rejects.toBeInstanceOf(TokenError);
  });

  it("refuses_to_mint_for_infra_ports", async () => {
    for (const port of [8443, 8444, 8448, 8451, 0, 70000]) {
      expect(await code(mintPortBootstrapToken({ userId, workspaceId, audience, port }))).toBe("port");
    }
  });
});
