/** Vercel Sandbox SDK adapter, with a local process backend for development. */
import { Readable } from "node:stream";
import { APIError, Sandbox, Snapshot } from "@vercel/sandbox";
import { SandboxError } from "./sandbox-error";
import { localBackendEnabled, localSandboxApi } from "./sandbox-local";
import type { Region } from "./schema";

/** `SessionMetaData.status` of the sandbox's current session. */
export type SandboxStatus =
  | "pending"
  | "running"
  | "stopping"
  | "stopped"
  | "failed"
  | "aborted"
  | "snapshotting";

/** Metered usage of one VM session; every field defaults to 0 when the SDK omits it. */
export interface SandboxUsage {
  activeCpuDurationMs: number;
  ingressBytes: number;
  egressBytes: number;
}

/** A usage record with every counter at zero (a sandbox that was already stopped). */
export const ZERO_USAGE: SandboxUsage = { activeCpuDurationMs: 0, ingressBytes: 0, egressBytes: 0 };

/** Signals {@link SandboxHandle.killCommand} accepts. */
export type KillSignal = "SIGTERM" | "SIGKILL";

/** Arguments of {@link SandboxHandle.run} and {@link SandboxHandle.runDetached}. */
export interface RunInput {
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  sudo?: boolean;
  timeoutMs?: number;
}

/** Result of a finished command. */
export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** A non-blocking read of a detached command (b10 §3.4 `commandStatus`). */
export interface CommandStatus {
  /** `null` while the command is still running. */
  exitCode: number | null;
  running: boolean;
}

/** One live sandbox. Every method is a single SDK call. */
export interface SandboxHandle {
  /** Immutable sandbox name (`sb-…` or `pb-…`). */
  readonly name: string;
  /** Status of the current session. */
  readonly status: SandboxStatus;
  /** Region the sandbox is configured for. */
  readonly region: string;
  /** When the running session times out, if one is running. */
  readonly expiresAt: Date | undefined;
  /** `sandbox.currentSession().sessionId`, or undefined when no session exists. */
  readonly currentSessionId: string | undefined;
  /**
   * `https://<subdomain>.vercel.run` for a declared port. Throws when the port
   * was not declared at create time.
   */
  domain(port: number): string;
  /** Starts a command detached and returns its id. */
  runDetached(input: RunInput): Promise<{ cmdId: string }>;
  /** Runs a command to completion. */
  run(input: RunInput): Promise<RunResult>;
  /** Waits for a detached command to exit; rejects when `timeoutMs` elapses first. */
  waitCommand(cmdId: string, timeoutMs: number): Promise<{ exitCode: number }>;
  /**
   * Reads a detached command's exit code without waiting (`Command.exitCode`
   * is `number | null`; b10 §3.4). Optional so a driver that lacks it degrades
   * to a one-second `waitCommand` probe (`commandStatusOf` in the image steps).
   */
  commandStatus?(cmdId: string): Promise<CommandStatus>;
  /** Sends `signal` to a running command. */
  killCommand(cmdId: string, signal: KillSignal): Promise<void>;
  /**
   * Extends the running session's timeout. The SDK wraps this in `withResume`,
   * so only call it right after observing `status === "running"`.
   */
  extendTimeout(ms: number): Promise<void>;
  /** Stops the sandbox, returning the snapshot it produced and the session's usage. */
  stop(): Promise<{ snapshotId?: string; snapshotSizeBytes?: number; usage: SandboxUsage }>;
  /** Snapshots the sandbox (`expirationMs` 0 = never expires); auto-resumes a stopped sandbox. */
  snapshot(expirationMs: number): Promise<{ snapshotId: string; sizeBytes: number }>;
  /** Reads a file as a web stream, or `null` when it does not exist; auto-resumes. */
  readFile(path: string): Promise<ReadableStream<Uint8Array> | null>;
  /** Deletes the sandbox. */
  delete(): Promise<void>;
  /** Ids of every snapshot belonging to this sandbox. */
  listSnapshotIds(): Promise<string[]>;
}

/** Everything {@link SandboxApi.create} declares at create time. */
export interface CreateSandboxInput {
  name: string;
  region: Region;
  vcpus: 2 | 4 | 8 | 32;
  ports: number[];
  timeoutMs: number;
  image?: string;
  /** A prebuild snapshot. A git source is never used: the supervisor clones (D19). */
  source?: { type: "snapshot"; snapshotId: string };
  env: Record<string, string>;
  networkPolicy: "allow-all" | { allow: string[] };
  /** At most five tags; `zs` is the one the gc filters on. */
  tags: Record<string, string>;
  /** Default `true`; the devcontainer image builder passes `false` (D35). */
  persistent?: boolean;
  /** Omitted for a builder: the SDK's `0` means "never expires". */
  snapshotExpirationMs?: number;
  /** Omitted for a builder: the SDK's count is 1..10, so "no retention" is expressed by omission. */
  keepLastSnapshots?: number;
}

