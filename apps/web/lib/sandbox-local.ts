/**
 * The local sandbox backend (`ZS_SANDBOX_BACKEND=local`, never in production):
 * the same {@link SandboxApi} the workflows drive against `@vercel/sandbox`,
 * backed by child processes on this machine. One directory per sandbox under
 * `ZS_LOCAL_ROOT` (default `$TMPDIR/zs-local/<name>`) plays the VM:
 *
 * ```
 * <root>/<name>/
 *   sandbox.json     the record below (ports, status, commands, snapshots)
 *   workspaces/      ZS_WORKSPACES_DIR – the checkout lands in workspaces/<repo>
 *   home/            HOME (settings, the server data dir, git config); `vercel` -> home
 *   state/           ZS_STATE_DIR (run/, markers/, jwt/)
 *   tmp/             /tmp of the "VM" (the rebuild archive is written here)
 *   logs/            stdout+stderr of every detached command
 *   snapshots/       <id>.tgz produced by stop() and snapshot()
 * ```
 *
 * `create` allocates free loopback ports for the D21 infrastructure set and
 * records them; `runDetached({ cmd: "zs-agent" })` spawns the supervisor binary
 * with `ZS_LOCAL=1` and the listener overrides that map the declared ports onto
 * the allocated ones; the supervisor in turn spawns `zed-remote-server serve`.
 * `domain(port)` answers `http://127.0.0.1:<allocated>` (`lib/connect.ts` picks
 * `ws://` for the rpc port). `stop` SIGTERMs the supervisor, waits for it and
 * everything it spawned, then tars the directory; a resume restores the
 * snapshot when the live directory is gone.
 *
 * The second half of the module is the `local/<name>` repository provider the
 * GitHub seams in `lib/github.ts` delegate to: repositories under
 * `ZS_LOCAL_REPOS_DIR` are registered through the ordinary `POST /api/repos`
 * / `POST /api/workspaces` paths (owner `local`, installation
 * {@link LOCAL_INSTALLATION_ID}) and cloned by the supervisor from a `file://`
 * URL, so no GitHub App is needed.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ApiError } from "./api";
import { dbReady } from "./db";
import { env, EnvError, INFRA_PORT_MAX, INFRA_PORT_MIN, proxySlots } from "./env";
import type { InstallationRepo, RefRequest, ResolvedRef } from "./github";
import { closeRpcProxy, ensureRpcProxy } from "./local-rpc-proxy";
import type {
  CreateSandboxInput,
  KillSignal,
  RunInput,
  RunResult,
  SandboxApi,
  SandboxHandle,
  SandboxStatus,
  SandboxSummary,
  SandboxUsage,
} from "./sandbox";
import { SandboxError } from "./sandbox-error";
import { githubInstallations } from "./schema";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * True when `ZS_SANDBOX_BACKEND=local`. Fails closed: the backend is refused
 * (thrown) in a production build, whatever the variable says.
 */
export function localBackendEnabled(): boolean {
  const e = env();
  if (e.ZS_SANDBOX_BACKEND !== "local") return false;
  if (e.NODE_ENV === "production" || process.env.NODE_ENV === "production") {
    throw new EnvError(["ZS_SANDBOX_BACKEND"], "ZS_SANDBOX_BACKEND=local is refused in a production build");
  }
  return true;
}

/** The monorepo root (`apps/web` is the working directory of `next dev`). */
function repoRoot(): string {
  return path.resolve(process.cwd(), "..", "..");
}

/** Parent directory of every local sandbox (`ZS_LOCAL_ROOT`, default `$TMPDIR/zs-local`). */
export function localRoot(): string {
  return path.resolve(env().ZS_LOCAL_ROOT ?? path.join(os.tmpdir(), "zs-local"));
}

/** Directory whose subdirectories are the `local/<name>` repositories (`ZS_LOCAL_REPOS_DIR`). */
export function localReposDir(): string {
  return path.resolve(env().ZS_LOCAL_REPOS_DIR ?? path.join(localRoot(), "repos"));
}

/** The `zs-agent` binary (`ZS_AGENT_BIN`). */
export function agentBin(): string {
  return env().ZS_AGENT_BIN ?? path.join(repoRoot(), "sandbox", "supervisor", "target", "debug", "zs-agent");
}

/**
 * The `zed-remote-server` binary the supervisor spawns (`ZS_SERVE_BIN`). The
 * `remote_server` crate names its binary `remote_server`; the image installs
 * it as `zed-remote-server`, so both spellings under `zed/target/debug` count.
 */
