/**
 * Unit tests of `lib/sandbox-local.ts` that need no control plane: the path
 * mapping, the `local/<name>` repository provider against a real git fixture,
 * and the process lifecycle of the backend (`create` → `runDetached` with a
 * stand-in `zs-agent` → `waitCommand`/`killCommand` → `stop` → resume →
 * `delete`) with the environment the real supervisor would receive.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _resetEnvForTests } from "@/lib/env";
import { SandboxError } from "@/lib/sandbox-error";
import {
  LOCAL_INSTALLATION_ID,
  LOCAL_REPO_OWNER,
  isLocalRepo,
  localBackendEnabled,
  localCloneUrl,
  localFetchRepo,
  localGithubRepoId,
  localRepoPath,
  localResolveRef,
  localSandboxApi,
  localSandboxRecord,
  mapSandboxPath,
} from "@/lib/sandbox-local";

const execFileAsync = promisify(execFile);

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@localhost",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@localhost",
};

async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { env: GIT_ENV });
  return stdout.trim();
}

/**
 * A stand-in `zs-agent`: records its environment and arguments, then sleeps
 * until SIGTERM (exit 0) like the real supervisor's stop path.
 */
const FAKE_AGENT = `#!/bin/sh
env | sort > "$ZS_STATE_DIR/agent.env"
printf '%s\\n' "$@" > "$ZS_STATE_DIR/agent.args"
trap 'exit 0' TERM
while :; do sleep 1; done
`;

