/**
 * In-memory {@link SandboxApi} used when `ZS_SANDBOX_DRIVER=fake` (b9 §3.16,
 * §6). It records every call, simulates status transitions and command exits,
 * and scripts the supervisor's `/health` answers that {@link probeHealth}
 * reads. State lives on `globalThis` because `@workflow/vitest` loads the step
 * bundle as a second module instance in the same worker: both instances must
 * see one store.
 */
import type {
  CommandStatus,
  CreateSandboxInput,
  RunInput,
  RunResult,
  SandboxApi,
  SandboxHandle,
  SandboxStatus,
  SandboxSummary,
  SandboxUsage,
  KillSignal,
} from "./sandbox";
import { SandboxError, type SandboxErrorCode } from "./sandbox-error";
import type { HealthProbe } from "./types";

/** One recorded driver call. */
export interface FakeCall {
  method: string;
  args: unknown[];
}

/** A command started inside a fake sandbox. */
export interface FakeCommand {
  cmdId: string;
  cmd: string;
  args: string[];
  env: Record<string, string>;
  /** `null` while the command is still running. */
  exitCode: number | null;
  killedWith: KillSignal | null;
  /** `RunInput.timeoutMs` as the driver received it (the builder's budget, b10 §6.4). */
  timeoutMs: number | undefined;
  cwd: string | undefined;
}

/** A scripted detached command (b10 §6.4): what the fake "runs" when a matching command starts. */
export interface DetachedScript {
  /** Exit code reported once the script has run; `null` keeps the command running. */
  exitCode: number | null;
  /** Called with the command's env right after it starts; the builder test posts status reports from here. */
  run?: (command: FakeCommand) => Promise<void>;
  /**
   * Lands `exitCode` only after this many `waitCommand`/`commandStatus`
   * calls instead of before `runDetached` returns, so a workflow's wait loop
   * observes a *running* command (and whatever `run` posted) first.
   */
  exitAfterPolls?: number;
}

/** One fake sandbox. */
export interface FakeSandboxRecord {
  name: string;
  region: string;
  vcpus: number;
  ports: number[];
  status: SandboxStatus;
  createdAt: number;
  expiresAt: number | null;
  sessionId: string | null;
  env: Record<string, string>;
  tags: Record<string, string>;
  image: string | undefined;
  sourceSnapshotId: string | undefined;
  timeoutMs: number;
  persistent: boolean;
  snapshotExpirationMs: number | undefined;
  keepLastSnapshots: number | undefined;
  networkPolicy: CreateSandboxInput["networkPolicy"];
  snapshotIds: string[];
  commands: Map<string, FakeCommand>;
  files: Map<string, string>;
  usage: SandboxUsage;
  deleted: boolean;
}

interface ScriptedFailure {
  code: SandboxErrorCode;
  remaining: number;
}

interface FakeState {
  sandboxes: Map<string, FakeSandboxRecord>;
  deletedSnapshots: string[];
  calls: FakeCall[];
  failCreate: ScriptedFailure | null;
  failGet: ScriptedFailure | null;
  /** Host (`<name>-<port>.fake.vercel.run`) → scripted probes, the last one repeating. */
  health: Map<string, (HealthProbe | null)[]>;
  /** `"<cmd> <args…>"` prefix → exit code the command reports immediately. */
  commandExits: Map<string, number>;
  /** `"<cmd> <args…>"` prefix → scripted detached command (b10 §6.4). */
  detachedScripts: Map<string, DetachedScript>;
  /** Command id → the exit that lands after `polls` more `waitCommand`/`commandStatus` calls. */
  pendingExits: Map<string, { exitCode: number; polls: number }>;
  seq: number;
}

const STATE_KEY = "__zsFakeSandbox" as const;
type GlobalWithFake = typeof globalThis & { [STATE_KEY]?: FakeState };

function freshState(): FakeState {
  return {
    sandboxes: new Map(),
    deletedSnapshots: [],
    calls: [],
    failCreate: null,
    failGet: null,
    health: new Map(),
    commandExits: new Map(),
    detachedScripts: new Map(),
    pendingExits: new Map(),
    seq: 0,
  };
}