/** One row of {@link SandboxApi.listByTag}. */
export interface SandboxSummary {
  name: string;
  status: SandboxStatus;
  createdAt: Date;
}

/** The narrow platform interface every step and route handler depends on. */
export interface SandboxApi {
  /**
   * `Sandbox.getOrCreate({ …, resume: true, persistent: true })`. A retried
   * step gets the existing sandbox back (creation params are ignored for an
   * existing name), resumed so it is usable.
   */
  create(input: CreateSandboxInput): Promise<SandboxHandle>;
  /** `Sandbox.get`; `null` when the sandbox does not exist. */
  get(
    name: string,
    opts: { resume: boolean; onResume?: (handle: SandboxHandle) => Promise<void> },
  ): Promise<SandboxHandle | null>;
  /** Every sandbox carrying `tag` (the platform allows a single tag filter). */
  listByTag(tag: Record<string, string>): AsyncIterable<SandboxSummary>;
  /** Deletes a snapshot; a missing snapshot is success. */
  deleteSnapshot(snapshotId: string): Promise<void>;
}

export { SandboxError, type SandboxErrorCode } from "./sandbox-error";

interface ApiErrorJson {
  error?: { code?: string; message?: string };
}

/** The `https://` origin of a declared port, reduced to its hostname. */
export function hostOf(domain: string): string {
  return new URL(domain).host;
}

function errorCodeOf(err: APIError<unknown>): string | undefined {
  const json = err.json as ApiErrorJson | undefined;
  return json?.error?.code;
}

/**
 * Maps an SDK failure onto {@link SandboxError}. `snapshot_not_found` (HTTP
 * 410) becomes `snapshot_expired` and is **not** retryable: the workspace has
 * to be rebuilt. 5xx and 429 without a recognised code are retryable.
 */