export function serveBin(): string {
  const configured = env().ZS_SERVE_BIN;
  if (configured) return configured;
  const debug = path.join(repoRoot(), "zed", "target", "debug");
  const candidates = [path.join(debug, "zed-remote-server"), path.join(debug, "remote_server")];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

// ---------------------------------------------------------------------------
// The on-disk record
// ---------------------------------------------------------------------------

/** One detached or finished command of a local sandbox. */
export interface LocalCommandRecord {
  cmdId: string;
  cmd: string;
  args: string[];
  /** Process id; the process group id is the same (the child is spawned detached). */
  pid: number;
  startedAt: number;
  /** `null` while running (or while the exit is unknown after a control-plane restart). */
  exitCode: number | null;
  /** Where stdout and stderr were appended. */
  logFile: string;
}

/** `sandbox.json`. */
export interface LocalSandboxRecord {
  version: 1;
  name: string;
  region: string;
  vcpus: number;
  /** Every declared port (the create-time list plus `updatePorts`). */
  ports: number[];
  /** Declared port → allocated loopback port (only the D21 infrastructure set is remapped). */
  portMap: Record<string, number>;
  /** Allocated loopback ports for the two listeners that are never declared (D21 8450/8451). */
  internal: { localApi: number; control: number };
  /**
   * `ZS_LOCAL_RPC_PROXY=1`: the loopback port `domain(ZS_RPC_PORT)` answers, a TCP proxy in
   * front of the rpc listener (`lib/local-rpc-proxy.ts`) so the browser end-to-end suite can
   * sever live connections. Absent on records created without the proxy.
   */
  rpcProxyPort?: number;
  status: SandboxStatus;
  createdAt: number;
  /** Start of the current "VM session" (unix ms), `null` while stopped. */
  startedAt: number | null;
  expiresAt: number | null;
  sessionId: string | null;
  sessionSeq: number;
  timeoutMs: number;
  image: string | undefined;
  sourceSnapshotId: string | undefined;
  /** Identity env of `Sandbox.create` (`ZS_WORKSPACE_ID`, `ZS_SANDBOX_NAME`, `ZS_REGION`). */
  env: Record<string, string>;
  tags: Record<string, string>;
  networkPolicy: CreateSandboxInput["networkPolicy"];
  persistent: boolean;
  snapshotExpirationMs: number | null;
  /** `null` = keep every snapshot (a builder passes no retention). */
  keepLastSnapshots: number | null;
  snapshotIds: string[];
  commands: Record<string, LocalCommandRecord>;
  cmdSeq: number;
}

const RECORD_FILE = "sandbox.json";

function sandboxDir(name: string): string {
  return path.join(localRoot(), name);
}

/** `<ZS_LOCAL_ROOT>/<name>`: the directory that plays the VM of sandbox `name`. */
export function localSandboxDir(name: string): string {
  return sandboxDir(name);
}

/** True when `ZS_LOCAL_RPC_PROXY=1` (and the local backend is on). */
export function localRpcProxyEnabled(): boolean {
  return localBackendEnabled() && env().ZS_LOCAL_RPC_PROXY === "1";
}

function recordPath(name: string): string {
  return path.join(sandboxDir(name), RECORD_FILE);
}

function readRecord(name: string): LocalSandboxRecord | null {
  try {
    const raw = fs.readFileSync(recordPath(name), "utf8");
    const parsed = JSON.parse(raw) as LocalSandboxRecord;
    return parsed.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

/** Atomic (tmp + rename) synchronous write; every mutation is a read-modify-write in one turn. */
function writeRecord(record: LocalSandboxRecord): void {
  const file = recordPath(record.name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
}

function requireRecord(name: string): LocalSandboxRecord {
  const record = readRecord(name);
  if (!record) throw new SandboxError("not_found", false, `local sandbox ${name} does not exist`);
  return record;
}

/** Every record under the root, oldest first. */
function allRecords(): LocalSandboxRecord[] {
  const root = localRoot();
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const records: LocalSandboxRecord[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const record = readRecord(entry.name);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function isInfraRange(port: number): boolean {
  return port >= INFRA_PORT_MIN && port <= INFRA_PORT_MAX;
}

/** Ports handed out in this process but possibly not yet bound by their supervisor. */
const reservedInProcess = new Set<number>();

function portsInUseByRecords(): Set<number> {
  const used = new Set<number>(reservedInProcess);
  for (const record of allRecords()) {
    for (const port of Object.values(record.portMap)) used.add(port);
    used.add(record.internal.localApi);
    used.add(record.internal.control);
    if (record.rpcProxyPort !== undefined) used.add(record.rpcProxyPort);
  }
  return used;
}

function bindFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port"))));
    });
  });
}

/** A free loopback port that no other local sandbox has recorded. */
async function allocatePort(taken: Set<number>): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const port = await bindFreePort();
    if (taken.has(port) || isInfraRange(port)) continue;
    taken.add(port);
    reservedInProcess.add(port);
    return port;
  }
  throw new SandboxError("unknown", false, "could not allocate a free loopback port");
}

/**
 * Maps the declared ports: the D21 infrastructure set (rpc, proxy slots,
 * health) onto fresh loopback ports, everything else (the forward pool, public
 * forwards) onto itself — a user process binds the real port on this machine.
 */