function state(): FakeState {
  const g = globalThis as GlobalWithFake;
  if (!g[STATE_KEY]) g[STATE_KEY] = freshState();
  return g[STATE_KEY];
}

function record(method: string, ...args: unknown[]): void {
  state().calls.push({ method, args });
}

function nextId(prefix: string): string {
  const s = state();
  s.seq += 1;
  return `${prefix}_${s.seq.toString().padStart(4, "0")}`;
}

function retryableCode(code: SandboxErrorCode): boolean {
  return code === "image_not_ready";
}

function consume(failure: ScriptedFailure | null): { fire: boolean; next: ScriptedFailure | null } {
  if (!failure || failure.remaining <= 0) return { fire: false, next: null };
  const remaining = failure.remaining - 1;
  return { fire: true, next: remaining > 0 ? { ...failure, remaining } : null };
}

/** `https://<name>-<port>.fake.vercel.run`, the fake's stand-in for `sandbox.domain(port)`. */
export function fakeDomain(name: string, port: number): string {
  return `https://${name}-${port}.fake.vercel.run`;
}

class FakeHandle implements SandboxHandle {
  constructor(private readonly row: FakeSandboxRecord) {}

  get name(): string {
    return this.row.name;
  }

  get status(): SandboxStatus {
    return this.row.status;
  }

  get region(): string {
    return this.row.region;
  }

  get expiresAt(): Date | undefined {
    return this.row.expiresAt === null ? undefined : new Date(this.row.expiresAt);
  }

  get currentSessionId(): string | undefined {
    return this.row.sessionId ?? undefined;
  }

  domain(port: number): string {
    if (!this.row.ports.includes(port)) {
      throw new Error(`fake sandbox ${this.row.name}: port ${port} has no route`);
    }
    return fakeDomain(this.row.name, port);
  }

  private start(input: RunInput, detached: boolean): FakeCommand {
    const cmdId = nextId("cmd");
    const key = [input.cmd, ...input.args].join(" ");
    let exitCode: number | null = detached ? null : 0;
    for (const [prefix, code] of state().commandExits) {
      if (key.startsWith(prefix)) exitCode = code;
    }
    const command: FakeCommand = {
      cmdId,
      cmd: input.cmd,
      args: input.args,
      env: input.env ?? {},
      exitCode,
      killedWith: null,
      timeoutMs: input.timeoutMs,
      cwd: input.cwd,
    };
    this.row.commands.set(cmdId, command);
    return command;
  }

  async runDetached(input: RunInput): Promise<{ cmdId: string }> {
    record("runDetached", this.row.name, input);
    const command = this.start(input, true);
    const key = [input.cmd, ...input.args].join(" ");
    for (const [prefix, script] of state().detachedScripts) {
      if (!key.startsWith(prefix)) continue;
      // The script "runs" the command: it may post to the control plane before the exit code lands.
      const finish = async () => {
        try {
          await script.run?.(command);
        } finally {
          if (script.exitCode !== null) {
            if (script.exitAfterPolls && script.exitAfterPolls > 0) {
              state().pendingExits.set(command.cmdId, { exitCode: script.exitCode, polls: script.exitAfterPolls });
            } else {
              command.exitCode = script.exitCode;
            }
          }
        }
      };
      await finish();
    }
    return { cmdId: command.cmdId };
  }

  /** One poll of a command whose scripted exit lands after N polls. */
  private tick(command: FakeCommand): void {
    const pending = state().pendingExits.get(command.cmdId);
    if (!pending) return;
    pending.polls -= 1;
    if (pending.polls <= 0) {
      command.exitCode = pending.exitCode;
      state().pendingExits.delete(command.cmdId);
    }
  }

  async commandStatus(cmdId: string): Promise<CommandStatus> {
    record("commandStatus", this.row.name, cmdId);
    const command = this.row.commands.get(cmdId);
    if (!command) throw new SandboxError("not_found", false, `no command ${cmdId}`);
    this.tick(command);
    return { exitCode: command.exitCode, running: command.exitCode === null };
  }

