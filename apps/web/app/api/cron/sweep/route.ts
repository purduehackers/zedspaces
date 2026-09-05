import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { handler, json } from "@/lib/api";
import { audit } from "@/lib/audit";
import { mapConcurrent } from "@/lib/concurrency";
import { requireCronSecret } from "@/lib/cron";
import { dbReady } from "@/lib/db";
import { env } from "@/lib/env";
import { runStatus, startLifecycle } from "@/lib/lifecycle";
import { keys, kv, withLock, sweepExpiredKv } from "@/lib/kv";
import { sandboxApi } from "@/lib/sandbox";
import { sessions, users, workspaces, type Workspace } from "@/lib/schema";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Wall-clock budget of one sweep; the next minute's invocation continues where this one stopped. */
const BUDGET_MS = 50_000;

/** How long the sweep holds its lock (longer than {@link BUDGET_MS}, shorter than a minute). */
const LOCK_MS = 55_000;

/**
 * A run the store cannot describe (`unknown`) is treated as lost once it is
 * older than every lifecycle's ceiling (`createWorkspace` waits up to 35
 * minutes, a rebuild adds a 20-minute archive). A run the store reports as
 * pending or running is never reconciled by age: the store is the truth.
 */
const RUN_UNKNOWN_STALE_MS = 60 * 60_000;

/** No activity ping for this long means the sweep asks the platform about the VM. */
const PING_LOST_MS = 5 * 60_000;

/** Consecutive abusive pings (30 s apart) before the workspace is stopped: 15 minutes. */
const CPU_STRIKES = 30;

/** How close the platform timeout must be before the sweep extends it. */
const EXTEND_HORIZON_MS = 3.5 * 3600_000;

/** Minimum gain that justifies an `extendTimeout` call. */
const EXTEND_MIN_GAIN_MS = 30 * 60_000;

/** The controlled restart runs this long before the platform session cap. */
const CAP_LEAD_MS = 30 * 60_000;

/**
 * A session-cap restart resumes the VM for another 24 h, so it only happens
 * when someone is plausibly still using it: an open editor session, or a
 * keepalive or control-plane-verified activity inside this window.
 */
const CAP_RESTART_RECENT_MS = 2 * 3600_000;

/** Counters one sweep reports. */
export interface SweepResult {
  stopped: number;
  extended: number;
  capped: number;
  reconciledRuns: number;
  reconciledVms: number;
  abuse: number;
  skipped: number;
}

/**
 * Step 1: a workspace whose `workflow_run_id` names a terminal run is
 * released, so `/connect` and `DELETE` stop answering `423`/`409` forever
 * (b9 §3.20). A run the store still reports as pending or running is left
 * alone whatever its age; an `unknown` run is released only once it is older
 * than every lifecycle's ceiling.
 */
async function reconcileRuns(now: number): Promise<number> {
  const db = await dbReady();
  const stuck = await db
    .select()
    .from(workspaces)
    .where(and(isNotNull(workspaces.workflowRunId), isNull(workspaces.deletedAt)));
  let reconciled = 0;
  await mapConcurrent(stuck, 8, async (row) => {
    const runId = row.workflowRunId;
    if (!runId) return;
    const status = await runStatus(runId);
    if (status === "pending" || status === "running") return;
    if (status === "unknown") {
      const startedAt = row.workflowRunStartedAt?.getTime() ?? 0;
      if (now - startedAt <= RUN_UNKNOWN_STALE_MS) return;
    }
    await db
      .update(workspaces)
      .set({
        workflowRunId: null,
        workflowRunStartedAt: null,
        ...(status === "completed" ? {} : { state: "error" as const, stateReason: `run_${status}` }),
        updatedAt: new Date(now),
      })
      .where(and(eq(workspaces.id, row.id), eq(workspaces.workflowRunId, runId)));
    reconciled += 1;
  });
  return reconciled;
}

/** Step 2: no ping for five minutes — ask the platform whether the VM is still there. */
async function reconcileVm(row: Workspace, now: number, out: SweepResult): Promise<boolean> {
  if (now - row.updatedAt.getTime() <= PING_LOST_MS) return false;
  const peek = await sandboxApi().get(row.sandboxName, { resume: false });
  if (!peek || peek.status === "stopped" || peek.status === "failed" || peek.status === "aborted") {
    await startLifecycle(row.id, "stopWorkspace", { workspaceId: row.id, reason: "lost" });
    out.reconciledVms += 1;
    return true;
  }
  await audit({
    actorType: "cron",
    actorId: "sweep",
    action: "workspace.unhealthy",
    targetType: "workspace",
    targetId: row.id,
  });
  return false;
}

