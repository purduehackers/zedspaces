/**
 * `runChild` – runs a child workflow from a parent workflow body without ever
 * blocking a step on it (b9 §3.19 as amended: a step is bounded by the
 * platform's function duration, a `createWorkspace` child by 35 minutes).
 *
 * The start is idempotent (a token minted in a step names the child, so a
 * retried start attaches instead of duplicating), the wait is a poll of the
 * run store paced by `sleep()` (D13: no fixed waits), and the result is read
 * in a final short step.
 */
import { FatalError, sleep } from "workflow";
import type { LifecycleWorkflowName } from "@/lib/lifecycle";
import { stepChildResult, stepChildStatus, stepNewChildToken, stepStartChild } from "./steps/child-steps";

/** How long a child may sit in `unknown` (run store unreadable) before the parent gives up. */
const UNKNOWN_CEILING_MS = 45 * 60_000;

/** Starts `name` with `args`, waits for it to finish and returns its result. */
export async function runChild(name: LifecycleWorkflowName, args: unknown): Promise<unknown> {
  const token = await stepNewChildToken();
  const { runId } = await stepStartChild(token, name, args);
  return awaitChild(name, runId);
}

/**
 * Waits for an already-started run of `name` (one another caller started —
 * an image-build admission, a webhook) and returns its result. The parent
 * never starts a second run for work that is already in flight.
 */
export async function awaitChild(name: LifecycleWorkflowName, runId: string): Promise<unknown> {
  const startedAt = Date.now();
  for (;;) {
    const status = await stepChildStatus(runId);
    if (status === "completed" || status === "failed" || status === "cancelled") break;
    if (status === "unknown" && Date.now() - startedAt > UNKNOWN_CEILING_MS) {
      throw new FatalError(`child_${name}_lost: run ${runId} could not be observed`);
    }
    await sleep("5s");
  }
  return stepChildResult(name, runId);
}