async function allocatePortMap(
  declared: number[],
  existing: Record<string, number>,
  taken: Set<number>,
): Promise<Record<string, number>> {
  const map: Record<string, number> = { ...existing };
  for (const port of declared) {
    if (map[String(port)] !== undefined) continue;
    map[String(port)] = isInfraRange(port) ? await allocatePort(taken) : port;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Processes
// ---------------------------------------------------------------------------

interface LiveCommand {
  child: ChildProcess;
  exit: Promise<number>;
}

const LIVE_KEY = "__zsLocalSandboxLive" as const;
type GlobalWithLive = typeof globalThis & { [LIVE_KEY]?: Map<string, LiveCommand> };

/** Children started by this process, keyed `<sandbox>/<cmdId>`; on `globalThis` like the other stores. */
function liveCommands(): Map<string, LiveCommand> {
  const g = globalThis as GlobalWithLive;
  if (!g[LIVE_KEY]) g[LIVE_KEY] = new Map();
  return g[LIVE_KEY];
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    // Not a group leader (or already gone): fall back to the pid itself.
  }
  try {
    process.kill(pid, signal);
  } catch {
    // Already exited.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until `pid` is gone or `timeoutMs` elapses; true when it exited. */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() >= deadline) return false;
    await sleep(200);
  }
  return true;
}

/** Program names (argv[0] basenames) a sandbox directory may own on this machine. */
function ownedProgramNames(): Set<string> {
  return new Set([
    path.basename(agentBin()),
    path.basename(serveBin()),
    "zs-agent",
    "zed-remote-server",
    "remote_server",
    // The supervisor's helpers and lifecycle commands that name the directory in their argv.
    "sh",
    "bash",
    "git",
    "tar",
  ]);
}

/** The supervisor's pid from `<dir>/state/run/zs-agent.pid` (written at boot), when that process is alive. */
function supervisorPidFromFile(dir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(dir, "state", "run", "zs-agent.pid"), "utf8").trim());
    return Number.isInteger(pid) && pid > 1 && pidAlive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pids of the sandbox's processes beyond the command records: the supervisor
 * from its pid file (its argv is `<zs-agent> start`; the directory is only in
 * its environment, which `pgrep -f` cannot see), then every process whose
 * command line names a path inside `dir` *and* whose program is one of ours
 * (the server: `--workspace-root <dir>/…`, `--control-secret-file <dir>/…`;
 * `git`/`tar`/`sh` helpers). The program filter keeps a developer's
 * `tail -f <dir>/logs/…` or an editor opened on the checkout out of the kill
 * set. `pgrep -f` exits 1 when nothing matches.
 */
async function sandboxPids(dir: string): Promise<number[]> {
  const pids = new Set<number>();
  const supervisor = supervisorPidFromFile(dir);
  if (supervisor !== null) pids.add(supervisor);
  let candidates: number[] = [];
  try {
    const { stdout } = await execFileAsync("pgrep", ["-f", `${escapeRegExp(dir)}/`]);
    candidates = stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
  } catch {
    candidates = [];
  }
  if (candidates.length > 0) {
    const owned = ownedProgramNames();
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "pid=,comm=", "-p", candidates.join(",")]);
      for (const line of stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (match && owned.has(path.basename(match[2].trim()))) pids.add(Number(match[1]));
      }
    } catch {
      // Every candidate exited between the two calls.
    }
  }
  return [...pids];
}

/** Environment every child of a local sandbox inherits from this process. */
function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["PATH", "SHELL", "USER", "LANG", "LC_ALL", "TERM", "SSH_AUTH_SOCK"]) {
    const value = process.env[key];
    if (value) out[key] = value;
  }
  if (!out.PATH) out.PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
  if (!out.SHELL) out.SHELL = "/bin/sh";
  if (!out.USER) out.USER = os.userInfo().username;
  if (!out.LANG) out.LANG = "en_US.UTF-8";
  return out;
}

/**
 * The `zs-agent` environment for one sandbox: `ZS_LOCAL=1`, the directory
 * layout, the server binary and the listener overrides that put every D21
 * port on its allocated loopback port. The caller layers the control plane's
 * `runCommand` env (`ZS_CONTROL_URL`, `ZS_SANDBOX_TOKEN`, …) on top.
 */
function supervisorEnv(record: LocalSandboxRecord, dir: string): Record<string, string> {
  const e = env();
  const mapped = (port: number): number => record.portMap[String(port)] ?? port;
  const home = path.join(dir, "home");
  return {
    ...inheritedEnv(),
    ...record.env,
    ZS_LOCAL: "1",
    HOME: home,
    TMPDIR: path.join(dir, "tmp"),
    ZS_WORKSPACES_DIR: path.join(dir, "workspaces"),
    ZS_STATE_DIR: path.join(dir, "state"),
    ZS_DATA_DIR: path.join(home, ".local", "share", "zed"),
    ZS_SERVER_BIN: serveBin(),
    ZS_BUILD_ID: e.ZS_SERVER_BUILD_ID ?? "dev",
    ZS_RPC_LISTEN: `127.0.0.1:${mapped(e.ZS_RPC_PORT)}`,
    ZS_HEALTH_LISTEN: `127.0.0.1:${mapped(e.ZS_HEALTH_PORT)}`,
    ZS_LOCAL_API_LISTEN: `127.0.0.1:${record.internal.localApi}`,
    ZS_SERVER_CONTROL_LISTEN: `127.0.0.1:${record.internal.control}`,
    ZS_PROXY_BIND_IP: "127.0.0.1",
    ZS_PROXY_SLOTS: proxySlots()
      .map((slot) => String(mapped(slot)))
      .join(","),
    ZS_INSECURE_COOKIES: "1",
    RUST_LOG: process.env.RUST_LOG ?? "info",
  };
}

