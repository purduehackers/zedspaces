import { z } from "zod";

/**
 * Lowest and highest port of the sandbox infrastructure set (D21): `8443` rpc,
 * `8444`-`8447` private proxy slots, `8448` supervisor health, `8449` reserved,
 * `8450` supervisor loopback API, `8451` serve control listener. User forwards
 * may never target a port in this range.
 */
export const INFRA_PORT_MIN = 8443;
/** See {@link INFRA_PORT_MIN}. */
export const INFRA_PORT_MAX = 8451;

/**
 * Zod view of every environment variable the control plane reads.
 *
 * Values are read lazily so local builds need no cloud accounts.
 * The deployment preflight separately requires persistent storage and real VM configuration.
 */
export const envSchema = z.object({
  // One Turso/libSQL database for control state and KV (D43/D44).
  TURSO_DATABASE_URL: z.string().min(1).optional(),
  TURSO_AUTH_TOKEN: z.string().min(1).optional(),
  ZS_DB_URL: z.string().min(1).optional(),
  ZS_MAX_RUNNING_WORKSPACES: z.coerce.number().int().min(1).max(100).default(5),

  // Vercel Cron (sent automatically as `Authorization: Bearer`).
  CRON_SECRET: z.string().min(16).optional(),

  // Session-token signing (ES256, PKCS#8 PEM) and rotation.
  ZS_JWT_PRIVATE_KEY: z.string().optional(),
  ZS_JWT_KID: z.string().default("k1"),
  ZS_JWT_PREVIOUS_PUBLIC_KEY: z.string().optional(),
  ZS_JWT_PREVIOUS_KID: z.string().optional(),
  ZS_JWT_ISSUER: z.string().default("zs"),

  // Editor cookie (HS256) – base64, 32 bytes.
  ZS_EDITOR_COOKIE_SECRET: z.string().optional(),

  // Builds and images.
  ZS_CLIENT_BUILD_ID: z.string().optional(),
  ZS_SERVER_BUILD_ID: z.string().optional(),
  ZS_IMAGE_REF: z.string().optional(),
  /** Optional local/CI Sandbox SDK token; Vercel deployments can use OIDC. */
  ZS_VERCEL_TOKEN: z.string().optional(),
  /** Sandbox SDK team scope (`team_…`). */
  VERCEL_TEAM_ID: z.string().optional(),
  /** `prj_…` — REST `projectId`. */
  VERCEL_PROJECT_ID: z.string().optional(),
  /**
   * Comma-separated served client builds, newest first — set by the deploy
   * from `public/editor/manifest.json`. The only way a Function may learn
   * which bundles are served: `public/` is not traced into the function bundle.
   */
  ZS_EDITOR_BUNDLES: z.string().optional(),

  /**
   * Canonical control-plane API base (D29): the public origin plus `/api`,
   * e.g. `https://zs.example.com/api`. Handed to the supervisor verbatim as
   * `ZS_CONTROL_URL`; the origin half is the single `manifest.allowedOrigins`
   * entry (D5).
   */
  ZS_CONTROL_URL: z.url().optional(),

  // Editor bundle delivery.
  ZS_EDITOR_BUNDLE_SOURCE: z.url().optional(),
  ZS_EDITOR_BUNDLES_KEEP: z.coerce.number().int().default(5),
  /** "1" until b7 ships the patched `wasm_thread` (b7 risk 2). */
  ZS_CSP_UNSAFE_EVAL: z.enum(["0", "1"]).default("1"),

  // Preview-deployment protection bypass (forwarded to the supervisor as ZS_BYPASS_SECRET, D18).
  VERCEL_AUTOMATION_BYPASS_SECRET: z.string().optional(),

  // Regions and ports (D21 port map).
  ZS_DEFAULT_REGION: z.enum(["iad1", "sfo1", "cle1", "cdg1"]).default("iad1"),
  ZS_PORT_POOL: z.string().default("3000,3001,4000,5000,5173,8000,8080,8888"),
  ZS_RPC_PORT: z.coerce.number().int().default(8443),
  ZS_PROXY_SLOTS: z.string().default("8444,8445,8446,8447"),
  ZS_HEALTH_PORT: z.coerce.number().int().default(8448),

  // Lifecycle policy.
  ZS_IDLE_MINUTES_DEFAULT: z.coerce.number().int().default(30),
  ZS_RETENTION_DAYS: z.coerce.number().int().default(30),
  /** Rolling sandbox timeout the sweep keeps extending. */
  ZS_SESSION_TIMEOUT_MS: z.coerce.number().int().default(4 * 3600_000),
  /** Platform session cap (controlled stop and resume at this age). */
  ZS_SESSION_CAP_MS: z.coerce.number().int().default(24 * 3600_000),
  /**
   * What backs the sandbox: the Vercel Sandbox SDK, or (`local`, refused
   * in production) child processes on this machine driven by
   * `lib/sandbox-local.ts` — the supervisor and `zed-remote-server serve` on
   * `127.0.0.1` with no Vercel account.
   */
  ZS_SANDBOX_BACKEND: z.enum(["vercel", "local"]).default("vercel"),
  /** Local backend: parent directory of the per-sandbox directories (default `$TMPDIR/zs-local`). */
  ZS_LOCAL_ROOT: z.string().optional(),
  /** Local backend: directory whose subdirectories are the `local/<name>` repositories. */
  ZS_LOCAL_REPOS_DIR: z.string().optional(),
  /** Local backend: the `zs-agent` binary to spawn (default `sandbox/supervisor/target/debug/zs-agent`). */
  ZS_AGENT_BIN: z.string().optional(),
  /** Local backend: the `zed-remote-server` binary the supervisor spawns (`ZS_SERVER_BIN`). */
  ZS_SERVE_BIN: z.string().optional(),

  // Blob store for rebuild tarballs (Marketplace: Vercel Blob injects the token).
  BLOB_READ_WRITE_TOKEN: z.string().optional(),
  /** Defaults to `vercel` when `BLOB_READ_WRITE_TOKEN` is set and `memory` otherwise. */
  ZS_BLOB_DRIVER: z.enum(["vercel", "memory"]).optional(),

  // Log sink for supervisor and client error reports.
  ZS_LOG_SINK_URL: z.url().optional(),
  ZS_LOG_SINK_TOKEN: z.string().optional(),

  // Vercel system variables.
  VERCEL_ENV: z.enum(["production", "preview", "development"]).optional(),
  VERCEL_URL: z.string().optional(),
  NODE_ENV: z.enum(["development", "test", "production"]).optional(),
});

