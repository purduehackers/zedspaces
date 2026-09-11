/**
 * Shared wire types of the control plane (b9 §4.2, §4.7, §3.18; CONTRACTS.md
 * §7-§8). This module is import-safe from client components: it depends only
 * on zod and type-only imports.
 */
import { z } from "zod";
import { githubBranch } from "./github-repo";
import type {
  MachineType,
  PortVisibility,
  Region,
  WorkspaceState,
} from "./schema";

export type { MachineType, PortVisibility, Region, WorkspaceState } from "./schema";

// Identifier shapes (CONTRACTS.md §8.1).

/** `ws_` + 20 Crockford base32 characters. */
export const workspaceIdSchema = z.string().regex(/^ws_[0-9A-HJKMNP-TV-Z]{20}$/, "invalid workspace id");
/** `repo_` + 20 Crockford base32 characters. */
export const repoIdSchema = z.string().regex(/^repo_[0-9A-HJKMNP-TV-Z]{20}$/, "invalid repo id");
/** Workspace sandbox names. */
export const sandboxNameSchema = z.string().regex(/^sb-[a-z0-9-]{1,60}$/, "invalid sandbox name");
/** Port a user forward may name (the infra set is rejected separately by `infraPorts()`). */
export const userPortSchema = z.number().int().min(1).max(65535);

export const machineTypeSchema = z.enum(["vcpu2", "vcpu4", "vcpu8", "vcpu32"]);
export const regionSchema = z.enum(["iad1", "sfo1", "cle1", "cdg1"]);
export const portVisibilitySchema = z.enum(["private", "public"]);

// Forward and workspace views.

/** A forwarded port as the API and the manifest present it. */
export interface ForwardView {
  port: number;
  visibility: PortVisibility;
  label: string | null;
  /** Public proxy URL or private control-plane `/open` link; null while unavailable. */
  url: string | null;
  /** Proxy listener assigned to this app port. */
  slot: number | null;
}

/** Repo summary embedded in views. */
export interface RepoRef {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
}

/** A workspace as `GET /api/workspaces` returns it. */
export interface WorkspaceView {
  id: string;
  name: string;
  repo: RepoRef;
  branch: string | null;
  revision: string | null;
  pullRequest: number | null;
  machine: MachineType;
  region: Region;
  state: WorkspaceState;
  stateReason: string | null;
  workflowRunId: string | null;
  idleMinutes: number;
  serverBuild: string;
  clientBuild: string;
  /** ISO 8601. */
  lastActiveAt: string;
  createdAt: string;
  lastStoppedAt: string | null;
  retentionUntil: string | null;
  forwards: ForwardView[];
  /** The image this generation boots from (b10 §3.12). */
  image: WorkspaceImageView;
}

/** `WorkspaceView.image` (b10 §3.12). */
export interface WorkspaceImageView {
  kind: "base";
  ref: string;
  serverBuild: string;
  /** The image was built for an older server build than the one deployed. */
  stale: boolean;
}

/** A repo as `GET /api/repos` returns it. */
export interface RepoView {
  id: string | null;
  installationId: number;
  githubRepoId: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  defaultMachine?: MachineType;
  idleMinutes?: number | null;
}

// User-facing request bodies.

/** `POST /api/workspaces` body. */
export const createWorkspaceInput = z.object({
  repo: z.union([
    z.object({ repoId: z.string() }),
    z.object({ installationId: z.number().int().optional(), owner: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/), name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_.-]+$/).refine((s) => s !== "." && s !== "..") }),
  ]),
  ref: z
    .union([
      z.object({ branch: githubBranch }),
      z.object({ pullRequest: z.number().int().positive() }),
      z.object({ revision: z.string().regex(/^[0-9a-f]{7,40}$/) }),
    ])
    .optional(),
  machine: machineTypeSchema.optional(),
  region: regionSchema.optional(),
  idleMinutes: z.number().int().min(5).max(240).optional(),
  name: z.string().min(1).max(64).optional(),
});
export type CreateWorkspaceInput = z.input<typeof createWorkspaceInput>;

/** `PATCH /api/workspaces/{id}` body. */
export const patchWorkspaceInput = z.object({
  name: z.string().min(1).max(64).optional(),
  idleMinutes: z.number().int().min(5).max(240).optional(),
});
export type PatchWorkspaceInput = z.infer<typeof patchWorkspaceInput>;

/** `POST /api/workspaces/{id}/connect` body. */
export const connectInput = z.object({
  clientBuild: z.string().optional(),
  reason: z.enum(["open", "reconnect", "resume"]).default("open"),
  tabId: z.string().min(8).max(64),
});
export type ConnectInput = z.infer<typeof connectInput>;

/** `POST /api/workspaces/{id}/rebuild` body. */
export const rebuildInput = z.object({});

/** `POST /api/workspaces/{id}/ports` body. */
export const createForwardInput = z.object({
  port: userPortSchema,
  visibility: portVisibilitySchema,
  label: z.string().max(64).nullable().optional(),
});
export type CreateForwardInput = z.infer<typeof createForwardInput>;