/**
 * Sandbox paths → local paths: `/` is the sandbox directory (so D9's
 * `tar -C / workspaces vercel/.local/share/zed` archives the right trees
 * through the `vercel -> home` link), `/tmp`, `/workspaces` and `/vercel` are
 * the matching subdirectories. Anything else is left alone.
 */
export function mapSandboxPath(dir: string, p: string): string {
  if (p === "/") return dir;
  for (const [prefix, target] of [
    ["/tmp", "tmp"],
    ["/workspaces", "workspaces"],
    ["/vercel", "home"],
  ] as const) {
    if (p === prefix || p.startsWith(`${prefix}/`)) return path.join(dir, target, p.slice(prefix.length));
  }
  return p;
}

/** The program and leading arguments a sandbox command name resolves to on this machine. */
function resolveProgram(cmd: string): { program: string; prefix: string[] } {
  if (cmd === "zs-agent") return { program: agentBin(), prefix: [] };
  if (cmd === "sha256sum" && process.platform === "darwin") return { program: "shasum", prefix: ["-a", "256"] };
  return { program: cmd, prefix: [] };
}

// ---------------------------------------------------------------------------
// The handle
// ---------------------------------------------------------------------------

const ZERO: SandboxUsage = { activeCpuDurationMs: 0, ingressBytes: 0, egressBytes: 0 };

class LocalHandle implements SandboxHandle {
  constructor(readonly name: string) {}

  private record(): LocalSandboxRecord {
    return requireRecord(this.name);
  }

  private dir(): string {
    return sandboxDir(this.name);
  }

  get status(): SandboxStatus {
    return this.record().status;
  }

  get region(): string {
    return this.record().region;
  }

  get expiresAt(): Date | undefined {
    const at = this.record().expiresAt;
    return at === null ? undefined : new Date(at);
  }

  get currentSessionId(): string | undefined {
    return this.record().sessionId ?? undefined;
  }

  domain(port: number): string {
    const record = this.record();
    const mapped = record.portMap[String(port)];
    if (mapped === undefined) throw new Error(`local sandbox ${this.name}: port ${port} was not declared`);
    if (port === env().ZS_RPC_PORT && localRpcProxyEnabled() && record.rpcProxyPort !== undefined) {
      // `domain()` is synchronous; the bind completes on the next ticks, well before a client
      // dials (the caller records the host, then polls health for seconds). A bind failure is
      // logged by the proxy module and surfaces as a refused client connection.
      ensureRpcProxy(this.name, record.rpcProxyPort, mapped).catch(() => undefined);
      return `http://127.0.0.1:${record.rpcProxyPort}`;
    }
    return `http://127.0.0.1:${mapped}`;
  }

  /** Command line, environment and working directory for `input`, sandbox paths mapped. */
  private prepare(input: RunInput): { program: string; args: string[]; env: Record<string, string>; cwd: string } {
    const record = this.record();
    const dir = this.dir();
    const { program, prefix } = resolveProgram(input.cmd);
    const args = [...prefix, ...input.args.map((arg) => mapSandboxPath(dir, arg))];
    const base = input.cmd === "zs-agent" ? supervisorEnv(record, dir) : { ...inheritedEnv(), ...record.env };
    const cwd = input.cwd ? mapSandboxPath(dir, input.cwd) : path.join(dir, "workspaces");
    fs.mkdirSync(cwd, { recursive: true });
    return { program, args, env: { ...base, ...(input.env ?? {}) }, cwd };
  }