export function toSandboxError(err: unknown): SandboxError {
  if (err instanceof SandboxError) return err;
  if (err instanceof APIError) {
    const status = err.response?.status;
    const code = errorCodeOf(err);
    const message = err.message || code || `sandbox api error ${status}`;
    if (code === "image_not_ready" || code === "image_pending") {
      return new SandboxError("image_not_ready", true, message, status);
    }
    if (code === "snapshot_not_found" || status === 410) {
      return new SandboxError("snapshot_expired", false, message, status);
    }
    if (code === "snapshot_region_mismatch") {
      return new SandboxError("snapshot_region_mismatch", false, message, status);
    }
    if (code === "not_found" || status === 404) {
      return new SandboxError("not_found", false, message, status);
    }
    if (status === 402 || status === 429 || code === "quota_exceeded") {
      return new SandboxError("quota", false, message, status);
    }
    const retryable = status !== undefined && status >= 500;
    return new SandboxError("unknown", retryable, message, status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new SandboxError("unknown", false, message);
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toSandboxError(err);
  }
}

class RealSandboxHandle implements SandboxHandle {
  constructor(private readonly sandbox: Sandbox) {}

  get name(): string {
    return this.sandbox.name;
  }

  get status(): SandboxStatus {
    return this.sandbox.status;
  }

  get region(): string {
    return this.sandbox.region;
  }

  get expiresAt(): Date | undefined {
    return this.sandbox.expiresAt;
  }

  get currentSessionId(): string | undefined {
    try {
      return this.sandbox.currentSession().sessionId;
    } catch {
      return undefined;
    }
  }

  domain(port: number): string {
    return this.sandbox.domain(port);
  }

  async runDetached(input: RunInput): Promise<{ cmdId: string }> {
    // `timeoutMs` is enforced by the sandbox at exec time, so it applies to a
    // detached command too: the builder's hard budget lives here (b10 §3.4).
    const command = await call(() =>
      this.sandbox.runCommand({
        cmd: input.cmd,
        args: input.args,
        env: input.env,
        cwd: input.cwd,
        sudo: input.sudo,
        detached: true,
        timeoutMs: input.timeoutMs,
      }),
    );
    return { cmdId: command.cmdId };
  }

  async commandStatus(cmdId: string): Promise<CommandStatus> {
    const command = await call(() => this.sandbox.getCommand(cmdId));
    const exitCode = command.exitCode;
    return { exitCode, running: exitCode === null };
  }

  async run(input: RunInput): Promise<RunResult> {
    const finished = await call(() =>
      this.sandbox.runCommand({
        cmd: input.cmd,
        args: input.args,
        env: input.env,
        cwd: input.cwd,
        sudo: input.sudo,
        timeoutMs: input.timeoutMs,
      }),
    );
    const [stdout, stderr] = await Promise.all([finished.stdout(), finished.stderr()]);
    return { exitCode: finished.exitCode ?? -1, stdout, stderr };
  }

  async waitCommand(cmdId: string, timeoutMs: number): Promise<{ exitCode: number }> {
    const command = await call(() => this.sandbox.getCommand(cmdId));
    const finished = await call(() => command.wait({ signal: AbortSignal.timeout(timeoutMs) }));
    return { exitCode: finished.exitCode ?? -1 };
  }

  async killCommand(cmdId: string, signal: KillSignal): Promise<void> {
    const command = await call(() => this.sandbox.getCommand(cmdId));
    await call(() => command.kill(signal));
  }

  async extendTimeout(ms: number): Promise<void> {
    await call(() => this.sandbox.extendTimeout(ms));
  }

  async stop(): Promise<{ snapshotId?: string; snapshotSizeBytes?: number; usage: SandboxUsage }> {
    const res = await call(() => this.sandbox.stop());
    return {
      snapshotId: res.snapshot?.id,
      snapshotSizeBytes: res.snapshot?.sizeBytes,
      usage: {
        activeCpuDurationMs: res.activeCpuDurationMs ?? 0,
        ingressBytes: res.networkTransfer?.ingress ?? 0,
        egressBytes: res.networkTransfer?.egress ?? 0,
      },
    };
  }

  async snapshot(expirationMs: number): Promise<{ snapshotId: string; sizeBytes: number }> {
    const snap = await call(() => this.sandbox.snapshot({ expiration: expirationMs }));
    return { snapshotId: snap.snapshotId, sizeBytes: snap.sizeBytes };
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array> | null> {
    const stream = await call(() => this.sandbox.readFile({ path }));
    if (!stream) return null;
    return Readable.toWeb(Readable.from(stream)) as ReadableStream<Uint8Array>;
  }

  async delete(): Promise<void> {
    await call(() => this.sandbox.delete());
  }

  async listSnapshotIds(): Promise<string[]> {
    const page = await call(() => this.sandbox.listSnapshots());
    const ids: string[] = [];
    for await (const snapshot of page) ids.push(snapshot.id);
    return ids;
  }
}

class RealSandboxApi implements SandboxApi {
  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const common = {
      name: input.name,
      resume: true,
      persistent: input.persistent ?? true,
      ports: input.ports,
      timeout: input.timeoutMs,
      region: input.region,
      resources: { vcpus: input.vcpus },
      env: input.env,
      networkPolicy: input.networkPolicy,
      tags: input.tags,
      ...(input.snapshotExpirationMs !== undefined ? { snapshotExpiration: input.snapshotExpirationMs } : {}),
      ...(input.keepLastSnapshots !== undefined ? { keepLastSnapshots: { count: input.keepLastSnapshots } } : {}),
    } as const;
    const sandbox = await call(() =>
      input.source
        ? Sandbox.getOrCreate({ ...common, source: input.source })
        : Sandbox.getOrCreate({ ...common, image: input.image }),
    );
    return new RealSandboxHandle(sandbox);
  }

  async get(
    name: string,
    opts: { resume: boolean; onResume?: (handle: SandboxHandle) => Promise<void> },
  ): Promise<SandboxHandle | null> {
    try {
      const sandbox = await Sandbox.get({
        name,
        resume: opts.resume,
        onResume: opts.onResume ? (s: Sandbox) => opts.onResume!(new RealSandboxHandle(s)) : undefined,
      });
      return new RealSandboxHandle(sandbox);
    } catch (err) {
      const mapped = toSandboxError(err);
      if (mapped.code === "not_found") return null;
      throw mapped;
    }
  }

  async *listByTag(tag: Record<string, string>): AsyncIterable<SandboxSummary> {
    const page = await call(() => Sandbox.list({ tags: tag }));
    for await (const sandbox of page) {
      yield { name: sandbox.name, status: sandbox.status, createdAt: new Date(sandbox.createdAt) };
    }
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    try {
      const snapshot = await Snapshot.get({ snapshotId });
      await snapshot.delete();
    } catch (err) {
      const mapped = toSandboxError(err);
      if (mapped.code === "not_found" || mapped.code === "snapshot_expired") return;
      throw mapped;
    }
  }
}

let cached: SandboxApi | null = null;

/**
 * The platform behind the `real` driver: `vercel` (the SDK) or `local`
 * (`ZS_SANDBOX_BACKEND=local`: child processes on this machine, refused in
 * production by {@link localBackendEnabled}).
 */
export function sandboxBackend(): "vercel" | "local" {
  return localBackendEnabled() ? "local" : "vercel";
}

/** `https` for Vercel sandboxes, `http` for the local backend's loopback listeners. */
export function sandboxHttpScheme(): "https" | "http" {
  return sandboxBackend() === "local" ? "http" : "https";
}

/** `wss` for Vercel sandboxes, `ws` for the local backend's loopback rpc listener (D26 `wsUrl`). */
export function sandboxWsScheme(): "wss" | "ws" {
  return sandboxBackend() === "local" ? "ws" : "wss";
}

/** The Vercel SDK or local process backend, memoized per process. */
export function sandboxApi(): SandboxApi {
  if (cached) return cached;
  cached = sandboxBackend() === "local" ? localSandboxApi() : new RealSandboxApi();
  return cached;
}
