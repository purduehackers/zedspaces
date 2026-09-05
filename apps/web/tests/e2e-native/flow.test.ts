/**
 * Native end-to-end flow against a live local control plane (round 2, lane
 * local-backend). Started by `scripts/dev-local.sh e2e`, which runs `next dev`
 * in local mode (`ZS_AUTH_MODE=dev`, `ZS_SANDBOX_BACKEND=local`) and sets:
 *
 * - `ZS_E2E_BASE_URL`    the control plane origin (e.g. `http://127.0.0.1:3100`)
 * - `ZS_E2E_ZED_DIR`     the `zed/` checkout (`cargo test -p remote --test native_e2e`)
 * - `ZS_E2E_LOCAL_ROOT`  `ZS_LOCAL_ROOT` of the dev server (the per-sandbox directories)
 * - `ZS_E2E_REPOS_DIR`   `ZS_LOCAL_REPOS_DIR` of the dev server (where the fixture repo goes)
 *
 * Without `ZS_E2E_BASE_URL` the suite is skipped, so `pnpm test` never needs
 * the binaries. The flow: fixture git repo → `POST /api/workspaces` as the dev
 * user → poll until `running` (supervisor spawned, `zed-remote-server serve`
 * up on 127.0.0.1) → `POST /connect` (D26 shape) → the Rust native client
 * (Hello/HelloAck, RemoteStarted, AddWorktree, open/edit/save) → the file on
 * disk changed → `POST /stop` → supervisor and server exited → `DELETE` →
 * sandbox directory gone. `ZS_E2E_KEEP=1` skips the delete and keeps the
 * stopped workspace, its sandbox directory and the fixture for inspection.
 *
 * Cleanup never trusts the API alone: when the flow fails while the create run
 * is still polling health, `/stop` answers `423 workspace_busy`; the cleanup
 * waits a bounded time for the run, then terminates the supervisor and server
 * by the pids in `sandbox.json`/`state/run/zs-agent.pid` and reports loudly
 * when a process survives.
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const BASE_URL = process.env.ZS_E2E_BASE_URL;
const ZED_DIR = process.env.ZS_E2E_ZED_DIR ?? path.resolve(process.cwd(), "..", "..", "zed");
const LOCAL_ROOT = process.env.ZS_E2E_LOCAL_ROOT;
const REPOS_DIR = process.env.ZS_E2E_REPOS_DIR;

/** What the native client appends to the fixture file (shared with native_e2e.rs through the env). */
const APPEND = "\ne2e: edited by the native client\n";
const FIXTURE_FILES = ["README.md", "src/main.rs"] as const;