  async runDetached(input: RunInput): Promise<{ cmdId: string }> {
    const record = this.record();
    if (record.status !== "running") {
      throw new SandboxError("unknown", false, `local sandbox ${this.name} is ${record.status}`);
    }
    const { program, args, env: childEnv, cwd } = this.prepare(input);
    record.cmdSeq += 1;
    const cmdId = `lcmd_${record.cmdSeq.toString().padStart(4, "0")}`;
    const logsDir = path.join(this.dir(), "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `${cmdId}-${input.cmd.replace(/[^A-Za-z0-9_.-]/g, "_")}.log`);
    const fd = fs.openSync(logFile, "a");
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd,
        env: childEnv as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
    } finally {
      fs.closeSync(fd);
    }
    const pid = child.pid;
    if (!pid) {
      throw new SandboxError("unknown", false, `could not start ${program}`);
    }
    child.unref();
    const name = this.name;
    // The SDK enforces `timeoutMs` at exec time for a detached command too (the builder's hard
    // budget, b10 §3.4); the local backend mirrors it with a group kill.
    const timer = input.timeoutMs !== undefined ? setTimeout(() => signalGroup(pid, "SIGKILL"), input.timeoutMs) : null;
    timer?.unref();
    const exit = new Promise<number>((resolve) => {
      child.once("exit", (code, signal) => {
        if (timer) clearTimeout(timer);
        const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : -1);
        const current = readRecord(name);
        if (current?.commands[cmdId]) {
          current.commands[cmdId].exitCode = exitCode;
          writeRecord(current);
        }
        liveCommands().delete(`${name}/${cmdId}`);
        resolve(exitCode);
      });
      child.once("error", () => {
        if (timer) clearTimeout(timer);
        liveCommands().delete(`${name}/${cmdId}`);
        resolve(-1);
      });
    });
    liveCommands().set(`${name}/${cmdId}`, { child, exit });
    record.commands[cmdId] = { cmdId, cmd: input.cmd, args: input.args, pid, startedAt: Date.now(), exitCode: null, logFile };
    writeRecord(record);
    return { cmdId };
  }

  async run(input: RunInput): Promise<RunResult> {
    const { program, args, env: childEnv, cwd } = this.prepare(input);
    return new Promise<RunResult>((resolve, reject) => {
      const child: ChildProcess = spawn(program, args, {
        cwd,
        env: childEnv as NodeJS.ProcessEnv,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
      const pid = child.pid;
      const timer =
        input.timeoutMs !== undefined && pid ? setTimeout(() => signalGroup(pid, "SIGKILL"), input.timeoutMs) : null;
      child.once("error", (err: Error) => {
        if (timer) clearTimeout(timer);
        reject(new SandboxError("unknown", false, `${program}: ${err.message}`));
      });
      child.once("exit", (code: number | null, signal: NodeJS.Signals | null) => {
        if (timer) clearTimeout(timer);
        resolve({
          exitCode: code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : -1),
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      });
    });
  }

  async waitCommand(cmdId: string, timeoutMs: number): Promise<{ exitCode: number }> {
    const record = this.record();
    const command = record.commands[cmdId];
    if (!command) throw new SandboxError("not_found", false, `no command ${cmdId}`);
    if (command.exitCode !== null) return { exitCode: command.exitCode };
    const live = liveCommands().get(`${this.name}/${cmdId}`);
    if (live) {
      let timer: NodeJS.Timeout | null = null;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SandboxError("unknown", false, "wait timed out")), timeoutMs);
      });
      try {
        const exitCode = await Promise.race([live.exit, timeout]);
        return { exitCode };
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    // Started by an earlier control-plane process: only liveness is observable.
    if (await waitForExit(command.pid, timeoutMs)) {
      const current = this.record();
      const entry = current.commands[cmdId];
      if (entry && entry.exitCode === null) {
        entry.exitCode = -1;
        writeRecord(current);
      }
      return { exitCode: current.commands[cmdId]?.exitCode ?? -1 };
    }
    throw new SandboxError("unknown", false, "wait timed out");
  }

  async killCommand(cmdId: string, signal: KillSignal): Promise<void> {
    const command = this.record().commands[cmdId];
    if (!command || command.exitCode !== null) return;
    signalGroup(command.pid, signal);
  }

  async extendTimeout(ms: number): Promise<void> {
    const record = this.record();
    record.expiresAt = (record.expiresAt ?? Date.now()) + ms;
    writeRecord(record);
  }

  async updatePorts(ports: number[]): Promise<void> {
    // The allocation binds and closes sockets (it awaits), so the record is re-read afterwards:
    // a concurrent mutation in the window (an exit handler writing `exitCode`, `runDetached`,
    // `extendTimeout`) must not be clobbered by a stale copy.
    const portMap = await allocatePortMap(ports, this.record().portMap, portsInUseByRecords());
    const record = this.record();
    record.portMap = { ...record.portMap, ...portMap };
    record.ports = [...new Set(ports)];
    writeRecord(record);
  }

  /**
   * Stops every process of the sandbox: SIGTERM to the running detached
   * commands' groups and to the supervisor named by its pid file (the
   * supervisor's own stop path runs), then to whatever still names the
   * directory (the server, lifecycle commands), SIGKILL after the grace.
   * Bounded by b9's 25 s stop budget.
   */
  private async terminateAll(): Promise<void> {
    const record = this.record();
    const dir = this.dir();
    const running = Object.values(record.commands).filter((command) => command.exitCode === null);
    const supervisor = supervisorPidFromFile(dir);
    const first = [...running.map((command) => command.pid), ...(supervisor !== null ? [supervisor] : [])];
    for (const pid of first) signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + 22_000;
    for (const pid of first) {
      await waitForExit(pid, Math.max(0, deadline - Date.now()));
    }
    let leftovers = await sandboxPids(dir);
    for (const pid of leftovers) signalGroup(pid, "SIGTERM");
    const graceUntil = Date.now() + 2_000;
    while (leftovers.length > 0 && Date.now() < graceUntil) {
      await sleep(200);
      leftovers = (await sandboxPids(dir)).filter(pidAlive);
    }
    for (const pid of first) if (pidAlive(pid)) signalGroup(pid, "SIGKILL");
    for (const pid of leftovers) signalGroup(pid, "SIGKILL");
    const current = this.record();
    for (const command of Object.values(current.commands)) {
      if (command.exitCode === null && !pidAlive(command.pid)) command.exitCode = -1;
    }
    writeRecord(current);
  }

  /** `tar -czf snapshots/<id>.tgz -C <dir> workspaces home state` (minus `state/run`). */
  private async makeSnapshot(): Promise<{ snapshotId: string; sizeBytes: number }> {
    const dir = this.dir();
    const snapshots = path.join(dir, "snapshots");
    fs.mkdirSync(snapshots, { recursive: true });
    const snapshotId = `lsnap_${this.name}_${Date.now().toString(36)}`;
    const file = path.join(snapshots, `${snapshotId}.tgz`);
    const members = ["workspaces", "home", "state"].filter((member) => fs.existsSync(path.join(dir, member)));
    if (members.length === 0) {
      fs.mkdirSync(path.join(dir, "workspaces"), { recursive: true });
      members.push("workspaces");
    }
    await execFileAsync("tar", ["-czf", file, "-C", dir, "--exclude", "state/run", ...members], {
      maxBuffer: 16 * 1024 * 1024,
    });
    const sizeBytes = fs.statSync(file).size;
    const record = this.record();
    record.snapshotIds.push(snapshotId);
    const keep = record.keepLastSnapshots ?? 0;
    while (keep > 0 && record.snapshotIds.length > keep) {
      const old = record.snapshotIds.shift();
      if (old) fs.rmSync(path.join(snapshots, `${old}.tgz`), { force: true });
    }
    writeRecord(record);
    return { snapshotId, sizeBytes };
  }

  async stop(): Promise<{ snapshotId?: string; snapshotSizeBytes?: number; usage: SandboxUsage }> {
    const record = this.record();
    if (record.status === "stopped") return { usage: ZERO };
    const startedAt = record.startedAt ?? Date.now();
    record.status = "stopping";
    writeRecord(record);
    await this.terminateAll();
    const snapshot = await this.makeSnapshot();
    const stopped = this.record();
    stopped.status = "stopped";
    stopped.sessionId = null;
    stopped.startedAt = null;
    stopped.expiresAt = null;
    writeRecord(stopped);
    closeRpcProxy(this.name);
    return {
      snapshotId: snapshot.snapshotId,
      snapshotSizeBytes: snapshot.sizeBytes,
      // Wall time stands in for active CPU; nothing meters ingress/egress on loopback.
      usage: { activeCpuDurationMs: Math.max(0, Date.now() - startedAt), ingressBytes: 0, egressBytes: 0 },
    };
  }

  async snapshot(expirationMs: number): Promise<{ snapshotId: string; sizeBytes: number }> {
    void expirationMs;
    return this.makeSnapshot();
  }

  async readFile(p: string): Promise<ReadableStream<Uint8Array> | null> {
    const mapped = mapSandboxPath(this.dir(), p);
    if (!fs.existsSync(mapped) || fs.statSync(mapped).isDirectory()) return null;
    return Readable.toWeb(fs.createReadStream(mapped)) as ReadableStream<Uint8Array>;
  }

  async delete(): Promise<void> {
    if (!readRecord(this.name)) return;
    closeRpcProxy(this.name);
    await this.terminateAll();
    for (const key of [...liveCommands().keys()]) {
      if (key.startsWith(`${this.name}/`)) liveCommands().delete(key);
    }
    fs.rmSync(this.dir(), { recursive: true, force: true });
  }

  async listSnapshotIds(): Promise<string[]> {
    return [...this.record().snapshotIds];
  }
}