  async run(input: RunInput): Promise<RunResult> {
    record("run", this.row.name, input);
    const command = this.start(input, false);
    return { exitCode: command.exitCode ?? 0, stdout: "", stderr: "" };
  }

  async waitCommand(cmdId: string, timeoutMs: number): Promise<{ exitCode: number }> {
    record("waitCommand", this.row.name, cmdId, timeoutMs);
    const command = this.row.commands.get(cmdId);
    if (!command) throw new SandboxError("not_found", false, `no command ${cmdId}`);
    this.tick(command);
    if (command.exitCode === null) throw new SandboxError("unknown", false, "wait timed out");
    return { exitCode: command.exitCode };
  }

  async killCommand(cmdId: string, signal: KillSignal): Promise<void> {
    record("killCommand", this.row.name, cmdId, signal);
    const command = this.row.commands.get(cmdId);
    if (command) command.killedWith = signal;
  }

  async extendTimeout(ms: number): Promise<void> {
    record("extendTimeout", this.row.name, ms);
    this.row.expiresAt = (this.row.expiresAt ?? Date.now()) + ms;
  }

  async updatePorts(ports: number[]): Promise<void> {
    record("updatePorts", this.row.name, ports);
    this.row.ports = [...ports];
  }

  async stop(): Promise<{ snapshotId?: string; snapshotSizeBytes?: number; usage: SandboxUsage }> {
    record("stop", this.row.name);
    if (this.row.status === "stopped") return { usage: { ...this.row.usage } };
    const snapshotId = nextId("snap");
    this.row.snapshotIds.push(snapshotId);
    this.row.status = "stopped";
    this.row.expiresAt = null;
    this.row.sessionId = null;
    return { snapshotId, snapshotSizeBytes: 32_000_000, usage: { ...this.row.usage } };
  }

  async snapshot(expirationMs: number): Promise<{ snapshotId: string; sizeBytes: number }> {
    record("snapshot", this.row.name, expirationMs);
    const snapshotId = nextId("snap");
    this.row.snapshotIds.push(snapshotId);
    this.row.status = "stopped";
    return { snapshotId, sizeBytes: 32_000_000 };
  }

  async readFile(path: string): Promise<ReadableStream<Uint8Array> | null> {
    record("readFile", this.row.name, path);
    const contents = this.row.files.get(path) ?? `fake:${this.row.name}:${path}`;
    const bytes = new TextEncoder().encode(contents);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }

  async delete(): Promise<void> {
    record("delete", this.row.name);
    this.row.deleted = true;
    state().sandboxes.delete(this.row.name);
  }

  async listSnapshotIds(): Promise<string[]> {
    record("listSnapshotIds", this.row.name);
    return [...this.row.snapshotIds];
  }
}