let root: string;
let sha: string;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "zs-local-test-"));
  const agent = path.join(root, "zs-agent");
  fs.writeFileSync(agent, FAKE_AGENT, { mode: 0o755 });
  for (const key of ["ZS_SANDBOX_BACKEND", "ZS_LOCAL_ROOT", "ZS_LOCAL_REPOS_DIR", "ZS_AGENT_BIN", "ZS_SERVE_BIN"]) {
    saved[key] = process.env[key];
  }
  process.env.ZS_SANDBOX_BACKEND = "local";
  process.env.ZS_LOCAL_ROOT = path.join(root, "sandboxes");
  process.env.ZS_LOCAL_REPOS_DIR = path.join(root, "repos");
  process.env.ZS_AGENT_BIN = agent;
  process.env.ZS_SERVE_BIN = path.join(root, "fake-serve");
  _resetEnvForTests();

  const repo = path.join(root, "repos", "fixture");
  fs.mkdirSync(path.join(repo, ".devcontainer"), { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# fixture\n");
  fs.writeFileSync(
    path.join(repo, ".devcontainer", "devcontainer.json"),
    '{ "image": "mcr.microsoft.com/devcontainers/base:ubuntu", "remoteEnv": { "FOO": "bar" } }\n',
  );
  await execFileAsync("git", ["init", "-q", "-b", "main", repo], { env: GIT_ENV });
  await git(repo, ["add", "-A"]);
  await git(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
  sha = await git(repo, ["rev-parse", "HEAD"]);
});

afterAll(async () => {
  // An assertion that fails between `runDetached` and `killCommand`/`delete` must not leave the
  // stand-in supervisor looping on `sleep 1` forever: delete every sandbox under the test root
  // (its `terminateAll` signals the recorded process groups) before the root itself goes.
  try {
    const api = localSandboxApi();
    for await (const summary of api.listByTag({})) {
      const handle = await api.get(summary.name, { resume: false });
      await handle?.delete();
    }
  } catch (err) {
    process.stderr.write(`[local-backend.test] cleanup failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetEnvForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("mapSandboxPath", () => {
  it("maps the sandbox filesystem onto the sandbox directory", () => {
    expect(mapSandboxPath("/s", "/")).toBe("/s");
    expect(mapSandboxPath("/s", "/tmp/zs-rebuild.tgz")).toBe("/s/tmp/zs-rebuild.tgz");
    expect(mapSandboxPath("/s", "/workspaces/api")).toBe("/s/workspaces/api");
    expect(mapSandboxPath("/s", "/workspaces")).toBe("/s/workspaces");
    expect(mapSandboxPath("/s", "/vercel/.local/share/zed")).toBe("/s/home/.local/share/zed");
    expect(mapSandboxPath("/s", "/usr/bin/tar")).toBe("/usr/bin/tar");
    expect(mapSandboxPath("/s", "workspaces")).toBe("workspaces");
  });
});

describe("local repositories", () => {
  it("is only the `local` owner while the backend is enabled", () => {
    expect(localBackendEnabled()).toBe(true);
    expect(isLocalRepo(LOCAL_REPO_OWNER)).toBe(true);
    expect(isLocalRepo("acme")).toBe(false);
    expect(LOCAL_INSTALLATION_ID).toBe(1);
  });

  it("refuses names that are not one path segment", () => {
    expect(() => localRepoPath("../etc")).toThrow();
    expect(() => localRepoPath("a/b")).toThrow();
    expect(() => localRepoPath("")).toThrow();
    expect(() => localRepoPath(".")).toThrow();
    expect(localRepoPath("fixture")).toBe(path.join(root, "repos", "fixture"));
  });

  it("clones from a file:// URL and derives a negative github id", () => {
    expect(localCloneUrl("fixture")).toBe(`file://${path.join(root, "repos", "fixture")}`);
    expect(localGithubRepoId("fixture")).toBeLessThan(0);
    expect(localGithubRepoId("fixture")).toBe(localGithubRepoId("fixture"));
    expect(localGithubRepoId("other")).not.toBe(localGithubRepoId("fixture"));
  });

  it("reads repository metadata and refs with git", async () => {
    expect(await localFetchRepo("missing")).toBeNull();
    const repo = await localFetchRepo("fixture");
    expect(repo).toMatchObject({ owner: "local", name: "fixture", defaultBranch: "main", private: false });

    expect(await localResolveRef("fixture", {})).toEqual({ branch: "main", sha, gitRef: null });
    expect(await localResolveRef("fixture", { branch: "main" })).toEqual({ branch: "main", sha, gitRef: null });
    expect(await localResolveRef("fixture", { revision: sha.slice(0, 8) })).toEqual({ branch: null, sha, gitRef: null });
    await expect(localResolveRef("fixture", { branch: "nope" })).rejects.toMatchObject({ status: 404 });
    await expect(localResolveRef("fixture", { pullRequest: 1 })).rejects.toMatchObject({ status: 400 });
    await expect(localResolveRef("missing", {})).rejects.toMatchObject({ status: 404 });

  });
});

describe("the process backend", () => {
  const name = "sb-dev-localtest-g1";
  const input = {
    name,
    region: "iad1" as const,
    vcpus: 2 as const,
    ports: [8443, 8444, 8445, 8446, 8447, 8448, 3000],
    timeoutMs: 3_600_000,
    image: "zs-workspace:test-0",
    env: { ZS_WORKSPACE_ID: "ws_TEST", ZS_SANDBOX_NAME: name, ZS_REGION: "iad1" },
    networkPolicy: "allow-all" as const,
    tags: { zs: "development", ws: "ws_TEST" },
    snapshotExpirationMs: 86_400_000,
    keepLastSnapshots: 1,
  };

  it("creates, spawns the supervisor with the loopback port map, stops, resumes and deletes", async () => {
    const api = localSandboxApi();
    expect(await api.get(name, { resume: false })).toBeNull();

    const handle = await api.create(input);
    expect(handle.status).toBe("running");
    expect(handle.region).toBe("iad1");
    expect(handle.currentSessionId).toMatch(/^lses_/);
    const firstSession = handle.currentSessionId;
    expect(handle.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    const record = localSandboxRecord(name)!;
    const rpc = new URL(handle.domain(8443));
    expect(rpc.hostname).toBe("127.0.0.1");
    expect(Number(rpc.port)).not.toBe(8443);
    // Every infrastructure port is remapped to a distinct loopback port; the pool stays put.
    const mapped = [8443, 8444, 8445, 8446, 8447, 8448].map((port) => Number(new URL(handle.domain(port)).port));
    expect(new Set([...mapped, record.internal.localApi, record.internal.control]).size).toBe(8);
    expect(handle.domain(3000)).toBe("http://127.0.0.1:3000");
    expect(() => handle.domain(9999)).toThrow(/not declared/);
    const dir = path.join(root, "sandboxes", name);
    expect(fs.lstatSync(path.join(dir, "vercel")).isSymbolicLink()).toBe(true);

    // A second create adopts the existing sandbox (getOrCreate).
    const again = await api.create(input);
    expect(again.currentSessionId).toBe(firstSession);

    const { cmdId } = await handle.runDetached({
      cmd: "zs-agent",
      args: ["start"],
      env: { ZS_CONTROL_URL: "http://127.0.0.1:1/api", ZS_SANDBOX_TOKEN: "zsb_test", ZS_SANDBOX_NAME: name, ZS_WORKSPACE_ID: "ws_TEST" },
    });
    await expect(handle.waitCommand(cmdId, 300)).rejects.toBeInstanceOf(SandboxError);
    const envFile = path.join(dir, "state", "agent.env");
    for (let i = 0; i < 50 && !fs.existsSync(envFile); i += 1) await new Promise((r) => setTimeout(r, 100));
    const agentEnv = Object.fromEntries(
      fs
        .readFileSync(envFile, "utf8")
        .split("\n")
        .filter((line) => line.includes("="))
        .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    expect(fs.readFileSync(path.join(dir, "state", "agent.args"), "utf8").trim()).toBe("start");
    expect(agentEnv.ZS_LOCAL).toBe("1");
    expect(agentEnv.HOME).toBe(path.join(dir, "home"));
    expect(agentEnv.ZS_WORKSPACES_DIR).toBe(path.join(dir, "workspaces"));
    expect(agentEnv.ZS_STATE_DIR).toBe(path.join(dir, "state"));
    expect(agentEnv.ZS_RPC_LISTEN).toBe(`127.0.0.1:${rpc.port}`);
    expect(agentEnv.ZS_HEALTH_LISTEN).toBe(`127.0.0.1:${new URL(handle.domain(8448)).port}`);
    expect(agentEnv.ZS_LOCAL_API_LISTEN).toBe(`127.0.0.1:${record.internal.localApi}`);
    expect(agentEnv.ZS_SERVER_CONTROL_LISTEN).toBe(`127.0.0.1:${record.internal.control}`);
    expect(agentEnv.ZS_PROXY_SLOTS).toBe(
      [8444, 8445, 8446, 8447].map((slot) => new URL(handle.domain(slot)).port).join(","),
    );
    expect(agentEnv.ZS_PROXY_BIND_IP).toBe("127.0.0.1");
    expect(agentEnv.ZS_SERVER_BIN).toBe(path.join(root, "fake-serve"));
    expect(agentEnv.ZS_CONTROL_URL).toBe("http://127.0.0.1:1/api");
    expect(agentEnv.ZS_SANDBOX_TOKEN).toBe("zsb_test");
    expect(agentEnv.ZS_WORKSPACE_ID).toBe("ws_TEST");
    expect(agentEnv.ZS_REGION).toBe("iad1");
    expect(agentEnv.ZS_INSECURE_COOKIES).toBe("1");
    expect(agentEnv.PATH).toBeTruthy();

    // `run` executes a plain command with sandbox paths in argv mapped (`/tmp/…` → `<dir>/tmp/…`).
    const echo = await handle.run({ cmd: "sh", args: ["-c", 'echo "$PWD"; printf hi > "$1"', "sh", "/tmp/probe.txt"] });
    expect(echo.exitCode).toBe(0);
    expect(echo.stdout.trim()).toBe(fs.realpathSync(path.join(dir, "workspaces")));
    expect(fs.readFileSync(path.join(dir, "tmp", "probe.txt"), "utf8")).toBe("hi");
    const stream = await handle.readFile("/tmp/probe.txt");
    expect(await new Response(stream!).text()).toBe("hi");
    expect(await handle.readFile("/tmp/missing")).toBeNull();

    // SIGTERM ends the supervisor stand-in cleanly; the exit code is recorded.
    await handle.killCommand(cmdId, "SIGTERM");
    expect(await handle.waitCommand(cmdId, 5_000)).toEqual({ exitCode: 0 });
    expect(localSandboxRecord(name)!.commands[cmdId].exitCode).toBe(0);

    const stopped = await handle.stop();
    expect(stopped.snapshotId).toMatch(/^lsnap_/);
    expect(stopped.snapshotSizeBytes).toBeGreaterThan(0);
    expect(handle.status).toBe("stopped");
    expect(handle.currentSessionId).toBeUndefined();
    expect(await handle.listSnapshotIds()).toEqual([stopped.snapshotId]);
    expect(fs.existsSync(path.join(dir, "snapshots", `${stopped.snapshotId}.tgz`))).toBe(true);
    expect(await handle.stop()).toEqual({ usage: { activeCpuDurationMs: 0, ingressBytes: 0, egressBytes: 0 } });

    let resumedWith: string | undefined;
    const resumed = await api.get(name, {
      resume: true,
      onResume: async (h) => {
        resumedWith = h.currentSessionId;
      },
    });
    expect(resumed?.status).toBe("running");
    expect(resumedWith).toMatch(/^lses_/);
    expect(resumedWith).not.toBe(firstSession);
    expect(handle.currentSessionId).toBe(resumedWith);

    const summaries = [];
    for await (const summary of api.listByTag({ zs: "development" })) summaries.push(summary);
    expect(summaries.map((s) => s.name)).toContain(name);

    await api.deleteSnapshot(stopped.snapshotId!);
    expect(await handle.listSnapshotIds()).toEqual([]);
    await handle.delete();
    expect(fs.existsSync(dir)).toBe(false);
    expect(await api.get(name, { resume: false })).toBeNull();
  });
});
