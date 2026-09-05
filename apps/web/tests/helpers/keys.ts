import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose";

/** One ES256 key pair as PEM strings. */
export interface TestKeyPair {
  kid: string;
  privatePem: string;
  publicPem: string;
}

/** The two pairs the setup file generates: `k1` (active) and `k0` (previous). */
export interface TestKeys {
  k1: TestKeyPair;
  k0: TestKeyPair;
}

/** Generates an extractable P-256 key pair and exports both halves as PEM. */
export async function generateTestKeyPair(kid: string): Promise<TestKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
  return { kid, privatePem: await exportPKCS8(privateKey), publicPem: await exportSPKI(publicKey) };
}

/** Two key pairs: `k1` (active) and `k0` (previous, for rotation tests). */
export async function generateTestKeys(): Promise<TestKeys> {
  const [k1, k0] = await Promise.all([generateTestKeyPair("k1"), generateTestKeyPair("k0")]);
  return { k1, k0 };
}

/** The key pairs `tests/helpers/setup.ts` installed into the environment for this worker. */
export function testKeys(): TestKeys {
  const keys = (globalThis as typeof globalThis & { __zsTestKeys?: TestKeys }).__zsTestKeys;
  if (!keys) throw new Error("tests/helpers/setup.ts has not run");
  return keys;
}

const FIXTURE_DIR = path.resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../zed/crates/remote_server/tests/fixtures",
);

/**
 * b2's serve fixture key pair (`zed/crates/remote_server/tests/fixtures/es256_*.pem`)
 * when it exists on disk, else `null` so the interop test can skip itself.
 */
export function readFixtureKeys(): { privatePem: string; publicPem: string } | null {
  const privatePath = path.join(FIXTURE_DIR, "es256_private.pem");
  const publicPath = path.join(FIXTURE_DIR, "es256_public.pem");
  if (!fs.existsSync(privatePath) || !fs.existsSync(publicPath)) return null;
  return { privatePem: fs.readFileSync(privatePath, "utf8"), publicPem: fs.readFileSync(publicPath, "utf8") };
}
