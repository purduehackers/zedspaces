import fs from "node:fs";
import path from "node:path";
import { ApiError } from "./api";
import { env, EnvError } from "./env";
import { dropRpcConnections, rpcProxyInfo } from "./local-rpc-proxy";
import {
  localBackendEnabled,
  localKillSandboxProcesses,
  localSandboxAlive,
  localSandboxDir,
  localSandboxRecord,
} from "./sandbox-local";
import type { Repo, Workspace } from "./schema";

/**
 * Test-only helpers behind `POST|GET /api/workspaces/{id}/test-local`
 * (`ZS_TEST_ROUTES=1`, local backend only, refused in a production build):
 * what the browser end-to-end suite (`tests/e2e-browser`) needs from the
 * machine the sandbox runs on and cannot reach through the product routes —
 * where the checkout lives on disk, whether the sandbox's processes are
 * alive, severing the live rpc connections (the reconnect test) and killing
 * the processes under a `running` row (the `/connect` reconciliation test).
 */

/** True when `ZS_TEST_ROUTES=1`; throws in a production build whatever the value. */
export function testRoutesEnabled(): boolean {
  const e = env();
  if (e.ZS_TEST_ROUTES !== "1") return false;
  if (e.NODE_ENV === "production" || process.env.NODE_ENV === "production") {
    throw new EnvError(["ZS_TEST_ROUTES"], "ZS_TEST_ROUTES=1 is refused in a production build");
  }
  return true;
}

/** `404 not_found` unless the routes are on and the backend is local (the routes do not exist otherwise). */
export function requireTestRoutes(): void {
  if (!testRoutesEnabled() || !localBackendEnabled()) {
    throw new ApiError(404, "not_found", "Not found");
  }
}

/** `GET /test-local`. */
export interface TestLocalInfo {
  workspace: { id: string; state: string; stateReason: string | null; sandboxName: string; workflowRunId: string | null };
  sandbox: {
    dir: string;
    status: string | null;
    portMap: Record<string, number>;
    internal: { localApi: number; control: number } | null;
    rpcProxy: { port: number; upstreamPort: number; connections: number; listening: boolean } | null;
    alive: boolean;
  };
  /** The checkout on this machine (`<sandbox dir>/workspaces/<repo>`), or `null` without a repo row. */
  workspaceDir: string | null;
  /** The supervisor's own health detail, when its loopback API answers. */
  supervisor: { running: boolean; pid: number | null } | null;
}

interface LocalHealthBody {
  server?: { running?: unknown; pid?: unknown };
}

async function supervisorHealth(localApiPort: number): Promise<TestLocalInfo["supervisor"]> {
  try {
    const res = await fetch(`http://127.0.0.1:${localApiPort}/health`, { signal: AbortSignal.timeout(1_500) });
    if (!res.ok) return null;
    const body = (await res.json()) as LocalHealthBody;
    return {
      running: body.server?.running === true,
      pid: typeof body.server?.pid === "number" ? body.server.pid : null,
    };
  } catch {
    return null;
  }
}

/** What the suite needs to know about a workspace's local sandbox. */
export async function describeLocalWorkspace(workspace: Workspace, repo: Pick<Repo, "name"> | null): Promise<TestLocalInfo> {
  const record = localSandboxRecord(workspace.sandboxName);
  const dir = localSandboxDir(workspace.sandboxName);
  return {
    workspace: {
      id: workspace.id,
      state: workspace.state,
      stateReason: workspace.stateReason,
      sandboxName: workspace.sandboxName,
      workflowRunId: workspace.workflowRunId,
    },
    sandbox: {
      dir,
      status: record?.status ?? null,
      portMap: record?.portMap ?? {},
      internal: record?.internal ?? null,
      rpcProxy: rpcProxyInfo(workspace.sandboxName),
      alive: await localSandboxAlive(workspace.sandboxName),
    },
    workspaceDir: repo ? path.join(dir, "workspaces", repo.name) : null,
    supervisor: record ? await supervisorHealth(record.internal.localApi) : null,
  };
}

/** Severs every live rpc connection of the workspace's sandbox (needs `ZS_LOCAL_RPC_PROXY=1`). */
export function dropWorkspaceSocket(workspace: Workspace): { dropped: number } {
  if (!rpcProxyInfo(workspace.sandboxName)) {
    throw new ApiError(409, "rpc_proxy_off", "No rpc proxy is bound for this sandbox (ZS_LOCAL_RPC_PROXY=1 and a running session)");
  }
  return { dropped: dropRpcConnections(workspace.sandboxName) };
}

/** Kills the sandbox's processes under the running row (see `localKillSandboxProcesses`). */
export async function killWorkspaceSandbox(workspace: Workspace): Promise<{ killed: number[] }> {
  return { killed: await localKillSandboxProcesses(workspace.sandboxName) };
}

/** Reads a file of the checkout; `relative` may not leave the checkout. */
export function readWorkspaceFile(workspaceDir: string, relative: string): { path: string; content: string } | null {
  const resolved = path.resolve(workspaceDir, relative);
  if (resolved !== workspaceDir && !resolved.startsWith(`${workspaceDir}${path.sep}`)) {
    throw new ApiError(400, "invalid_body", "path leaves the workspace");
  }
  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) return null;
  return { path: resolved, content: fs.readFileSync(resolved, "utf8") };
}
