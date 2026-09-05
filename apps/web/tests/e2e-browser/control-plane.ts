import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Page, TestInfo } from "@playwright/test";

const execFileAsync = promisify(execFile);

/**
 * The control-plane side of the browser suite: the dev-auth API as a client
 * (`fetch` from node sends a loopback `Host` and no fetch metadata, which is
 * exactly what `lib/dev-auth.ts` admits), fixture repositories under
 * `ZS_LOCAL_REPOS_DIR`, and the test-only `/test-local` route of
 * `lib/test-routes.ts`. Mirrors the native suite's `tests/e2e-native/flow.test.ts`.
 */

export const BASE_URL = process.env.ZS_E2E_BASE_URL ?? "";
export const REPOS_DIR = process.env.ZS_E2E_REPOS_DIR ?? "";
export const BUILD_ID = process.env.ZS_E2E_BUILD_ID ?? "";
export const LSP_TOOLS_BIN = process.env.ZS_E2E_LSP_TOOLS_BIN ?? "";
// CommonJS under Playwright's transform: `__dirname`, never `import.meta`.
const FIXTURE_TEMPLATE = path.join(__dirname, "fixtures", "repo");

export function log(message: string): void {
  process.stderr.write(`[e2e-browser] ${new Date().toISOString().slice(11, 19)} ${message}\n`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WorkspaceView {
  id: string;
  state: string;
  stateReason: string | null;
  workflowRunId: string | null;
  serverBuild: string;
  clientBuild: string;
  repo: { owner: string; name: string; defaultBranch: string };
}

export interface ConnectInfo {
  wsUrl: string;
  token: string;
  sessionId: string;
  workspaceId: string;
}

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
  workspaceDir: string | null;
  supervisor: { running: boolean; pid: number | null } | null;
}

export interface ApiResponse<T> {
  status: number;
  body: T;
}

/** One JSON call against the control plane. */
export async function api<T = unknown>(method: string, route: string, body?: unknown): Promise<ApiResponse<T>> {
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

/** git with the developer's global config kept out of the fixture. */
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "e2e",
  GIT_AUTHOR_EMAIL: "e2e@localhost",
  GIT_COMMITTER_NAME: "e2e",
  GIT_COMMITTER_EMAIL: "e2e@localhost",
};

/** `git -C <repo> <args>` with the fixture's isolated config; resolves with trimmed stdout. */
export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repo, ...args], { env: GIT_ENV });
  return stdout.trim();
}

export interface FixtureRepo {
  name: string;
  dir: string;
  sha: string;
  remove(): void;
}

/**
 * A git repository under `ZS_LOCAL_REPOS_DIR` from `fixtures/repo/` (README,
 * a Rust file, a TypeScript project). When the language servers are installed
 * (`ZS_E2E_LSP_TOOLS_BIN`) the fixture also carries `.zed/settings.json`
 * pointing `vtsls`/`typescript-language-server` at those binaries, so the
 * server starts them without a download. Optional settings are repo-local;
 * they never alter the shared dev user's settings document.
 */