// ---------------------------------------------------------------------------
// The api
// ---------------------------------------------------------------------------

/** Opens a new "VM session" on a record: fresh session id, timeout, `running`. */
function startSession(record: LocalSandboxRecord): void {
  record.sessionSeq += 1;
  record.sessionId = `lses_${record.name}_${record.sessionSeq}`;
  record.startedAt = Date.now();
  record.expiresAt = record.startedAt + record.timeoutMs;
  record.status = "running";
}

function ensureLayout(dir: string): void {
  for (const sub of ["workspaces", "home", "state", "tmp", "logs", "snapshots"]) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const link = path.join(dir, "vercel");
  try {
    fs.symlinkSync("home", link);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
}

/**
 * Binds the record's rpc proxy (`ZS_LOCAL_RPC_PROXY=1`) in front of its rpc listener. A record
 * created before the proxy was switched on gets a port allocated and persisted first, so
 * `domain(ZS_RPC_PORT)` of an old sandbox goes through the proxy as well.
 */
async function bindRpcProxy(record: LocalSandboxRecord): Promise<void> {
  if (!localRpcProxyEnabled()) return;
  if (record.rpcProxyPort === undefined) {
    const current = readRecord(record.name) ?? record;
    current.rpcProxyPort = await allocatePort(portsInUseByRecords());
    writeRecord(current);
    record.rpcProxyPort = current.rpcProxyPort;
  }
  const upstream = record.portMap[String(env().ZS_RPC_PORT)];
  if (upstream === undefined) return;
  await ensureRpcProxy(record.name, record.rpcProxyPort, upstream).catch(() => undefined);
}

/**
 * SIGKILLs every process of a local sandbox (the supervisor by its pid file and recorded
 * command, the server and helpers by their command lines) **without** touching the record or
 * the control plane's row: the sandbox looks exactly like one whose processes died under a
 * `running` workspace (a crash, a reboot, an older `dev-local.sh stop`). The test-only route
 * of the browser end-to-end suite uses it to exercise `/connect`'s reconciliation. Returns the
 * pids that were signalled.
 */
export async function localKillSandboxProcesses(name: string): Promise<number[]> {
  const record = readRecord(name);
  if (!record) throw new SandboxError("not_found", false, `local sandbox ${name} does not exist`);
  const dir = sandboxDir(name);
  const pids = new Set<number>(await sandboxPids(dir));
  for (const command of Object.values(record.commands)) {
    if (command.exitCode === null && pidAlive(command.pid)) pids.add(command.pid);
  }
  for (const pid of pids) signalGroup(pid, "SIGKILL");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && [...pids].some(pidAlive)) await sleep(100);
  return [...pids];
}

