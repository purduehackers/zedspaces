import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { env, EnvError } from "./env";
import { SandboxError } from "./sandbox-error";
import type { CommandStatus, KillSignal, RunInput, SandboxApi, SandboxHandle, SandboxStatus } from "./sandbox";

const exec = promisify(execFile);
const LABEL = "com.zedspaces.local";
const DEADLINE = "/tmp/zs-docker-deadline";
const USAGE = { activeCpuDurationMs: 0, ingressBytes: 0, egressBytes: 0 };

export function dockerBackendEnabled(): boolean {
  if (env().ZS_SANDBOX_BACKEND !== "docker") return false;
  if (env().NODE_ENV === "production" || env().VERCEL_ENV) {
    throw new EnvError(["ZS_SANDBOX_BACKEND"], "Docker is a local development backend; it cannot run on Vercel or in production mode");
  }
  return true;
}

/** A checkout owns only containers/images carrying its instance label. */
function instance(): string {
  if (!dockerBackendEnabled()) throw new Error("Docker backend is not enabled");
  return createHash("sha256").update(path.resolve(env().ZS_DOCKER_ROOT ?? ".zs-dev/docker")).digest("hex").slice(0, 16);
}

async function docker(args: string[], values?: Record<string, string>, timeout = 60_000) {
  try {
    return await exec("docker", args, { env: { ...process.env, ...values }, timeout, maxBuffer: 8 * 1024 * 1024 });
  } catch (error) {
    const failure = error as Error & { stderr?: string; code?: string | number };
    // Do not include command arguments: exec environments can carry tokens.
    throw new SandboxError("unknown", true, `Docker: ${(failure.stderr || `command failed (${failure.code ?? "unavailable"})`).slice(0, 1200)}`);
  }
}

interface Container {
  Id: string;
  Created: string;
  State: { Running: boolean; Paused: boolean; Status: string; StartedAt: string };
  Config: { Labels: Record<string, string> };
  NetworkSettings: { Ports: Record<string, { HostIp: string; HostPort: string }[] | null> };
}

function containerName(name: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(name)) throw new Error("Invalid sandbox name");
  return `zs-${instance()}-${name}`;
}

async function inspect(name: string): Promise<Container | null> {
  try {
    const result = await docker(["container", "inspect", containerName(name)]);
    const info = JSON.parse(result.stdout)[0] as Container;
    if (info.Config.Labels[LABEL] !== instance()) throw new Error("Container belongs to another instance");
    return info;
  } catch (err) {
    if (err instanceof SandboxError && /No such (container|object)/i.test(err.message)) return null;
    throw err;
  }
}

// PID 1 enforces expiry even when Next is not running. Starting the container
// opens a new session, while its writable layer keeps the project and settings.
const KEEPALIVE = `import os, pathlib, signal, time
p = pathlib.Path('${DEADLINE}')
p.write_text(str(time.time() + float(os.environ['ZS_DOCKER_TIMEOUT'])))
signal.signal(signal.SIGTERM, lambda *_: exit(0))
while time.time() < float(p.read_text()): time.sleep(1)
`;

// All command bookkeeping lives in the container, not a Next worker's memory.
// A separate process group lets cancellation kill descendants as well as the CLI.
const RUNNER = `import json, os, pathlib, subprocess, sys
d = pathlib.Path(sys.argv[1]); d.mkdir(parents=True, exist_ok=True)
timeout = float(sys.argv[2])
with (d/'stdout').open('wb') as out, (d/'stderr').open('wb') as err:
 try:
  p = subprocess.Popen(sys.argv[3:], stdout=out, stderr=err, start_new_session=True)
  (d/'pid').write_text(str(p.pid))
  try: code = p.wait(timeout=timeout if timeout > 0 else None)
  except subprocess.TimeoutExpired:
   os.killpg(p.pid, 9); p.wait(); code = 124
 except Exception as error:
  err.write(str(error).encode()); code = 127
 (d/'exit.tmp').write_text(str(code if code >= 0 else 128 - code))
 (d/'exit.tmp').replace(d/'exit')
`;

