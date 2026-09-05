/**
 * A stand-in for `@/lib/lifecycle` in route tests: it records the workflow
 * starts a handler makes instead of talking to the Workflow runtime or the
 * sandbox SDK. Installed with
 *
 * ```ts
 * vi.mock("@/lib/lifecycle", async () => (await import("../helpers/lifecycle-mock")).createLifecycleMock());
 * ```
 */
import { ApiError } from "@/lib/api";

/** One recorded `startLifecycle` / `startRun` call. */
export interface RecordedRun {
  workspaceId: string | null;
  name: string;
  args: unknown;
  runId: string;
}

/** Everything a test can inspect or script on the fake lifecycle layer. */
export interface FakeLifecycleState {
  runs: RecordedRun[];
  /** Status `runStatus`/`isRunActive` report for any run id. */
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  /** `publicForwardUrl` answer; set to `null` to make it throw `workspace_not_running`. */
  publicUrl: string | null;
  /** What `listeningPorts` reports. */
  listening: number[];
  nextRunId: number;
}

const KEY = "__zsFakeLifecycle";
type GlobalWithLifecycle = typeof globalThis & { [KEY]?: FakeLifecycleState };

/** The current fake-lifecycle state (created on first use). */
export function lifecycleState(): FakeLifecycleState {
  const g = globalThis as GlobalWithLifecycle;
  if (!g[KEY]) {
    g[KEY] = { runs: [], status: "running", publicUrl: null, listening: [], nextRunId: 1 };
  }
  return g[KEY];
}

/** Clears recorded runs and restores the defaults. */
export function resetLifecycle(): void {
  Object.assign(lifecycleState(), {
    runs: [],
    status: "running",
    publicUrl: null,
    listening: [],
    nextRunId: 1,
  });
}

/** The runs a test expects the handler to have started. */
export function recordedRuns(): RecordedRun[] {
  return lifecycleState().runs;
}

/** The module namespace a `vi.mock("@/lib/lifecycle", …)` factory returns. */
export function createLifecycleMock(): Record<string, unknown> {
  return {
    startLifecycle: async (workspaceId: string, name: string, args: unknown) => {
      const state = lifecycleState();
      const runId = `run_${state.nextRunId++}`;
      state.runs.push({ workspaceId, name, args, runId });
      return { runId };
    },
    startRun: async (name: string, args: unknown) => {
      const state = lifecycleState();
      const runId = `run_${state.nextRunId++}`;
      state.runs.push({ workspaceId: null, name, args, runId });
      return { runId };
    },
    runStatus: async () => lifecycleState().status,
    isRunActive: async (runId: string | null) => {
      if (!runId) return false;
      const status = lifecycleState().status;
      return status === "pending" || status === "running";
    },
    publicForwardUrl: async () => {
      const url = lifecycleState().publicUrl;
      if (!url) throw new ApiError(409, "workspace_not_running", "The sandbox is not running");
      return url;
    },
    listeningPorts: async () => lifecycleState().listening,
  };
}