class FakeSandboxApi implements SandboxApi {
  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    record("create", input);
    const s = state();
    const failure = consume(s.failCreate);
    if (failure.fire) {
      const code = s.failCreate!.code;
      s.failCreate = failure.next;
      throw new SandboxError(code, retryableCode(code), `fake create failure: ${code}`);
    }
    const existing = s.sandboxes.get(input.name);
    if (existing) {
      existing.status = "running";
      existing.sessionId = existing.sessionId ?? nextId("ses");
      existing.expiresAt = Date.now() + input.timeoutMs;
      return new FakeHandle(existing);
    }
    const row: FakeSandboxRecord = {
      name: input.name,
      region: input.region,
      vcpus: input.vcpus,
      ports: [...input.ports],
      status: "running",
      createdAt: Date.now(),
      expiresAt: Date.now() + input.timeoutMs,
      sessionId: nextId("ses"),
      env: { ...input.env },
      tags: { ...input.tags },
      image: input.image,
      sourceSnapshotId: input.source?.snapshotId,
      timeoutMs: input.timeoutMs,
      persistent: input.persistent ?? true,
      snapshotExpirationMs: input.snapshotExpirationMs,
      keepLastSnapshots: input.keepLastSnapshots,
      networkPolicy: input.networkPolicy,
      snapshotIds: [],
      commands: new Map(),
      files: new Map(),
      usage: { activeCpuDurationMs: 0, ingressBytes: 0, egressBytes: 0 },
      deleted: false,
    };
    s.sandboxes.set(row.name, row);
    return new FakeHandle(row);
  }

  async get(
    name: string,
    opts: { resume: boolean; onResume?: (handle: SandboxHandle) => Promise<void> },
  ): Promise<SandboxHandle | null> {
    record("get", name, { resume: opts.resume, onResume: Boolean(opts.onResume) });
    const s = state();
    const failure = consume(s.failGet);
    if (failure.fire) {
      const code = s.failGet!.code;
      s.failGet = failure.next;
      if (code === "not_found") {
        s.failGet = failure.next;
        return null;
      }
      throw new SandboxError(code, retryableCode(code), `fake get failure: ${code}`);
    }
    const row = s.sandboxes.get(name);
    if (!row) return null;
    const handle = new FakeHandle(row);
    if (opts.resume && row.status !== "running") {
      row.status = "running";
      row.sessionId = nextId("ses");
      row.expiresAt = Date.now() + row.timeoutMs;
      if (opts.onResume) await opts.onResume(handle);
    }
    return handle;
  }

  async *listByTag(tag: Record<string, string>): AsyncIterable<SandboxSummary> {
    record("listByTag", tag);
    const [key, value] = Object.entries(tag)[0] ?? [];
    for (const row of state().sandboxes.values()) {
      if (key !== undefined && row.tags[key] !== value) continue;
      yield { name: row.name, status: row.status, createdAt: new Date(row.createdAt) };
    }
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    record("deleteSnapshot", snapshotId);
    state().deletedSnapshots.push(snapshotId);
    for (const row of state().sandboxes.values()) {
      row.snapshotIds = row.snapshotIds.filter((id) => id !== snapshotId);
    }
  }
}

/** The scripting surface tests use to drive the fake. */
export interface FakeSandboxControl {
  /** Every recorded call, oldest first. */
  readonly calls: FakeCall[];
  /** The recorded calls of one method. */
  callsOf(method: string): FakeCall[];
  /** The fake sandbox with this name, if it exists. */
  sandbox(name: string): FakeSandboxRecord | undefined;
  /** Every live fake sandbox. */
  sandboxes(): FakeSandboxRecord[];
  /** Ids passed to `deleteSnapshot`. */
  deletedSnapshots(): string[];
  /** Makes the next `times` `create` calls fail with `code`. */
  failNextCreateWith(code: SandboxErrorCode, times?: number): void;
  /** Makes the next `times` `get` calls fail with `code` (`not_found` returns `null`). */
  failNextGetWith(code: SandboxErrorCode, times?: number): void;
  /**
   * Scripts `GET https://<host>/health`. An array is consumed one probe per
   * call with the last entry repeating; `null` means "unreachable".
   */
  setHealth(host: string, probe: HealthProbe | (HealthProbe | null)[] | null): void;
  /** Next scripted probe for `host` (consumed by `probeHealth`). */
  takeHealth(host: string): HealthProbe | null;
  /** Every command started so far, across sandboxes. */
  commands(): FakeCommand[];
  /** A command whose `"<cmd> <args…>"` starts with `prefix` exits with `exitCode` immediately. */
  scriptCommandExit(prefix: string, exitCode: number): void;
  /** Removes a scripted exit so later commands of that prefix stay running (detached) or exit 0 (run). */
  clearCommandExit(prefix: string): void;
  /**
   * Scripts a detached command whose `"<cmd> <args…>"` starts with `prefix`
   * (b10 §6.4): `run` is awaited right after the command starts (the builder
   * test posts its status reports there), then `exitCode` lands unless `null`.
   */
  scriptDetachedCommand(prefix: string, script: DetachedScript): void;
  /** Marks an already-started command as exited. */
  exitCommand(cmdId: string, exitCode: number): void;
  /** Seeds a file `readFile` will return. */
  setFile(name: string, path: string, contents: string): void;
  /** Sets the usage `stop()` reports for a sandbox. */
  setUsage(name: string, usage: SandboxUsage): void;
  /** Forces a sandbox's session status. */
  setStatus(name: string, status: SandboxStatus): void;
  /** Sets when the running session expires (unix ms). */
  setExpiresAt(name: string, at: number | null): void;
  /** Inserts a sandbox that the control plane did not create (gc orphan tests). */
  seedSandbox(name: string, patch?: Partial<FakeSandboxRecord>): FakeSandboxRecord;
  /** Empties every map and counter. */
  reset(): void;
}