/** `POST /api/workspaces/{id}/client-errors` body (browser-originated). */
export const clientErrorInput = z.object({
  build: z.string().max(128),
  kind: z.enum(["panic", "boot", "error", "perf", "close"]),
  message: z.string().max(4096),
  stack: z.string().max(65536).optional(),
  marks: z.record(z.string(), z.number()).optional(),
});
export type ClientErrorInput = z.infer<typeof clientErrorInput>;

/** `PUT /api/me/settings|keymap` body. */
export const putSettingsDocInput = z.object({
  content: z.string().max(512 * 1024),
  version: z.number().int().optional(),
});

/** `PUT /api/me/dotfiles` body. */
export const putDotfilesInput = z.object({
  repoUrl: z.string().url().nullable(),
  installCommand: z.string().max(1024).nullable(),
});

// Connect and health (b9 §3.18; D26).

/** What `POST /api/workspaces/{id}/connect` returns on 200 (D26). */
export const connectInfoSchema = z.object({
  wsUrl: z.url().refine(value => {
    try {
      const url = new URL(value);
      return ["ws:", "wss:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }),
  token: z.string().min(1).max(16_384),
  sessionId: z.string().min(1).max(128),
  workspaceId: workspaceIdSchema,
  serverBuild: z.string().min(1).max(128),
  clientBuild: z.string().min(1).max(128),
  sessionExpiresAt: z.iso.datetime({ offset: true }),
  sessionCapAt: z.iso.datetime({ offset: true }),
  audience: z.string().min(1).max(256),
});
export type ConnectInfo = z.infer<typeof connectInfoSchema>;

/** `202` body of `/connect` while a resume runs. */
export interface ConnectResuming {
  status: "resuming";
  runId: string;
}

/** Supervisor boot phases (b8 §3.8; D13, D14). */
export const bootPhaseSchema = z.enum([
  "manifest",
  "restore",
  "clone",
  "server_starting",
  "services",
  "dotfiles",
  "post_create",
  "post_start",
  "ready",
]);
export type BootPhase = z.infer<typeof bootPhaseSchema>;

/** The non-loopback body of `GET :8448/health` (b8 §4.4), reduced. */
export interface HealthProbe {
  ready: boolean;
  status: "booting" | "ready" | "degraded" | "stopping";
  phase: BootPhase;
  build: string | null;
  manifestBuild: string | null;
  resumed: boolean;
  busy: boolean;
  serverRunning: boolean;
  serverCrashLoop: boolean;
  serverRestarts: number;
  uptimeSecs: number;
}

// Sandbox-facing bodies (b9 §4.2; CONTRACTS.md §7.4-§7.6).

/** `POST /api/sandboxes/{name}/activity` body (D13 fields plus what b8 sends today). */
export const activityReport = z.object({
  lastInputAt: z.number().int().nullable().optional(),
  sessionActive: z.boolean(),
  busy: z.boolean(),
  phase: bootPhaseSchema,
  cpuBusyPct: z.number().min(0).max(100).nullable().optional(),
  listening: z
    .array(z.object({ port: z.number().int(), pid: z.number().int().optional(), process: z.string().optional() }))
    .max(256)
    .optional(),
  sid: z.string().nullable().optional(),
  serverBuild: z.string().optional(),
  supervisorBuild: z.string().optional(),
  uptimeSeconds: z.number().int().optional(),
  serverUptimeSecs: z.number().int().optional(),
  agentUptimeSecs: z.number().int().optional(),
  status: z.enum(["booting", "ready", "degraded", "stopping"]).optional(),
});
export type ActivityReport = z.infer<typeof activityReport>;

/** `POST /api/sandboxes/{name}/activity` response (D29): unix ms timestamps. */
export interface ActivityDirective {
  idleStopAt: number | null;
  sessionCapAt: number | null;
  stop: boolean;
  /** Authoritative: the supervisor replaces its in-memory forward list with it. */
  forwards: ForwardView[];
  serverTime: number;
}

/** `POST /api/sandboxes/{name}/ports` body. */
export const sandboxPortInput = z.object({
  port: userPortSchema,
  visibility: portVisibilitySchema,
  label: z.string().max(64).nullable().optional(),
  action: z.enum(["forward", "unforward"]).optional(),
});

/** `POST /api/sandboxes/{name}/ports` response. */
export interface SandboxPortResponse {
  url: string | null;
  visibility: PortVisibility;
  slot: number | null;
}

/** One log entry of a JSON `LogBatch`. */
export const logEntry = z.object({
  ts: z.number(),
  level: z.string(),
  source: z.string(),
  msg: z.string(),
  sid: z.string().optional(),
  fields: z.record(z.string(), z.unknown()).optional(),
});
export type LogEntry = z.infer<typeof logEntry>;

/** `POST /api/sandboxes/{name}/logs` JSON body. */
export const logBatch = z.object({
  workspaceId: z.string().optional(),
  sandboxName: z.string().optional(),
  sessionId: z.string().optional(),
  build: z.string().optional(),
  entries: z.array(logEntry).max(200),
});
export type LogBatch = z.infer<typeof logBatch>;

/** One NDJSON line as b8 §3.6 sends it (`target` maps to `source`). */
export const logLineNdjson = logEntry.omit({ source: true }).extend({ target: z.string() });
export type LogLineNdjson = z.infer<typeof logLineNdjson>;

/** `POST /api/sandboxes/{name}/extensions` body (the supervisor's relay, D18/D19). */
export const installedExtensions = z.object({
  installed: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(200),
});

/** Log sources a workspace supervisor may report. */
export const SUPERVISOR_LOG_SOURCES = [
  "server",
  "agent",
  "post_create",
  "post_start",
  "post_attach",
  "dotfiles",
  "proxy",
  "services",
] as const;

/** Whether `source` is allowed for the principal kind (`server:<module_path>` is a supervisor source). */
export function logSourceAllowed(source: string, _kind: "workspace"): boolean {
  void _kind;
  if (source.startsWith("server:")) return true;
  return (SUPERVISOR_LOG_SOURCES as readonly string[]).includes(source);
}

/** `POST /api/sandboxes/{name}/client-errors` body (supervisor-originated). */
export const sandboxClientErrorInput = z.object({
  build: z.string().max(128),
  kind: z.enum(["server_crash", "boot"]),
  message: z.string().max(4096),
  stack: z.string().max(65536).optional(),
  marks: z.record(z.string(), z.number()).optional(),
});
export type SandboxManifest = z.infer<typeof sandboxManifestSchema>;

/** The forward shape inside the manifest and the API. */
export const forwardViewSchema = z.object({
  port: z.number().int().min(1).max(65535),
  visibility: portVisibilitySchema,
  label: z.string().nullable(),
  url: z.string().nullable(),
  slot: z.number().int().nullable(),
});

/**
 * Zod view of {@link SandboxManifest} (b9 §4.7, CONTRACTS.md §7.3).
 * Unknown keys pass through, as b8's serde does; the
 * optional members accept `null` as well as absence because b8 models them as
 * `Option<T>`.
 */
export const sandboxManifestSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().min(1),
    sandboxName: sandboxNameSchema,
    sandboxGeneration: z.number().int().min(1),
    userId: z.string().min(1),
    build: z.string().min(1),
    clientBuild: z.string().min(1).optional(),
    region: regionSchema,
    repo: z
      .object({
        owner: z.string().min(1),
        name: z.string().min(1),
        cloneUrl: z.string().url(),
        defaultBranch: z.string().min(1),
        revision: z.string().min(1),
        depth: z.number().int().min(0),
        commit: z.string().regex(/^[0-9a-f]{40}$/).nullable().optional(),
        ref: z.string().nullable().optional(),
      })
      .passthrough(),
    workspaceDir: z.string().regex(/^\/workspaces\/[^/]+$/),
    restore: z.object({ tarballUrl: z.string().url(), sha256: z.string().nullable() }).nullable(),
    dotfiles: z.object({ repoUrl: z.string().url(), installCommand: z.string().nullable() }).nullable(),
    env: z.record(z.string(), z.string()),
    secretNames: z.array(z.string()),
    jwt: z
      .object({
        issuer: z.string().min(1),
        audience: z.string().min(1),
        portAudience: z.string().min(1),
        publicKeys: z.array(z.string().includes("PUBLIC KEY")).min(1),
      })
      .passthrough(),
    forwards: z.array(forwardViewSchema),
    proxySlots: z.array(z.number().int()).length(12),
    idle: z.object({ minutes: z.number().int().min(0) }),
    session: z.object({
      id: z.string(),
      startedAt: z.number(),
      capAt: z.number(),
      resumed: z.boolean(),
    }),
    devcontainer: z.null(),
    settings: z.object({ settings: z.string(), keymap: z.string() }).nullable(),
    logs: z.object({ flushIntervalSecs: z.literal(5), maxBatch: z.literal(200), maxBatchBytes: z.literal(262144) }),
    activity: z.object({ intervalSecs: z.literal(30) }),
    allowedOrigins: z.array(z.string().url()),
    extensions: z.array(z.string()),
  })
  .passthrough();

// Shell-facing (b9 §3.26).

/** Lifecycle kinds as the shell's `onLifecycle` receives them (D29: snake_case). */
export type LifecycleKind = "idle_stop_in" | "session_cap_in" | "stopping" | "resumed";

/** The workspace summary the editor page hands the shell. */
export interface ShellWorkspace {
  id: string;
  name: string;
  repo: string;
  branch: string | null;
  machine: MachineType;
  region: Region;
  state: WorkspaceState;
  stateReason: string | null;
  idleMinutes: number;
  serverBuild: string;
  clientBuild: string;
}