/** Whether any process of the sandbox (supervisor, server, helpers) is alive on this machine. */
export async function localSandboxAlive(name: string): Promise<boolean> {
  const record = readRecord(name);
  if (!record) return false;
  if (Object.values(record.commands).some((command) => command.exitCode === null && pidAlive(command.pid))) {
    return true;
  }
  return (await sandboxPids(sandboxDir(name))).length > 0;
}

/** Restores the newest snapshot when the live trees are gone (a deleted `workspaces/`). */
async function restoreIfNeeded(record: LocalSandboxRecord): Promise<void> {
  const dir = sandboxDir(record.name);
  if (fs.existsSync(path.join(dir, "workspaces")) && fs.readdirSync(path.join(dir, "workspaces")).length > 0) return;
  const latest = record.snapshotIds.at(-1);
  if (!latest) return;
  const file = path.join(dir, "snapshots", `${latest}.tgz`);
  if (!fs.existsSync(file)) return;
  await execFileAsync("tar", ["-xzf", file, "-C", dir], { maxBuffer: 16 * 1024 * 1024 });
}

class LocalSandboxApi implements SandboxApi {
  async create(input: CreateSandboxInput): Promise<SandboxHandle> {
    const existing = readRecord(input.name);
    if (existing) {
      // `getOrCreate` semantics: the creation parameters are ignored, the sandbox is resumed.
      if (existing.status !== "running") {
        await restoreIfNeeded(existing);
        startSession(existing);
        writeRecord(existing);
      }
      return new LocalHandle(input.name);
    }
    const dir = sandboxDir(input.name);
    ensureLayout(dir);
    const taken = portsInUseByRecords();
    const portMap = await allocatePortMap(input.ports, {}, taken);
    const internal = { localApi: await allocatePort(taken), control: await allocatePort(taken) };
    const rpcProxyPort = localRpcProxyEnabled() ? await allocatePort(taken) : undefined;
    const record: LocalSandboxRecord = {
      version: 1,
      name: input.name,
      region: input.region,
      vcpus: input.vcpus,
      ports: [...new Set(input.ports)],
      portMap,
      internal,
      ...(rpcProxyPort === undefined ? {} : { rpcProxyPort }),
      status: "running",
      createdAt: Date.now(),
      startedAt: null,
      expiresAt: null,
      sessionId: null,
      sessionSeq: 0,
      timeoutMs: input.timeoutMs,
      image: input.image,
      sourceSnapshotId: input.source?.snapshotId,
      env: { ...input.env },
      tags: { ...input.tags },
      networkPolicy: input.networkPolicy,
      persistent: input.persistent ?? true,
      snapshotExpirationMs: input.snapshotExpirationMs ?? null,
      keepLastSnapshots: input.keepLastSnapshots ?? null,
      snapshotIds: [],
      commands: {},
      cmdSeq: 0,
    };
    startSession(record);
    writeRecord(record);
    await bindRpcProxy(record);
    return new LocalHandle(input.name);
  }

  async get(
    name: string,
    opts: { resume: boolean; onResume?: (handle: SandboxHandle) => Promise<void> },
  ): Promise<SandboxHandle | null> {
    const record = readRecord(name);
    if (!record) return null;
    const handle = new LocalHandle(name);
    if (opts.resume && record.status !== "running") {
      await restoreIfNeeded(record);
      startSession(record);
      writeRecord(record);
      await bindRpcProxy(record);
      if (opts.onResume) await opts.onResume(handle);
    } else if (record.status === "running") {
      // A restarted control plane (`next dev` reloaded) lost its in-process listeners; every
      // touch of a running sandbox through the API puts the proxy back on its recorded port.
      await bindRpcProxy(record);
    }
    return handle;
  }

  async *listByTag(tag: Record<string, string>): AsyncIterable<SandboxSummary> {
    const [key, value] = Object.entries(tag)[0] ?? [];
    for (const record of allRecords()) {
      if (key !== undefined && record.tags[key] !== value) continue;
      yield { name: record.name, status: record.status, createdAt: new Date(record.createdAt) };
    }
  }

  async deleteSnapshot(snapshotId: string): Promise<void> {
    for (const record of allRecords()) {
      if (!record.snapshotIds.includes(snapshotId)) continue;
      fs.rmSync(path.join(sandboxDir(record.name), "snapshots", `${snapshotId}.tgz`), { force: true });
      record.snapshotIds = record.snapshotIds.filter((id) => id !== snapshotId);
      writeRecord(record);
    }
  }
}

let instance: SandboxApi | null = null;