/** The validated environment. */
export type Env = z.infer<typeof envSchema>;

/**
 * Thrown by {@link env} and {@link requireEnv} when the environment is invalid
 * or a required variable is missing. `missing` lists the offending keys.
 */
export class EnvError extends Error {
  constructor(
    public readonly missing: readonly string[],
    message?: string,
  ) {
    super(message ?? `Missing or invalid environment variables: ${missing.join(", ")}`);
    this.name = "EnvError";
  }
}

let cached: Env | null = null;

function cleanProcessEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    // Vercel and dotenv hand empty strings for unset-but-declared variables; treat them as absent.
    out[key] = value === "" ? undefined : value;
  }
  return out;
}

/**
 * Memoized, validated view of `process.env`. Throws {@link EnvError} listing
 * every invalid key on the first call; later calls return the cached value.
 */
export function env(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(cleanProcessEnv());
  if (!parsed.success) {
    const keys = [...new Set(parsed.error.issues.map((issue) => String(issue.path[0] ?? "?")))];
    const detail = parsed.error.issues
      .map((issue) => `${String(issue.path[0] ?? "?")}: ${issue.message}`)
      .join("; ");
    throw new EnvError(keys, `Invalid environment: ${detail}`);
  }
  refuseTestClientBuildInProduction(parsed.data);
  cached = parsed.data;
  return cached;
}

/** Whether a client build id names a test-hooks bundle (`script/build-web --test-hooks`: `<id>-test`, `<id>-test-names`). */
export function isTestClientBuild(build: string | undefined): boolean {
  return build !== undefined && /-test(-names)?$/.test(build);
}

/**
 * Production must not serve a fork bundle exposing `window.__zs_test`.
 * `scripts/fetch-editor-bundle.ts` also refuses to deliver these bundles.
 */
function refusesTestBundles(e: Env): boolean {
  return e.NODE_ENV === "production" || process.env.NODE_ENV === "production" || e.VERCEL_ENV === "production";
}

function refuseTestClientBuildInProduction(e: Env): void {
  if (!isTestClientBuild(e.ZS_CLIENT_BUILD_ID)) return;
  if (refusesTestBundles(e)) {
    throw new EnvError(
      ["ZS_CLIENT_BUILD_ID"],
      `ZS_CLIENT_BUILD_ID=${e.ZS_CLIENT_BUILD_ID} names a test-hooks bundle, which is refused in production`,
    );
  }
}

/**
 * Whether `build` is a test-hooks bundle this deployment must not serve. The environment guard
 * above only sees `ZS_CLIENT_BUILD_ID`, the id *new* workspaces are stamped with; the bundle a
 * tab actually loads is the one on the workspace row, which can carry a `-test` id from a test
 * deployment or a shared database. The editor document applies this where it chooses the bundle,
 * so the guard sits at the point of use and not only at the point of configuration.
 */
export function refusesTestClientBuild(build: string | undefined): boolean {
  return isTestClientBuild(build) && refusesTestBundles(env());
}