class DockerHandle implements SandboxHandle {
  private deadline: Date | undefined;
  constructor(readonly name: string, private info: Container) {
    this.deadline = this.status === "running"
      ? new Date(Date.parse(info.State.StartedAt) + Number(info.Config.Labels[`${LABEL}.timeout`])) : undefined;
  }
  get status(): SandboxStatus { return this.info.State.Paused ? "snapshotting" : this.info.State.Running ? "running" : "stopped"; }
  get region() { return this.info.Config.Labels[`${LABEL}.region`]; }
  get expiresAt() { return this.deadline; }
  async readDeadline() {
    if (this.status !== "running") return;
    // PID 1 may still be starting immediately after `docker start`.
    try {
      const { stdout } = await docker(["exec", this.info.Id, "cat", DEADLINE], undefined, 5000);
      const timestamp = Number(stdout) * 1000;
      if (Number.isFinite(timestamp) && timestamp > 0) this.deadline = new Date(timestamp);
    } catch { /* The initial session deadline remains a conservative fallback. */ }
  }
  get currentSessionId() {
    return this.status === "running" ? createHash("sha256").update(this.info.Id + this.info.State.StartedAt).digest("hex").slice(0, 24) : undefined;
  }
  domain(port: number): string {
    const mapped = this.info.NetworkSettings.Ports[`${port}/tcp`]?.find((binding) => binding.HostIp === "127.0.0.1");
    if (!mapped) throw new Error(`Port ${port} is not published on loopback`);
    return `http://127.0.0.1:${mapped.HostPort}`;
  }
  private commandDir(cmdId: string): string {
    if (!/^[a-f0-9]{24}-[a-f0-9-]{36}$/.test(cmdId)) throw new SandboxError("not_found", false, "Unknown Docker command");
    return `/tmp/zs-exec/${cmdId}`;
  }
  private async refresh(resume = false): Promise<void> {
    const info = await inspect(this.name);
    if (!info) throw new SandboxError("not_found", false);
    if (!info.State.Running && resume) {
      await docker(["start", info.Id]);
      this.info = (await inspect(this.name))!;
    } else this.info = info;
  }
  async runDetached(input: RunInput): Promise<{ cmdId: string }> {
    await this.refresh();
    if (!this.currentSessionId) throw new SandboxError("not_found", false, "Sandbox is stopped");
    const cmdId = `${this.currentSessionId}-${randomUUID()}`;
    const values = { ...input.env };
    if (values.ZS_CONTROL_URL) values.ZS_CONTROL_URL = env().ZS_DOCKER_CONTROL_URL ?? values.ZS_CONTROL_URL;
    const args = ["exec", "--detach", ...(input.sudo ? ["--user", "root"] : []), ...(input.cwd ? ["--workdir", input.cwd] : [])];
    for (const key of Object.keys(values)) args.push("--env", key);
    args.push(this.info.Id, "python3", "-c", RUNNER, this.commandDir(cmdId), String((input.timeoutMs ?? 0) / 1000), input.cmd, ...input.args);
    await docker(args, values);
    return { cmdId };
  }
  async commandStatus(cmdId: string): Promise<CommandStatus> {
    await this.refresh();
    if (!this.currentSessionId || !cmdId.startsWith(`${this.currentSessionId}-`)) return { exitCode: 137, running: false };
    const script = `import pathlib, sys
d = pathlib.Path(sys.argv[1])
print((d/'exit').read_text() if (d/'exit').exists() else 'running')`;
    const { stdout } = await docker(["exec", this.info.Id, "python3", "-c", script, this.commandDir(cmdId)]);
    return stdout.trim() === "running" ? { running: true, exitCode: null } : { running: false, exitCode: Number(stdout) };
  }
  async waitCommand(cmdId: string, timeoutMs: number): Promise<{ exitCode: number }> {
    const deadline = Date.now() + timeoutMs;
    do {
      const state = await this.commandStatus(cmdId);
      if (state.exitCode !== null) return { exitCode: state.exitCode };
      await delay(Math.min(200, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new SandboxError("unknown", false, "Docker command wait timed out");
  }
  async run(input: RunInput) {
    const { cmdId } = await this.runDetached({ ...input, timeoutMs: input.timeoutMs ?? 60_000 });
    const { exitCode } = await this.waitCommand(cmdId, (input.timeoutMs ?? 60_000) + 10_000);
    const output = async (file: string) => (await docker(["exec", "--user", "root", this.info.Id, "cat", `${this.commandDir(cmdId)}/${file}`])).stdout;
    return { exitCode, stdout: await output("stdout"), stderr: await output("stderr") };
  }
  async killCommand(cmdId: string, signal: KillSignal): Promise<void> {
    if (!(await this.commandStatus(cmdId)).running) return;
    const script = `import os, pathlib, signal, sys, time
p = pathlib.Path(sys.argv[1])/'pid'
for _ in range(100):
 if p.exists(): break
 time.sleep(.05)
if p.exists():
 try: os.killpg(int(p.read_text()), getattr(signal, sys.argv[2]))
 except ProcessLookupError: pass`;
    await docker(["exec", "--user", "root", this.info.Id, "python3", "-c", script, this.commandDir(cmdId), signal]);
  }
  async extendTimeout(ms: number): Promise<void> {
    await this.refresh();
    this.deadline = new Date(Date.now() + ms);
    await docker(["exec", this.info.Id, "python3", "-c", `import pathlib,sys; pathlib.Path('${DEADLINE}').write_text(sys.argv[1])`, String(this.deadline.getTime() / 1000)]);
  }
  async stop() {
    await this.refresh();
    if (this.status === "running") await docker(["stop", "--time", "20", this.info.Id]);
    await this.refresh();
    this.deadline = undefined;
    // Unlike Vercel, Docker keeps the stopped container's writable layer.
    return { usage: USAGE };
  }
  async snapshot(expirationMs: number) {
    await this.refresh(true);
    const snapshotId = `zedspaces-snapshot-${instance()}:${randomUUID()}`;
    const expires = expirationMs ? Date.now() + expirationMs : 0;
    await docker(["commit", "--change", `LABEL ${LABEL}=${instance()}`, "--change", `LABEL ${LABEL}.sandbox=${this.name}`, "--change", `LABEL ${LABEL}.expires=${expires}`, this.info.Id, snapshotId], undefined, 10 * 60_000);
    const { stdout } = await docker(["image", "inspect", "--format", "{{.Size}}", snapshotId]);
    return { snapshotId, sizeBytes: Number(stdout) };
  }
  async readFile(file: string): Promise<ReadableStream<Uint8Array> | null> {
    await this.refresh(true);
    if ((await this.run({ cmd: "test", args: ["-f", file] })).exitCode !== 0) return null;
    const child = spawn("docker", ["exec", this.info.Id, "cat", "--", file], { stdio: ["ignore", "pipe", "pipe"] });
    child.stderr.resume();
    child.on("error", (err) => child.stdout.destroy(err));
    child.on("exit", (code) => { if (code !== 0) child.stdout.destroy(new Error("Docker file read failed")); });
    child.stdout.on("close", () => child.kill());
    return Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  }
  async delete(): Promise<void> {
    const info = await inspect(this.name);
    if (info) await docker(["rm", "--force", info.Id]);
  }
  async listSnapshotIds(): Promise<string[]> {
    const { stdout } = await docker(["image", "ls", "--filter", `label=${LABEL}=${instance()}`, "--filter", `label=${LABEL}.sandbox=${this.name}`, "--format", "{{.Repository}}:{{.Tag}}"]);
    return stdout.trim().split("\n").filter((id) => id.startsWith(`zedspaces-snapshot-${instance()}:`));
  }
}

async function snapshotInfo(id: string) {
  if (!new RegExp(`^zedspaces-snapshot-${instance()}:[a-f0-9-]{36}$`).test(id)) throw new SandboxError("not_found", false, "Snapshot belongs to another instance");
  try {
    const { stdout } = await docker(["image", "inspect", id]);
    const info = JSON.parse(stdout)[0] as { Config: { Labels: Record<string, string> } };
    if (info.Config.Labels[LABEL] !== instance()) throw new Error("Snapshot belongs to another instance");
    return info;
  } catch (err) {
    if (err instanceof SandboxError && /No such (image|object)/i.test(err.message)) return null;
    throw err;
  }
}

export const dockerSandboxApi: SandboxApi = {
  async create(input) {
    const existing = await this.get(input.name, { resume: true });
    if (existing) return existing;
    if (input.networkPolicy !== "allow-all") throw new SandboxError("unknown", false, "Docker does not support domain-based network allowlists");
    if (input.source) {
      const saved = await snapshotInfo(input.source.snapshotId);
      const expires = Number(saved?.Config.Labels[`${LABEL}.expires`]);
      if (!saved || (expires && expires < Date.now())) throw new SandboxError("snapshot_expired", false);
    }
    const image = input.source?.snapshotId ?? input.image;
    if (!image) throw new SandboxError("image_not_ready", false, "A Docker workspace image is required");
    const args = ["create", "--name", containerName(input.name), "--platform", "linux/amd64", "--init", "--cpus", String(input.vcpus), "--memory", `${input.vcpus * 2}g`, "--pids-limit", "4096", "--add-host", "host.docker.internal:host-gateway", "--entrypoint", "python3"];
    const labels = { [LABEL]: instance(), [`${LABEL}.name`]: input.name, [`${LABEL}.region`]: input.region, [`${LABEL}.timeout`]: String(input.timeoutMs), ...Object.fromEntries(Object.entries(input.tags).map(([k, v]) => [`${LABEL}.tag.${k}`, v])) };
    for (const [key, value] of Object.entries(labels)) args.push("--label", `${key}=${value}`);
    for (const port of input.ports) args.push("--publish", `127.0.0.1::${port}`);
    const values = { ...input.env, ZS_INSECURE_COOKIES: "1", ZS_DOCKER_TIMEOUT: String(input.timeoutMs / 1000) };
    for (const key of Object.keys(values)) args.push("--env", key);
    try { await docker([...args, image, "-c", KEEPALIVE], values); }
    catch (err) {
      // Docker reserves the name before inspect can see the new container.
      // A second workflow worker must wait for that create to finish.
      const deadline = Date.now() + (err instanceof SandboxError && err.message.includes("already in use by container") ? 10_000 : 0);
      while (!await inspect(input.name)) {
        if (Date.now() >= deadline) throw err;
        await delay(100);
      }
    }
    return (await this.get(input.name, { resume: true }))!;
  },
  async get(name, opts) {
    let info = await inspect(name);
    if (!info) return null;
    const resumed = !info.State.Running && opts.resume;
    if (resumed) {
      await docker(["start", info.Id]);
      info = (await inspect(name))!;
    }
    const handle = new DockerHandle(name, info);
    await handle.readDeadline();
    if (resumed) await opts.onResume?.(handle);
    return handle;
  },
  async *listByTag(tags) {
    const args = ["ps", "--all", "--filter", `label=${LABEL}=${instance()}`, "--format", `{{.Label "${LABEL}.name"}}`];
    for (const [key, value] of Object.entries(tags)) args.push("--filter", `label=${LABEL}.tag.${key}=${value}`);
    for (const name of (await docker(args)).stdout.trim().split("\n").filter(Boolean)) {
      const info = await inspect(name);
      if (info) yield { name, status: info.State.Running ? "running" : "stopped", createdAt: new Date(info.Created) };
    }
  },
  async deleteSnapshot(id) {
    if (await snapshotInfo(id)) await docker(["image", "rm", id]);
  },
};
