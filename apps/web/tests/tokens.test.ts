import { decodeJwt, decodeProtectedHeader, importPKCS8, importSPKI, jwtVerify, SignJWT } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { _resetEnvForTests } from "@/lib/env";
import { newConnectId, newId } from "@/lib/ids";
import { mintPortBootstrapToken, verifyPortBootstrapToken } from "@/lib/port-token";
import {
  _resetSigningKeysForTests,
  loadSigningKeys,
  mintSessionToken,
  publicKeyPems,
  TokenError,
  verifySessionToken,
  type SigningKeys,
} from "@/lib/tokens";
import { readFixtureKeys, testKeys } from "./helpers/keys";

const workspaceId = newId("ws");
const audience = "sb-dev-abc-g1";
const userId = "user_test";

async function expectTokenError(promise: Promise<unknown>, code: TokenError["code"], token?: string): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TokenError);
  const error = caught as TokenError;
  expect(error.code).toBe(code);
  if (token) expect(error.message).not.toContain(token);
}

function base64url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

describe("session tokens", () => {
  afterEach(() => {
    const keys = testKeys();
    process.env.ZS_JWT_PRIVATE_KEY = keys.k1.privatePem;
    process.env.ZS_JWT_KID = "k1";
    process.env.ZS_JWT_PREVIOUS_PUBLIC_KEY = keys.k0.publicPem;
    process.env.ZS_JWT_PREVIOUS_KID = "k0";
    _resetEnvForTests();
    _resetSigningKeysForTests();
  });

  it("mints_es256_with_expected_claims", async () => {
    const sessionId = newConnectId();
    const minted = await mintSessionToken({ userId, workspaceId, sessionId, audience });

    expect(decodeProtectedHeader(minted.token)).toEqual({ alg: "ES256", typ: "JWT", kid: "k1" });
    const payload = decodeJwt(minted.token);
    expect(payload.iss).toBe("zs");
    expect(payload.sub).toBe(userId);
    expect(payload.ws).toBe(workspaceId);
    expect(payload.sid).toBe(sessionId);
    expect(payload.sid).not.toBe(payload.ws);
    expect(payload.aud).toBe(audience);
    expect(typeof payload.iat).toBe("number");
    expect(payload.exp).toBe((payload.iat as number) + 3600);
    expect((payload.jti as string).length).toBeGreaterThanOrEqual(22);
    expect(minted.jti).toBe(payload.jti);
    expect(minted.kid).toBe("k1");
    expect(minted.expiresAt.getTime()).toBe((payload.exp as number) * 1000);

    const claims = await verifySessionToken(minted.token, { audience, workspaceId });
    expect(claims.ws).toBe(workspaceId);
    expect(claims.sid).toBe(sessionId);
    expect(claims.sub).toBe(userId);
  });

  it("ttl_capped_at_one_hour", async () => {
    const minted = await mintSessionToken({ userId, workspaceId, sessionId: newConnectId(), audience, ttlSeconds: 7200 });
    const payload = decodeJwt(minted.token);
    expect((payload.exp as number) - (payload.iat as number)).toBe(3600);
  });

  it("rejects_wrong_audience_workspace_issuer", async () => {
    const keys = await loadSigningKeys();
    const good = await mintSessionToken({ userId, workspaceId, sessionId: newConnectId(), audience });
    await expectTokenError(verifySessionToken(good.token, { audience: "other-audience", workspaceId }), "audience", good.token);
    await expectTokenError(verifySessionToken(good.token, { audience, workspaceId: newId("ws") }), "workspace", good.token);

    const otherIssuer: SigningKeys = { ...keys, issuer: "not-zs" };
    const foreign = await mintSessionToken({ userId, workspaceId, sessionId: newConnectId(), audience }, otherIssuer);
    await expectTokenError(verifySessionToken(foreign.token, { audience, workspaceId }), "issuer", foreign.token);
  });

  it("rejects_expired_beyond_tolerance", async () => {
    const keys = await loadSigningKeys();
    const now = Math.floor(Date.now() / 1000);
    const build = (exp: number) =>
      new SignJWT({ ws: workspaceId, sid: newConnectId() })
        .setProtectedHeader({ alg: "ES256", typ: "JWT", kid: keys.active.kid })
        .setIssuer(keys.issuer)
        .setSubject(userId)
        .setAudience(audience)
        .setIssuedAt(exp - 3600)
        .setExpirationTime(exp)
        .setJti("x".repeat(22))
        .sign(keys.active.privateKey);

    await expectTokenError(verifySessionToken(await build(now - 120), { audience, workspaceId }), "expired");
    const claims = await verifySessionToken(await build(now - 10), { audience, workspaceId });
    expect(claims.exp).toBe(now - 10);
  });

  it("rejects_hs256_and_none", async () => {
    const keys = await loadSigningKeys();
    const now = Math.floor(Date.now() / 1000);
    const claims = {
      iss: "zs",
      sub: userId,
      ws: workspaceId,
      sid: newConnectId(),
      aud: audience,
      iat: now,
      exp: now + 600,
      jti: "y".repeat(22),
    };

    const hs256 = await new SignJWT(claims)
      .setProtectedHeader({ alg: "HS256", typ: "JWT", kid: "k1" })
      .sign(new TextEncoder().encode(keys.active.publicSpkiPem));
    await expect(verifySessionToken(hs256, { audience, workspaceId })).rejects.toBeInstanceOf(TokenError);

    const none = `${base64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${base64url(JSON.stringify(claims))}.`;
    await expect(verifySessionToken(none, { audience, workspaceId })).rejects.toBeInstanceOf(TokenError);
  });

  it("kid_rotation_selects_previous_key", async () => {
    const pairs = testKeys();
    const current = await loadSigningKeys();
    expect(publicKeyPems(current)).toEqual([pairs.k1.publicPem, pairs.k0.publicPem]);

    const previousSigner: SigningKeys = {
      active: {
        kid: "k0",
        privateKey: await importPKCS8(pairs.k0.privatePem, "ES256"),
        publicKey: await importSPKI(pairs.k0.publicPem, "ES256"),
        publicSpkiPem: pairs.k0.publicPem,
      },
      issuer: "zs",
    };
    const old = await mintSessionToken({ userId, workspaceId, sessionId: newConnectId(), audience }, previousSigner);
    expect(decodeProtectedHeader(old.token).kid).toBe("k0");
    const claims = await verifySessionToken(old.token, { audience, workspaceId });
    expect(claims.ws).toBe(workspaceId);

    delete process.env.ZS_JWT_PREVIOUS_PUBLIC_KEY;
    delete process.env.ZS_JWT_PREVIOUS_KID;
    _resetEnvForTests();
    _resetSigningKeysForTests();
    await expectTokenError(verifySessionToken(old.token, { audience, workspaceId }), "unknown_kid", old.token);
    expect(publicKeyPems(await loadSigningKeys())).toEqual([pairs.k1.publicPem]);
  });

  it("port_bootstrap_token_is_not_a_session_token", async () => {
    const bootstrap = await mintPortBootstrapToken({ userId, workspaceId, audience, port: 3000 });
    await expectTokenError(verifySessionToken(bootstrap.token, { audience, workspaceId }), "audience", bootstrap.token);

    const session = await mintSessionToken({ userId, workspaceId, sessionId: newConnectId(), audience });
    await expectTokenError(verifyPortBootstrapToken(session.token, { audience, workspaceId }), "audience", session.token);

    const payload = decodeJwt(bootstrap.token);
    expect((payload.exp as number) - (payload.iat as number)).toBe(600);
    expect(payload.sid).toBe("port:3000");
    expect(payload.aud).toBe(`${audience}/ports`);
  });

  const fixture = readFixtureKeys();
  it.skipIf(fixture === null)("interop_with_serve_fixture", async () => {
    if (!fixture) return;
    const signer: SigningKeys = {
      active: {
        kid: "fixture",
        privateKey: await importPKCS8(fixture.privatePem, "ES256"),
        publicKey: await importSPKI(fixture.publicPem, "ES256"),
        publicSpkiPem: fixture.publicPem,
      },
      issuer: "zs",
    };
    const minted = await mintSessionToken({ userId, workspaceId, sessionId: newConnectId(), audience }, signer);
    const { payload } = await jwtVerify(minted.token, await importSPKI(fixture.publicPem, "ES256"), {
      issuer: "zs",
      audience,
      algorithms: ["ES256"],
    });
    // The claim set b2's `Claims` struct requires.
    for (const claim of ["iss", "sub", "ws", "sid", "aud", "iat", "exp", "jti"]) {
      expect(payload).toHaveProperty(claim);
    }
  });
});