const WORKSPACE_ID_RE = /^ws_[0-9A-HJKMNP-TV-Z]{20}$/;
const CONNECT_ID_RE = /^con_[0-9A-HJKMNP-TV-Z]{20}$/;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function log(message: string): void {
  process.stderr.write(`[e2e-native] ${new Date().toISOString().slice(11, 19)} ${message}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api<T>(method: string, route: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE_URL}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed as T };
}

/**
 * A raw GET with the headers given verbatim: `node:http` sends a `Host` as
 * written, while `fetch` drops it (a forbidden header name) and would probe
 * nothing.
 */
function rawGet(route: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const url = new URL(`${BASE_URL}${route}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { method: "GET", hostname: url.hostname, port: url.port, path: url.pathname, headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

interface WorkspaceView {
  id: string;
  state: string;
  stateReason: string | null;
  workflowRunId: string | null;
  serverBuild: string;
  clientBuild: string;
  repo: { owner: string; name: string; defaultBranch: string };
}

interface ConnectInfo {
  wsUrl: string;
  token: string;
  sessionId: string;
  workspaceId: string;
  serverBuild: string;
  clientBuild: string;
  sessionExpiresAt: string;
  sessionCapAt: string;
  audience: string;
}

interface LocalSandboxRecord {
  name: string;
  portMap: Record<string, number>;
  internal: { localApi: number; control: number };
  commands: Record<string, { cmd: string; pid: number; exitCode: number | null }>;
  status: string;
}

/** git with the developer's global config (signing, hooks, templates) kept out of the fixture. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "e2e",
  GIT_AUTHOR_EMAIL: "e2e@localhost",
  GIT_COMMITTER_NAME: "e2e",
  GIT_COMMITTER_EMAIL: "e2e@localhost",
};

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { env: GIT_ENV });
  return stdout.trim();
}

/** A tiny git repository under `ZS_LOCAL_REPOS_DIR`: README.md and src/main.rs on `main`. */
async function createFixtureRepo(): Promise<{ name: string; dir: string; sha: string }> {
  if (!REPOS_DIR) throw new Error("ZS_E2E_REPOS_DIR is not set");
  const name = `e2e-${randomBytes(4).toString("hex")}`;
  const dir = path.join(REPOS_DIR, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(path.join(dir, "README.md"), "# e2e fixture\n\nEdited over the WebSocket transport.\n");
  fs.writeFileSync(path.join(dir, "src", "main.rs"), 'fn main() {\n    println!("hello from the fixture");\n}\n');
  await execFileAsync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
  const sha = await git(dir, ["rev-parse", "HEAD"]);
  return { name, dir, sha };
}

async function pollWorkspace(
  id: string,
  until: (workspace: WorkspaceView) => boolean,
  timeoutMs: number,
  what: string,
): Promise<WorkspaceView> {
  const deadline = Date.now() + timeoutMs;
  let lastReason: string | null | undefined;
  for (;;) {
    const res = await api<{ workspace: WorkspaceView }>("GET", `/api/workspaces/${id}`);
    expect(res.status, `GET /api/workspaces/${id}: ${JSON.stringify(res.body)}`).toBe(200);
    const workspace = res.body.workspace;
    const reason = `${workspace.state}/${workspace.stateReason ?? ""}`;
    if (reason !== lastReason) {
      log(`workspace ${id}: ${reason}`);
      lastReason = reason;
    }
    if (until(workspace)) return workspace;
    if (workspace.state === "error") {
      throw new Error(`workspace ${id} entered error: ${workspace.stateReason ?? "(no reason)"}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last ${reason}`);
    }
    await sleep(2_000);
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const KEEP = process.env.ZS_E2E_KEEP === "1";

/** Program names a sandbox directory may own (mirrors lib/sandbox-local.ts); never a developer's editor or `tail`. */
const OWNED_PROGRAMS = new Set(["zs-agent", "zed-remote-server", "remote_server", "sh", "bash", "git", "tar"]);

function signal(pid: number, sig: NodeJS.Signals): void {
  try {
    process.kill(-pid, sig);
    return;
  } catch {
    // Not a group leader (or gone): the pid itself.
  }
  try {
    process.kill(pid, sig);
  } catch {
    // Already exited.
  }
}

/** Every live process of the sandbox: the supervisor (pid file, recorded commands) and what names the directory. */
async function liveSandboxPids(dir: string): Promise<number[]> {
  const pids = new Set<number>();
  try {
    const pid = Number(fs.readFileSync(path.join(dir, "state", "run", "zs-agent.pid"), "utf8").trim());
    if (Number.isInteger(pid) && pid > 1 && pidAlive(pid)) pids.add(pid);
  } catch {
    // No pid file: the supervisor never booted, or the directory is gone.
  }
  if (fs.existsSync(path.join(dir, "sandbox.json"))) {
    for (const command of Object.values(readRecord(dir).commands)) {
      if (command.exitCode === null && pidAlive(command.pid)) pids.add(command.pid);
    }
  }
  try {
    const pattern = `${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`;
    const { stdout } = await execFileAsync("pgrep", ["-f", pattern]);
    const candidates = stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid);
    if (candidates.length > 0) {
      const ps = await execFileAsync("ps", ["-o", "pid=,comm=", "-p", candidates.join(",")]).catch(() => ({ stdout: "" }));
      for (const line of ps.stdout.split("\n")) {
        const match = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (match && OWNED_PROGRAMS.has(path.basename(match[2].trim()))) pids.add(Number(match[1]));
      }
    }
  } catch {
    // pgrep exits 1 when nothing matches.
  }
  return [...pids];
}

/** SIGTERM to the sandbox's process groups, up to 25 s, then SIGKILL; a survivor is reported loudly. */
async function killSandboxProcesses(dir: string): Promise<void> {
  const pids = await liveSandboxPids(dir);
  if (pids.length === 0) return;
  log(`cleanup: terminating leftover processes of ${path.basename(dir)}: ${pids.join(", ")}`);
  for (const pid of pids) signal(pid, "SIGTERM");
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && pids.some(pidAlive)) await sleep(500);
  const survivors = pids.filter(pidAlive);
  for (const pid of survivors) signal(pid, "SIGKILL");
  if (survivors.length > 0) {
    await sleep(1_000);
    const stillAlive = survivors.filter(pidAlive);
    if (stillAlive.length > 0) log(`cleanup: WARNING: pids ${stillAlive.join(", ")} survived SIGKILL`);
    else log(`cleanup: pids ${survivors.join(", ")} needed SIGKILL`);
  }
}

function sandboxDirFor(workspaceId: string): { name: string; dir: string } {
  if (!LOCAL_ROOT) throw new Error("ZS_E2E_LOCAL_ROOT is not set");
  // `newSandboxName(id, 1)` without VERCEL_ENV: sb-dev-<id body lowercased>-g1.
  const name = `sb-dev-${workspaceId.slice(3).toLowerCase()}-g1`;
  return { name, dir: path.join(LOCAL_ROOT, name) };
}

function readRecord(dir: string): LocalSandboxRecord {
  return JSON.parse(fs.readFileSync(path.join(dir, "sandbox.json"), "utf8")) as LocalSandboxRecord;
}

/** On failure: the tail of every detached command's log (the supervisor's stderr) for the diagnosis. */
function dumpSandboxLogs(dir: string | null): void {
  if (!dir) return;
  const logs = path.join(dir, "logs");
  if (!fs.existsSync(logs)) return;
  for (const file of fs.readdirSync(logs)) {
    const lines = fs.readFileSync(path.join(logs, file), "utf8").split("\n");
    log(`--- ${path.join(logs, file)} (last ${Math.min(lines.length, 80)} lines) ---`);
    process.stderr.write(`${lines.slice(-80).join("\n")}\n`);
  }
}

/** Runs the Rust native client test and returns its combined output; rejects on a non-zero exit. */
function runNativeClient(envExtra: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["test", "-p", "remote", "--test", "native_e2e", "--", "--nocapture"];
    log(`cargo ${args.join(" ")} (cwd ${ZED_DIR})`);
    const child = spawn("cargo", args, {
      cwd: ZED_DIR,
      env: { ...process.env, ...envExtra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    const forward = (chunk: Buffer) => {
      chunks.push(chunk);
      process.stderr.write(chunk);
    };
    child.stdout?.on("data", forward);
    child.stderr?.on("data", forward);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      const output = Buffer.concat(chunks).toString("utf8");
      if (code === 0) resolve(output);
      else reject(new Error(`native client test exited with ${code ?? signal}`));
    });
  });
}

const cleanup: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const step of cleanup.reverse()) {
    await step().catch((err: unknown) => log(`cleanup failed: ${err instanceof Error ? err.message : String(err)}`));
  }
});

