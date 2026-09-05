/**
 * Starting and observing a child workflow (b9 §3.19). `start()` and
 * `getRun()` are stubs inside the workflow runtime, so every call lives in a
 * `"use step"` function. A step is one function invocation with the
 * platform's duration ceiling, so no step here ever *waits* for a child: the
 * parent starts it, polls its status from the workflow body between
 * `sleep()`s, and reads the return value in a final short step
 * (`workflows/child.ts`).
 */
import { FatalError } from "workflow";
import { getRun } from "workflow/api";
import { newJti } from "@/lib/ids";
import { startRun, type LifecycleWorkflowName, type RunStatus } from "@/lib/lifecycle";
import { keys, kv } from "@/lib/kv";

/** How long the token → run id mapping outlives the child (no lifecycle takes a week). */
const CHILD_TOKEN_TTL_MS = 7 * 86_400_000;

/**
 * A fresh token the parent uses to name one child start. Step results are
 * memoized by the runtime, so a replayed workflow body sees the same token
 * and {@link stepStartChild} attaches to the child it already started.
 */
export async function stepNewChildToken(): Promise<string> {
  "use step";
  return newJti();
}

/**
 * Starts `name` with `args` unless a child was already started under
 * `token` (a retried step, or a replay), in which case that run id is
 * returned and no second child is created.
 */
export async function stepStartChild(
  token: string,
  name: LifecycleWorkflowName,
  args: unknown,
): Promise<{ runId: string }> {
  "use step";
  const store = kv();
  const key = keys.childRun(token);
  const existing = await store.get(key);
  if (existing) return { runId: existing };
  const { runId } = await startRun(name, args);
  await store.set(key, runId, { exMs: CHILD_TOKEN_TTL_MS });
  return { runId };
}

/** The run store's status of a child, `"unknown"` when it cannot be read. */
export async function stepChildStatus(runId: string): Promise<RunStatus> {
  "use step";
  try {
    return await getRun(runId).status;
  } catch {
    return "unknown";
  }
}

/**
 * The return value of a finished child. A child failure becomes a
 * {@link FatalError} so the parent's `catch` records it and stops rather than
 * retrying a whole lifecycle.
 */
export async function stepChildResult(name: LifecycleWorkflowName, runId: string): Promise<unknown> {
  "use step";
  try {
    return await getRun(runId).returnValue;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new FatalError(`child_${name}_failed: ${message}`);
  }
}