/** The fake's scripting surface, shared through `globalThis`. */
export function fakeSandbox(): FakeSandboxControl {
  return {
    get calls() {
      return state().calls;
    },
    callsOf(method) {
      return state().calls.filter((call) => call.method === method);
    },
    sandbox(name) {
      return state().sandboxes.get(name);
    },
    sandboxes() {
      return [...state().sandboxes.values()];
    },
    deletedSnapshots() {
      return [...state().deletedSnapshots];
    },
    failNextCreateWith(code, times = 1) {
      state().failCreate = { code, remaining: times };
    },
    failNextGetWith(code, times = 1) {
      state().failGet = { code, remaining: times };
    },
    setHealth(host, probe) {
      state().health.set(host, Array.isArray(probe) ? [...probe] : [probe]);
    },
    takeHealth(host) {
      const queue = state().health.get(host);
      if (!queue || queue.length === 0) return null;
      return queue.length === 1 ? queue[0] : (queue.shift() ?? null);
    },
    commands() {
      return [...state().sandboxes.values()].flatMap((row) => [...row.commands.values()]);
    },
    scriptCommandExit(prefix, exitCode) {
      state().commandExits.set(prefix, exitCode);
    },
    clearCommandExit(prefix) {
      state().commandExits.delete(prefix);
    },
    scriptDetachedCommand(prefix, script) {
      state().detachedScripts.set(prefix, script);
    },
    exitCommand(cmdId, exitCode) {
      for (const row of state().sandboxes.values()) {
        const command = row.commands.get(cmdId);
        if (command) command.exitCode = exitCode;
      }
    },
    setFile(name, path, contents) {
      state().sandboxes.get(name)?.files.set(path, contents);
    },
    setUsage(name, usage) {
      const row = state().sandboxes.get(name);
      if (row) row.usage = { ...usage };
    },
    setStatus(name, status) {
      const row = state().sandboxes.get(name);
      if (row) row.status = status;
    },
    setExpiresAt(name, at) {
      const row = state().sandboxes.get(name);
      if (row) row.expiresAt = at;
    },
    seedSandbox(name, patch = {}) {
      const row: FakeSandboxRecord = {
        name,
        region: "iad1",
        vcpus: 2,
        ports: [],
        status: "running",
        createdAt: Date.now(),
        expiresAt: null,
        sessionId: nextId("ses"),
        env: {},
        tags: {},
        image: undefined,
        sourceSnapshotId: undefined,
        timeoutMs: 3_600_000,
        persistent: true,
        snapshotExpirationMs: 0,
        keepLastSnapshots: 1,
        networkPolicy: "allow-all",
        snapshotIds: [],
        commands: new Map(),
        files: new Map(),
        usage: { activeCpuDurationMs: 0, ingressBytes: 0, egressBytes: 0 },
        deleted: false,
        ...patch,
      };
      state().sandboxes.set(name, row);
      return row;
    },
    reset() {
      (globalThis as GlobalWithFake)[STATE_KEY] = freshState();
    },
  };
}

let instance: SandboxApi | null = null;

/** The fake driver instance (`ZS_SANDBOX_DRIVER=fake`). */
export function fakeSandboxApi(): SandboxApi {
  if (!instance) instance = new FakeSandboxApi();
  return instance;
}
