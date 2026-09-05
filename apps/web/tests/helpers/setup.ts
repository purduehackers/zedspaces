import { randomBytes } from "node:crypto";
import { _resetDbForTests } from "@/lib/db";
import { _resetEnvForTests } from "@/lib/env";
import { _resetRatelimitForTests } from "@/lib/ratelimit";
import { _resetKvForTests } from "@/lib/kv";
import { _resetSigningKeysForTests } from "@/lib/tokens";
import { generateTestKeys } from "./keys";

/**
 * Test environment: in-memory libSQL, memory KV, the fake sandbox driver, a fresh
 * editor-cookie secret, two secrets-envelope keys and two ES256 key pairs
 * (`k1` active, `k0` previous). Runs once per test file.
 */
const keys = await generateTestKeys();

process.env.ZS_DB_URL = ":memory:";
process.env.ZS_KV = "memory";
process.env.ZS_SANDBOX_DRIVER = "fake";
process.env.ZS_CONTROL_URL = "https://zs.test/api";
process.env.ZS_EDITOR_COOKIE_SECRET = randomBytes(32).toString("base64");
process.env.ZS_JWT_PRIVATE_KEY = keys.k1.privatePem;
process.env.ZS_JWT_KID = "k1";
process.env.ZS_JWT_PREVIOUS_PUBLIC_KEY = keys.k0.publicPem;
process.env.ZS_JWT_PREVIOUS_KID = "k0";
process.env.ZS_JWT_ISSUER = "zs";
process.env.ZS_CLIENT_BUILD_ID = "test-0";
process.env.ZS_SERVER_BUILD_ID = "test-0";
process.env.ZS_IMAGE_REF = "zs-workspace:test-0";

delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.VERCEL_ENV;
delete process.env.VERCEL_URL;

_resetEnvForTests();
_resetDbForTests();
_resetKvForTests();
_resetRatelimitForTests();
_resetSigningKeysForTests();

/** The generated key pairs, for tests that need the previous private key. */
export const TEST_KEYS = keys;
(globalThis as typeof globalThis & { __zsTestKeys?: typeof keys }).__zsTestKeys = keys;