/** Step 6: keep the rolling platform timeout roughly four hours ahead. */
async function extendTimeout(row: Workspace, now: number, out: SweepResult): Promise<void> {
  const e = env();
  const capAt = (row.sessionStartedAt?.getTime() ?? now) + e.ZS_SESSION_CAP_MS;
  const desired = Math.min(now + e.ZS_SESSION_TIMEOUT_MS, capAt);
  const expiresAt = row.sandboxExpiresAt?.getTime() ?? 0;
  if (expiresAt - now >= EXTEND_HORIZON_MS) return;
  if (desired - expiresAt <= EXTEND_MIN_GAIN_MS) return;
  const peek = await sandboxApi().get(row.sandboxName, { resume: false });
  if (!peek || peek.status !== "running") return;
  await peek.extendTimeout(desired - (peek.expiresAt?.getTime() ?? now));
  const db = await dbReady();
  await db
    .update(workspaces)
    .set({ sandboxExpiresAt: new Date(desired) })
    .where(eq(workspaces.id, row.id));
  out.extended += 1;
}

/** Workspaces with an open `sessions` row (someone connected since the last stop). */
async function openSessionWorkspaces(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const db = await dbReady();
  const rows = await db
    .select({ workspaceId: sessions.workspaceId })
    .from(sessions)
    .where(and(inArray(sessions.workspaceId, ids), isNull(sessions.endedAt)));
  return new Set(rows.map((row) => row.workspaceId));
}

async function sweep(now: number): Promise<SweepResult> {
  const out: SweepResult = {
    stopped: 0,
    extended: 0,
    capped: 0,
    reconciledRuns: 0,
    reconciledVms: 0,
    abuse: 0,
    skipped: 0,
  };
  const budgetEnd = now + BUDGET_MS;
  out.reconciledRuns = await reconcileRuns(now);

  const db = await dbReady();
  const running = await db
    .select()
    .from(workspaces)
    .where(
      and(eq(workspaces.state, "running"), isNull(workspaces.workflowRunId), isNull(workspaces.deletedAt)),
    );
  if (running.length === 0) return out;

  const store = kv();
  const [activity, keepalive, health, cpu, busy, attached] = await Promise.all([
    store.mget(running.map((row) => keys.activity(row.id))),
    store.mget(running.map((row) => keys.keepalive(row.id))),
    store.mget(running.map((row) => keys.health(row.id))),
    store.mget(running.map((row) => keys.cpu(row.id))),
    store.mget(running.map((row) => keys.busy(row.id))),
    openSessionWorkspaces(running.map((row) => row.id)),
  ]);

  await mapConcurrent(running, 8, async (row, index) => {
    if (Date.now() > budgetEnd) {
      out.skipped += 1;
      return;
    }
    const sessionStartedAt = row.sessionStartedAt?.getTime() ?? now;
    // The same clock the activity directive shows the supervisor: a VM that
    // just resumed is not idle, whatever the row remembers from before the stop.
    const lastActive = Math.max(
      Number(activity[index] ?? 0),
      Number(keepalive[index] ?? 0),
      sessionStartedAt,
      row.lastActiveAt.getTime(),
    );
    const idleMs = now - lastActive;
    const thresholdMs = row.idleMinutes * 60_000;
    const sessionAge = now - sessionStartedAt;

    if (health[index] === null && (await reconcileVm(row, now, out))) return;

    // Abuse (§7.11): no session, nothing bootstrapping, and sustained CPU.
    if (Number(cpu[index] ?? 0) >= CPU_STRIKES) {
      await startLifecycle(row.id, "stopWorkspace", { workspaceId: row.id, reason: "abuse" });
      await db
        .update(users)
        .set({ flaggedAt: new Date(now), flagReason: "sustained_cpu_no_session", updatedAt: new Date(now) })
        .where(eq(users.id, row.ownerUserId));
      out.abuse += 1;
      return;
    }

    // D13: never stop a workspace whose supervisor reports a lifecycle command,
    // a clone or a restore in flight.
    if (idleMs >= thresholdMs && busy[index] === null) {
      await startLifecycle(row.id, "stopWorkspace", { workspaceId: row.id, reason: "idle" });
      out.stopped += 1;
      return;
    }

    if (sessionAge >= env().ZS_SESSION_CAP_MS - CAP_LEAD_MS) {
      const recentlyUsed =
        attached.has(row.id) ||
        now - Math.max(Number(keepalive[index] ?? 0), Number(activity[index] ?? 0)) <= CAP_RESTART_RECENT_MS;
      if (recentlyUsed) {
        await startLifecycle(row.id, "restartSession", { workspaceId: row.id });
        out.capped += 1;
      } else {
        // Nobody is attached: let the cap end the session instead of resuming it for another day.
        await startLifecycle(row.id, "stopWorkspace", { workspaceId: row.id, reason: "cap" });
        out.stopped += 1;
      }
      return;
    }

    await extendTimeout(row, now, out);
  });

  return out;
}

/**
 * `GET /api/cron/sweep` – the every-minute lifecycle sweep (b9 §4.10): dead
 * runs, dead VMs, the spend cap, the abuse rule, idle stops, the session-cap
 * restart and the rolling platform timeout. One instance at a time, inside a
 * 50 s budget.
 */
export const GET = handler(async (req: Request) => {
  requireCronSecret(req);
  await sweepExpiredKv();
  const result = await withLock(keys.lock("sweep"), LOCK_MS, () => sweep(Date.now()));
  return result ? json({ ran: true, ...result }) : json({ ran: false, reason: "locked" });
});