export async function createFixtureRepo(prefix = "e2e-browser", settingsOverrides: Record<string, unknown> = {}): Promise<FixtureRepo> {
  if (!REPOS_DIR) throw new Error("ZS_E2E_REPOS_DIR is not set (run through scripts/dev-local.sh browser)");
  const name = `${prefix}-${randomBytes(4).toString("hex")}`;
  const dir = path.join(REPOS_DIR, name);
  fs.cpSync(FIXTURE_TEMPLATE, dir, { recursive: true });
  const settings: Record<string, unknown> = { ...settingsOverrides };
  if (LSP_TOOLS_BIN) {
    settings.lsp = {
      ...(typeof settings.lsp === "object" && settings.lsp !== null ? settings.lsp : {}),
      vtsls: { binary: { path: path.join(LSP_TOOLS_BIN, "vtsls"), arguments: ["--stdio"] } },
      "typescript-language-server": {
        binary: { path: path.join(LSP_TOOLS_BIN, "typescript-language-server"), arguments: ["--stdio"] },
      },
    };
  }
  if (Object.keys(settings).length > 0) {
    fs.mkdirSync(path.join(dir, ".zed"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".zed", "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  }
  await execFileAsync("git", ["init", "-q", "-b", "main", dir], { env: GIT_ENV });
  await git(dir, ["add", "-A"]);
  await git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
  const sha = await git(dir, ["rev-parse", "HEAD"]);
  return { name, dir, sha, remove: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Polls `GET /api/workspaces/{id}` until `until` holds; throws on `error` or after `timeoutMs`. */
export async function pollWorkspace(
  id: string,
  until: (workspace: WorkspaceView) => boolean,
  timeoutMs: number,
  what: string,
): Promise<WorkspaceView> {
  const deadline = Date.now() + timeoutMs;
  let lastReason: string | null | undefined;
  for (;;) {
    const res = await api<{ workspace: WorkspaceView }>("GET", `/api/workspaces/${id}`);
    if (res.status !== 200) throw new Error(`GET /api/workspaces/${id}: ${res.status} ${JSON.stringify(res.body)}`);
    const workspace = res.body.workspace;
    const reason = `${workspace.state}/${workspace.stateReason ?? ""}`;
    if (reason !== lastReason) {
      log(`workspace ${id}: ${reason}`);
      lastReason = reason;
    }
    if (until(workspace)) return workspace;
    if (workspace.state === "error") throw new Error(`workspace ${id} entered error: ${workspace.stateReason ?? "(no reason)"}`);
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}; last ${reason}`);
    await sleep(1_500);
  }
}

/** `POST /api/workspaces` for a fixture and the wait until it is `running`. */
export async function createRunningWorkspace(fixture: Pick<FixtureRepo, "name">): Promise<WorkspaceView> {
  const created = await api<{ workspace: WorkspaceView; runId: string }>("POST", "/api/workspaces", {
    repo: { installationId: 1, owner: "local", name: fixture.name },
    ref: { branch: "main" },
    machine: "vcpu2",
  });
  if (created.status !== 202) throw new Error(`POST /api/workspaces: ${created.status} ${JSON.stringify(created.body)}`);
  const id = created.body.workspace.id;
  if (BUILD_ID && created.body.workspace.clientBuild !== BUILD_ID) {
    throw new Error(`workspace ${id} was stamped client build ${created.body.workspace.clientBuild}, expected ${BUILD_ID}`);
  }
  log(`workspace ${id} reserved (run ${created.body.runId}); waiting for running`);
  return pollWorkspace(id, (w) => w.state === "running" && !w.workflowRunId, 4 * 60_000, "running");
}

/** `GET /api/workspaces/{id}/test-local`. */
export async function testLocal(id: string): Promise<TestLocalInfo> {
  const res = await api<TestLocalInfo>("GET", `/api/workspaces/${id}/test-local`);
  if (res.status !== 200) throw new Error(`GET /test-local: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

/** `POST /api/workspaces/{id}/test-local`. */
export async function testLocalOp<T>(id: string, body: { op: string; [key: string]: unknown }): Promise<ApiResponse<T>> {
  return api<T>("POST", `/api/workspaces/${id}/test-local`, body);
}

/**
 * Posts one lifecycle notice to the server's control listener the way the supervisor does
 * (`POST /control/lifecycle`, `Authorization: Bearer <control secret>`, loopback only;
 * `zed/crates/remote_server/src/control.rs`), so the idle-stop / session-cap toasts of
 * BUILD-SPEC 5.5 are driven without waiting for a real countdown. The secret is the file the
 * supervisor wrote for the server (`<state>/run/control.secret`, D18). Resolves with the HTTP
 * status (204 when the server accepted it).
 */
export async function postLifecycleNotice(
  info: TestLocalInfo,
  body: { kind: "idle_stop_in" | "session_cap_in"; seconds: number } | { kind: "resumed" | "stopping" },
): Promise<number> {
  if (!info.sandbox.internal) throw new Error("the test route reports no internal listeners for the sandbox");
  const secretFile = path.join(info.sandbox.dir, "state", "run", "control.secret");
  const secret = fs.readFileSync(secretFile, "utf8").replace(/\r?\n$/, "");
  const res = await fetch(`http://127.0.0.1:${info.sandbox.internal.control}/control/lifecycle`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  await res.arrayBuffer();
  return res.status;
}

/**
 * The checkout as the editor sees it. The server canonicalises the worktree root it is handed
 * (`AddWorktree`), and the hooks key on that absolute path; on macOS `$TMPDIR` lives under
 * `/var`, a symlink to `/private/var`, so the route's path has to be resolved the same way.
 */
export function checkoutDir(info: TestLocalInfo): string {
  if (!info.workspaceDir) throw new Error("the test route reports no checkout for the workspace");
  try {
    return fs.realpathSync.native(info.workspaceDir);
  } catch {
    return info.workspaceDir;
  }
}

/** Stops (bounded) and deletes a workspace; every step is best effort and logged. */
export async function destroyWorkspace(id: string): Promise<void> {
  const current = await api<{ workspace: WorkspaceView }>("GET", `/api/workspaces/${id}`);
  if (current.status !== 200) return;
  if (current.body.workspace.state !== "stopped") {
    const deadline = Date.now() + 60_000;
    let stop = await api("POST", `/api/workspaces/${id}/stop`);
    while (stop.status === 423 && Date.now() < deadline) {
      await sleep(2_000);
      stop = await api("POST", `/api/workspaces/${id}/stop`);
    }
    if (stop.status === 200 || stop.status === 202) {
      await pollWorkspace(id, (w) => w.state === "stopped" && !w.workflowRunId, 90_000, "cleanup stop").catch((err: unknown) =>
        log(`cleanup: stop did not complete: ${err instanceof Error ? err.message : String(err)}`),
      );
    } else {
      log(`cleanup: POST /stop answered ${stop.status} ${JSON.stringify(stop.body)}`);
    }
  }
  const del = await api("DELETE", `/api/workspaces/${id}`);
  if (del.status !== 202) {
    log(`cleanup: DELETE answered ${del.status} ${JSON.stringify(del.body)}`);
    return;
  }
  const goneBy = Date.now() + 90_000;
  while (Date.now() < goneBy) {
    const res = await api("GET", `/api/workspaces/${id}`);
    if (res.status === 410 || res.status === 404) return;
    await sleep(2_000);
  }
  log(`cleanup: workspace ${id} still answers after DELETE`);
}

/** The shell overlay's phase attribute (`data-phase` of `[data-zs=overlay]`). */
export async function overlayPhase(page: Page): Promise<string | null> {
  return page.locator('[data-zs="overlay"]').getAttribute("data-phase");
}

/** Console and page errors of a page, for assertions on CSP violations and panics. */
export interface PageLog {
  errors: string[];
  console: string[];
  /** The first Rust panic console line or WebAssembly runtime trap reported by the page. */
  firstPanic: string | null;
  /** Called once with the panic text when it arrives (`hooks.ts` `untilOrPanic`). */
  onPanic: ((text: string) => void)[];
}

// Browser engines spell traps differently. WebKit reports its memory trap as
// "RuntimeError: Out of bounds memory access", not Chromium's "unreachable".
const PANIC_RE = /\[zed-web\] panic|^pageerror: (?:(?:Unhandled Promise Rejection: )?(?:WebAssembly\.)?RuntimeError\b|unreachable\b|out of bounds memory access\b|memory access out of bounds\b)/i;

export function watchPage(page: Page): PageLog {
  const entries: PageLog = { errors: [], console: [], firstPanic: null, onPanic: [] };
  const noteError = (text: string) => {
    entries.errors.push(text);
    if (entries.firstPanic === null && PANIC_RE.test(text)) {
      entries.firstPanic = text;
      for (const listener of entries.onPanic.splice(0)) listener(text);
    }
  };
  page.on("console", (message) => {
    const text = message.text();
    entries.console.push(`[${message.type()}] ${text}`);
    if (message.type() === "error") noteError(text);
  });
  page.on("pageerror", (error) => {
    // Playwright may put the RuntimeError type in `name` without repeating it
    // in `message`; retain it so every WASM trap fails a pending wait promptly.
    const message = /^(?:WebAssembly\.)?RuntimeError$/.test(error.name) && !/^RuntimeError\b/.test(error.message)
      ? `RuntimeError: ${error.message}` : error.message;
    noteError(`pageerror: ${message}`);
  });
  return entries;
}

/**
 * The run this process belongs to: `ZS_E2E_RUN_ID` from `scripts/dev-local.sh browser` (its
 * per-run stamp), else the Playwright runner's pid, which every worker of one run shares.
 */
export const RUN_ID = process.env.ZS_E2E_RUN_ID ?? `pid-${process.ppid}`;

interface TimingsFile {
  runId: string;
  startedAt: string;
  entries: Record<string, unknown>;
}

/**
 * Records a measured duration on the test (annotation + attachment) and in
 * `test-results/e2e-browser-timings.json`. The file belongs to one run: an entry from an
 * earlier run (another bundle, another day) is dropped rather than merged, and every entry
 * names its build, so a stale figure can never be read as current.
 */
export async function recordTiming(info: TestInfo, name: string, ms: number, extra: Record<string, unknown> = {}): Promise<void> {
  info.annotations.push({ type: name, description: `${ms} ms` });
  await info.attach(name, { body: JSON.stringify({ [name]: ms, ...extra }, null, 2), contentType: "application/json" });
  const file = path.join(info.config.rootDir, "..", "..", "test-results", "e2e-browser-timings.json");
  let current: TimingsFile | null = null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<TimingsFile>;
    if (parsed.runId === RUN_ID && parsed.entries && typeof parsed.entries === "object") {
      current = { runId: RUN_ID, startedAt: parsed.startedAt ?? new Date().toISOString(), entries: parsed.entries };
    }
  } catch {
    current = null;
  }
  current ??= { runId: RUN_ID, startedAt: new Date().toISOString(), entries: {} };
  current.entries[`${info.project.name}:${name}`] = { ms, build: BUILD_ID || null, ...extra, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(current, null, 2)}\n`);
}

/** Whether `typescript-language-server` is reachable on this process's PATH (the completions test's precondition). */
export function typescriptLanguageServerOnPath(): string | null {
  const entries = (process.env.PATH ?? "").split(path.delimiter);
  for (const entry of entries) {
    const candidate = path.join(entry, "typescript-language-server");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // next entry
    }
  }
  return null;
}