/** The local process backend (`ZS_SANDBOX_BACKEND=local`). */
export function localSandboxApi(): SandboxApi {
  if (!instance) instance = new LocalSandboxApi();
  return instance;
}

/** The record of a local sandbox (tests and the dev script read the allocated ports from it). */
export function localSandboxRecord(name: string): LocalSandboxRecord | null {
  return readRecord(name);
}

// ---------------------------------------------------------------------------
// `local/<name>` repositories
// ---------------------------------------------------------------------------

/** The owner segment of every local repository. */
export const LOCAL_REPO_OWNER = "local";

/**
 * The synthetic `github_installations` row local repositories register under
 * (owned by the dev user, seeded by `lib/auth.ts` in dev-auth mode).
 */
export const LOCAL_INSTALLATION_ID = 1;

const LOCAL_REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** True for `local/<name>` while the local backend is enabled. */
export function isLocalRepo(owner: string): boolean {
  return owner === LOCAL_REPO_OWNER && localBackendEnabled();
}

/** `<ZS_LOCAL_REPOS_DIR>/<name>`, refusing names that are not one plain path segment. */
export function localRepoPath(name: string): string {
  if (!LOCAL_REPO_NAME_RE.test(name) || name === "." || name === "..") {
    throw new ApiError(404, "repo_not_found", `local/${name} is not a repository name`);
  }
  const root = localReposDir();
  const resolved = path.resolve(root, name);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new ApiError(404, "repo_not_found", `local/${name} is not a repository name`);
  }
  return resolved;
}

/** The `file://` URL the supervisor clones from. */
export function localCloneUrl(name: string): string {
  return pathToFileURL(localRepoPath(name)).href;
}

/** A stable negative id for `repos.github_repo_id` (real GitHub ids are positive). */
export function localGithubRepoId(name: string): number {
  const digest = createHash("sha256").update(`local/${name}`, "utf8").digest();
  return -((digest.readUInt32BE(0) & 0x7fffffff) + 1);
}

async function git(repo: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * A branch name or revision that may be handed to git as an operand: never
 * option-shaped (a leading `-` would be parsed by `git show`/`rev-parse` as
 * an option such as `--output=<file>`), no `..`, no trailing `/`. Every git
 * call below also passes `--end-of-options` before the operand.
 */
function assertGitRef(ref: string): string {
  if (!GIT_REF_RE.test(ref) || ref.includes("..") || ref.endsWith("/") || ref.endsWith(".lock")) {
    throw new ApiError(400, "invalid_body", `${JSON.stringify(ref)} is not a git ref`);
  }
  return ref;
}

async function isGitRepo(repo: string): Promise<boolean> {
  if (!fs.existsSync(repo)) return false;
  return (await git(repo, ["rev-parse", "--git-dir"])) !== null;
}

async function defaultBranchOf(repo: string): Promise<string> {
  const head = await git(repo, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (head) return head;
  const branches = await git(repo, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  const first = branches?.split("\n").find((line) => line.trim().length > 0);
  return first?.trim() ?? "main";
}

/** {@link fetchRepo} for a local repository: `null` when the directory is not a git repository. */
export async function localFetchRepo(name: string): Promise<InstallationRepo | null> {
  const repo = localRepoPath(name);
  if (!(await isGitRepo(repo))) return null;
  return {
    id: localGithubRepoId(name),
    owner: LOCAL_REPO_OWNER,
    name,
    defaultBranch: await defaultBranchOf(repo),
    private: false,
  };
}

/** {@link resolveRef} for a local repository (branches and revisions; there are no pull requests). */
export async function localResolveRef(name: string, ref: RefRequest): Promise<ResolvedRef> {
  const repo = localRepoPath(name);
  if (!(await isGitRepo(repo))) throw new ApiError(404, "repo_not_found", `local/${name} is not a git repository`);
  if (ref.pullRequest !== undefined) {
    throw new ApiError(400, "invalid_body", "Pull requests are not available for local repositories");
  }
  if (ref.revision !== undefined) {
    const revision = assertGitRef(ref.revision);
    const sha = await git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${revision}^{commit}`]);
    if (!sha) throw new ApiError(404, "repo_not_found", `local/${name} has no commit ${ref.revision}`);
    return { branch: null, sha, gitRef: null };
  }
  const branch = assertGitRef(ref.branch ?? (await defaultBranchOf(repo)));
  const sha = await git(repo, ["rev-parse", "--verify", "--quiet", "--end-of-options", `refs/heads/${branch}^{commit}`]);
  if (!sha) throw new ApiError(404, "repo_not_found", `local/${name} has no branch ${branch}`);
  return { branch, sha, gitRef: null };
}

/** Upserts the `local` installation row, owned by `userId`. */
export async function ensureLocalInstallation(userId: string): Promise<void> {
  const db = await dbReady();
  await db
    .insert(githubInstallations)
    .values({
      installationId: LOCAL_INSTALLATION_ID,
      accountId: 0,
      accountLogin: LOCAL_REPO_OWNER,
      accountType: "User",
      repositorySelection: "all",
      ownerUserId: userId,
    })
    .onConflictDoUpdate({
      target: githubInstallations.installationId,
      set: { ownerUserId: userId, deletedAt: null, suspendedAt: null },
    });
}
