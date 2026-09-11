import { z } from "zod";

/** VM infrastructure (RPC, proxy slots, health and loopback control listeners). */
export const INFRA_PORT_MIN = 8443;
/** See {@link INFRA_PORT_MIN}. */
export const INFRA_PORT_MAX = 8460;

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

  // GitHub identity only: no repository permissions or tokens in sandboxes.
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  BETTER_AUTH_SECRET: z.string().min(32).optional(),

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
  /** Served builds carrying the web update UI bridge, stamped by the release publisher. */
  ZS_EDITOR_UPDATE_BUILDS: z.string().optional(),

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
  ZS_RPC_PORT: z.coerce.number().int().default(8443),
  ZS_HEALTH_PORT: z.coerce.number().int().default(8448),

  // Lifecycle policy.
  ZS_IDLE_MINUTES_DEFAULT: z.coerce.number().int().default(30),
  ZS_RETENTION_DAYS: z.coerce.number().int().default(30),
  /** Rolling sandbox timeout the sweep keeps extending. */
  ZS_SESSION_TIMEOUT_MS: z.coerce.number().int().default(4 * 3600_000),
  /** Platform session cap (controlled stop and resume at this age). */
  ZS_SESSION_CAP_MS: z.coerce.number().int().default(24 * 3600_000),
  /** Vercel in production; Docker containers or host processes for local development. */
  ZS_SANDBOX_BACKEND: z.enum(["vercel", "local", "docker"]).default("vercel"),
  /** Docker instance state directory; also scopes container ownership. */
  ZS_DOCKER_ROOT: z.string().optional(),
  /** Container-reachable relay to the host's authenticated sandbox API. */
  ZS_DOCKER_CONTROL_URL: z.url().optional(),
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
  ZS_BLOB_DRIVER: z.enum(["vercel", "memory", "file"]).optional(),

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

/** 12 previews plus RPC/health: Vercel currently returns 500 for 15 declared ports. */
export function proxySlots(): number[] {
  return [8444, 8445, 8446, 8447, 8452, 8453, 8454, 8455, 8456, 8457, 8458, 8459];
}

/**
 * Ports that can never be app previews: the infrastructure range
 * `8443`-`8460`, VM services and configured RPC/health listeners.
 * Sorted ascending, deduplicated.
 */
export function infraPorts(): number[] {
  const e = env();
  // VM services and Vercel's controller are never app previews.
  const set = new Set<number>([22, 53, 111, 23456]);
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