/**
 * Returns the named variables, throwing {@link EnvError} (naming every missing
 * key) when any of them is undefined.
 */
export function requireEnv<K extends keyof Env>(...keys: K[]): { [P in K]-?: NonNullable<Env[P]> } {
  const e = env();
  const missing = keys.filter((key) => e[key] === undefined || e[key] === null);
  if (missing.length > 0) throw new EnvError(missing.map(String));
  const out: Partial<Record<K, unknown>> = {};
  for (const key of keys) out[key] = e[key];
  return out as { [P in K]-?: NonNullable<Env[P]> };
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, "");
}

/**
 * Base of the sandbox-facing routes (D29): `ZS_CONTROL_URL` when set, else
 * `https://${VERCEL_URL}/api`. Always without a trailing slash. This is the
 * value the supervisor receives as `ZS_CONTROL_URL`.
 */
export function controlApiBase(): string {
  const e = env();
  if (e.ZS_CONTROL_URL) return stripTrailingSlashes(e.ZS_CONTROL_URL);
  if (e.VERCEL_URL) return `https://${stripTrailingSlashes(e.VERCEL_URL)}/api`;
  throw new EnvError(["ZS_CONTROL_URL"], "ZS_CONTROL_URL is required when VERCEL_URL is not set");
}

/**
 * Public origin of the control plane, derived from {@link controlApiBase}:
 * the single `manifest.allowedOrigins` entry (D5) and the origin sandboxes
 * call back to.
 */
export function controlPlaneUrl(): string {
  return new URL(controlApiBase()).origin;
}

/** `VERCEL_ENV ?? "development"` – the single sandbox tag value. */
export function envTag(): "production" | "preview" | "development" {
  return env().VERCEL_ENV ?? "development";
}

function parsePortList(raw: string, name: string): number[] {
  const ports = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part));
  for (const port of ports) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new EnvError([name], `${name}: "${raw}" contains an invalid port`);
    }
  }
  return [...new Set(ports)];
}

/** The public forward pool declared at sandbox create (`ZS_PORT_POOL`). */
export function portPool(): number[] {
  const pool = parsePortList(env().ZS_PORT_POOL, "ZS_PORT_POOL");
  const clash = pool.find((port) => port >= INFRA_PORT_MIN && port <= INFRA_PORT_MAX);
  if (clash !== undefined) {
    throw new EnvError(
      ["ZS_PORT_POOL"],
      `ZS_PORT_POOL: port ${clash} lies inside the infrastructure range ${INFRA_PORT_MIN}-${INFRA_PORT_MAX}`,
    );
  }
  return pool;
}

/**
 * The four private-port proxy slots (D8, D21): exactly four distinct ports,
 * none equal to `ZS_RPC_PORT` or `ZS_HEALTH_PORT` and none in the pool.
 */
export function proxySlots(): number[] {
  const e = env();
  const slots = parsePortList(e.ZS_PROXY_SLOTS, "ZS_PROXY_SLOTS");
  if (slots.length !== 4) {
    throw new EnvError(["ZS_PROXY_SLOTS"], `ZS_PROXY_SLOTS must list exactly four distinct ports (got ${slots.length})`);
  }
  if (slots.includes(e.ZS_RPC_PORT)) {
    throw new EnvError(["ZS_PROXY_SLOTS"], `ZS_PROXY_SLOTS must not include the rpc port ${e.ZS_RPC_PORT}`);
  }
  if (slots.includes(e.ZS_HEALTH_PORT)) {
    throw new EnvError(["ZS_PROXY_SLOTS"], `ZS_PROXY_SLOTS must not include the health port ${e.ZS_HEALTH_PORT}`);
  }
  const pool = new Set(portPool());
  const clash = slots.find((slot) => pool.has(slot));
  if (clash !== undefined) {
    throw new EnvError(["ZS_PROXY_SLOTS"], `ZS_PROXY_SLOTS: slot ${clash} is also in ZS_PORT_POOL`);
  }
  return slots;
}

/**
 * Every port user forwards may never target (D21): the infrastructure range
 * `8443`-`8451` unioned with the configured rpc, slot and health ports.
 * Sorted ascending, deduplicated.
 */
export function infraPorts(): number[] {
  const e = env();
  const set = new Set<number>();
  for (let port = INFRA_PORT_MIN; port <= INFRA_PORT_MAX; port += 1) set.add(port);
  set.add(e.ZS_RPC_PORT);
  set.add(e.ZS_HEALTH_PORT);
  for (const slot of proxySlots()) set.add(slot);
  return [...set].sort((a, b) => a - b);
}

/** True when `port` belongs to {@link infraPorts}. */
export function isInfraPort(port: number): boolean {
  return infraPorts().includes(port);
}