describe.skipIf(!BASE_URL)("native end-to-end flow on the local backend", () => {
  it("creates a workspace, connects a native client, edits a file and stops", async () => {
    let sandboxDirForLogs: string | null = null;
    try {
      await flow((dir) => {
        sandboxDirForLogs = dir;
      });
    } catch (err) {
      dumpSandboxLogs(sandboxDirForLogs);
      throw err;
    }
  });

  async function flow(onSandboxDir: (dir: string) => void): Promise<void> {
    // 0. The dev user is signed in by ZS_AUTH_MODE=dev; no Clerk anywhere: the API and the
    //    dashboard (the site layouts leave ClerkProvider/UserButton out in dev mode).
    const me = await api<{ workspaces: WorkspaceView[] }>("GET", "/api/workspaces");
    expect(me.status).toBe(200);
    const dashboard = await fetch(`${BASE_URL}/workspaces`, { redirect: "manual" });
    const dashboardHtml = await dashboard.text();
    expect(dashboard.status, dashboardHtml.slice(0, 400)).toBe(200);
    expect(dashboardHtml).not.toContain("publishableKey");
    expect(dashboardHtml).toContain("Zedspaces");
    // Dev auth is bound to loopback requests: a foreign Host (a LAN peer, DNS rebinding), a
    // cross-site fetch or a foreign Origin is refused before any viewer is resolved, for the API
    // and for the dashboard document alike.
    const ownHost = new URL(BASE_URL!).host;
    const foreign = await rawGet("/api/workspaces", { host: "attacker.example:3100" });
    expect(foreign.status, foreign.body.slice(0, 300)).toBe(403);
    expect(foreign.body).toContain("dev_origin_refused");
    const crossSite = await rawGet("/api/workspaces", { host: ownHost, "sec-fetch-site": "cross-site" });
    expect(crossSite.status, crossSite.body.slice(0, 300)).toBe(403);
    const foreignOrigin = await rawGet("/api/workspaces", { host: ownHost, origin: "http://localhost:4000" });
    expect(foreignOrigin.status, foreignOrigin.body.slice(0, 300)).toBe(403);
    const foreignPage = await rawGet("/workspaces", { host: "attacker.example:3100" });
    expect(foreignPage.status, foreignPage.body.slice(0, 300)).toBe(403);

    // 1. A local repository fixture, registered on the fly through POST /api/workspaces.
    const fixture = await createFixtureRepo();
    cleanup.push(async () => {
      if (KEEP) log(`ZS_E2E_KEEP=1: keeping the fixture repository ${fixture.dir}`);
      else fs.rmSync(fixture.dir, { recursive: true, force: true });
    });
    log(`fixture repository local/${fixture.name} at ${fixture.dir} (${fixture.sha.slice(0, 7)})`);

    const created = await api<{ workspace: WorkspaceView; runId: string }>("POST", "/api/workspaces", {
      repo: { installationId: 1, owner: "local", name: fixture.name },
      ref: { branch: "main" },
      machine: "vcpu2",
    });
    expect(created.status, JSON.stringify(created.body)).toBe(202);
    const workspaceId = created.body.workspace.id;
    expect(workspaceId).toMatch(WORKSPACE_ID_RE);
    expect(created.body.workspace.state).toBe("creating");
    expect(created.body.workspace.repo).toMatchObject({ owner: "local", name: fixture.name, defaultBranch: "main" });
    expect(created.body.runId).toBeTypeOf("string");
    log(`workspace ${workspaceId} reserved; run ${created.body.runId}`);
    const { name: sandboxName, dir: sandboxDir } = sandboxDirFor(workspaceId);
    onSandboxDir(sandboxDir);
    let deleted = false;
    cleanup.push(async () => {
      if (deleted) return;
      const current = await api<{ workspace: WorkspaceView }>("GET", `/api/workspaces/${workspaceId}`);
      if (current.status === 200 && current.body.workspace.state !== "stopped") {
        // A create run still polling health answers 423 on /stop; give it a bounded chance to end.
        const deadline = Date.now() + 60_000;
        let stop = await api("POST", `/api/workspaces/${workspaceId}/stop`);
        while (stop.status === 423 && Date.now() < deadline) {
          await sleep(2_000);
          stop = await api("POST", `/api/workspaces/${workspaceId}/stop`);
        }
        if (stop.status === 200 || stop.status === 202) {
          await pollWorkspace(workspaceId, (w) => w.state === "stopped" && w.workflowRunId === null, 90_000, "cleanup stop").catch(
            (err: unknown) => log(`cleanup: stop did not complete: ${err instanceof Error ? err.message : String(err)}`),
          );
        } else {
          log(`cleanup: POST /stop answered ${stop.status} ${JSON.stringify(stop.body)}; terminating the sandbox processes directly`);
        }
      }
      await killSandboxProcesses(sandboxDir);
    });

    // 2. createWorkspace: local sandbox directory, supervisor spawned, server healthy, `running`.
    // Activity can report server-ready before the create workflow's final bookkeeping step.
    const running = await pollWorkspace(workspaceId, (w) => w.state === "running" && w.workflowRunId === null, 4 * 60_000, "running with create workflow complete");
    expect(running.workflowRunId).toBeNull();

    expect(fs.existsSync(path.join(sandboxDir, "sandbox.json")), `sandbox record at ${sandboxDir}`).toBe(true);
    const record = readRecord(sandboxDir);
    expect(record.status).toBe("running");
    const supervisor = Object.values(record.commands).find((c) => c.cmd === "zs-agent" && c.exitCode === null);
    expect(supervisor, "a running zs-agent command").toBeDefined();
    expect(pidAlive(supervisor!.pid)).toBe(true);
    const repoPath = path.join(sandboxDir, "workspaces", fixture.name);
    expect(fs.existsSync(path.join(repoPath, ".git")), `checkout at ${repoPath}`).toBe(true);
    expect(await git(repoPath, ["rev-parse", "HEAD"])).toBe(fixture.sha);
    for (const file of FIXTURE_FILES) expect(fs.existsSync(path.join(repoPath, file))).toBe(true);

    const localHealth = await fetch(`http://127.0.0.1:${record.internal.localApi}/health`).then((r) => r.json());
    expect(localHealth).toMatchObject({ server: { running: true } });
    const serverPid = (localHealth as { server: { pid: number } }).server.pid;
    expect(serverPid).toBeGreaterThan(1);
    expect(pidAlive(serverPid)).toBe(true);
    log(`sandbox ${sandboxName}: supervisor pid ${supervisor!.pid}, server pid ${serverPid}, rpc port ${record.portMap["8443"]}`);

    // 3. /connect: the D26 shape, pointing at the loopback rpc listener.
    const connect = await api<ConnectInfo>("POST", `/api/workspaces/${workspaceId}/connect`, {
      tabId: `e2e-tab-${randomBytes(6).toString("hex")}`,
      reason: "open",
    });
    expect(connect.status, JSON.stringify(connect.body)).toBe(200);
    const info = connect.body;
    expect(info.wsUrl).toBe(`ws://127.0.0.1:${record.portMap["8443"]}/rpc`);
    expect(info.token).toMatch(JWT_RE);
    expect(info.sessionId).toMatch(CONNECT_ID_RE);
    expect(info.workspaceId).toBe(workspaceId);
    expect(info.serverBuild).toBeTypeOf("string");
    expect(Date.parse(info.sessionExpiresAt)).toBeGreaterThan(Date.now());
    const claims = JSON.parse(Buffer.from(info.token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
    expect(claims).toMatchObject({ ws: workspaceId, sid: info.sessionId, aud: info.audience, iss: "zs" });
    log(`connect: ${info.wsUrl} session ${info.sessionId}`);

    // 4. The native Rust client over the round-1 WebSocket transport.
    const before = fs.readFileSync(path.join(repoPath, "README.md"), "utf8");
    const output = await runNativeClient({
      ZS_E2E_WS_URL: info.wsUrl,
      ZS_E2E_TOKEN: info.token,
      ZS_E2E_WORKSPACE_ID: info.workspaceId,
      ZS_E2E_SESSION_ID: info.sessionId,
      ZS_E2E_REPO_PATH: repoPath,
      ZS_E2E_FILE: "README.md",
      ZS_E2E_EXPECT_FILES: FIXTURE_FILES.join(","),
      ZS_E2E_APPEND: APPEND,
    });
    expect(output).toContain("test result: ok. 1 passed");
    const summary = /ZS_E2E_RESULT=(\{.*\})/.exec(output);
    expect(summary, "the native client printed its summary").not.toBeNull();
    const result = JSON.parse(summary![1]) as { worktreeId: number; bufferId: number; entries: number };
    expect(result.entries).toBeGreaterThanOrEqual(FIXTURE_FILES.length);
    log(`native client: worktree ${result.worktreeId}, buffer ${result.bufferId}, ${result.entries} entries`);

    // 5. The edit reached the disk through SaveBuffer.
    const after = fs.readFileSync(path.join(repoPath, "README.md"), "utf8");
    expect(after).toBe(`${before}${APPEND}`);
    expect(await git(repoPath, ["status", "--porcelain"])).toContain("README.md");

    // 6. Stop: the supervisor's SIGTERM path, then the local backend's snapshot; both processes gone.
    const stop = await api<{ runId?: string; state?: string }>("POST", `/api/workspaces/${workspaceId}/stop`);
    expect([200, 202]).toContain(stop.status);
    await pollWorkspace(workspaceId, (w) => w.state === "stopped" && w.workflowRunId === null, 90_000, "stopped");
    const stoppedRecord = readRecord(sandboxDir);
    expect(stoppedRecord.status).toBe("stopped");
    expect(stoppedRecord.commands[Object.keys(record.commands).find((k) => record.commands[k].cmd === "zs-agent")!].exitCode).not.toBeNull();
    expect(pidAlive(supervisor!.pid), "supervisor exited").toBe(false);
    expect(pidAlive(serverPid), "zed-remote-server exited").toBe(false);
    const snapshots = fs.readdirSync(path.join(sandboxDir, "snapshots")).filter((f) => f.endsWith(".tgz"));
    expect(snapshots.length).toBeGreaterThanOrEqual(1);
    log(`workspace ${workspaceId} stopped; snapshot ${snapshots[0]}`);

    // 7. Delete: deleteWorkspace removes the sandbox directory (and its snapshots) and soft-deletes
    //    the row, so nothing of this run stays behind on the machine.
    if (KEEP) {
      log(`ZS_E2E_KEEP=1: keeping workspace ${workspaceId} and ${sandboxDir}`);
      return;
    }
    const del = await api<{ runId?: string }>("DELETE", `/api/workspaces/${workspaceId}`);
    expect(del.status, JSON.stringify(del.body)).toBe(202);
    const goneBy = Date.now() + 90_000;
    for (;;) {
      const res = await api<{ error?: { code?: string } }>("GET", `/api/workspaces/${workspaceId}`);
      if (res.status === 410 || res.status === 404) break;
      if (Date.now() > goneBy) throw new Error(`workspace ${workspaceId} still answers ${res.status} after DELETE`);
      await sleep(2_000);
    }
    expect(fs.existsSync(sandboxDir), "sandbox directory removed").toBe(false);
    expect(await liveSandboxPids(sandboxDir)).toEqual([]);
    deleted = true;
    log(`workspace ${workspaceId} deleted`);
  }
});
