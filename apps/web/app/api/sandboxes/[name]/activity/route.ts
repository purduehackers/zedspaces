import { and, eq, isNull } from "drizzle-orm";
import { handler, json, parseBody, type RouteCtx } from "@/lib/api";
import { dbReady } from "@/lib/db";
import { env } from "@/lib/env";
import { keys, kv } from "@/lib/kv";
import { requireSandboxParam, type SandboxParams } from "@/lib/sandbox-request";
import { sessions, workspaces, type Workspace } from "@/lib/schema";
import { activityReport, type ActivityDirective, type ActivityReport } from "@/lib/types";
import { forwardViews } from "@/lib/views";

export const runtime = "nodejs";

/** How long the health, busy and cpu keys outlive one 30 s ping. */
const PING_TTL_MS = 120_000;

/** `last_active_at` is bumped at most this often; every ping would be a write per 30 s. */
const LAST_ACTIVE_WRITE_MS = 60_000;

/** Consecutive abusive pings before the sweep stops the workspace (15 min at 30 s). */
const CPU_STRIKE_TTL_MS = 20 * 60_000;

/** A reported input instant may lead the control plane's clock by at most this much. */
const CLOCK_SKEW_MS = 30_000;

/**
 * How long after the VM session started a `busy` / non-`ready` report still
 * counts as activity (D13). A first boot's `postCreateCommand` has b8's
 * 30-minute budget; nothing legitimate bootstraps for an hour, and the
 * supervisor runs inside the tenant's VM, so its word is bounded.
 */
const BUSY_EXTENDS_MS = 60 * 60_000;

/** What the control plane itself knows about the workspace's editor session. */
interface SessionFacts {
  /** An open `sessions` row exists: someone connected since the last stop. */
  attached: boolean;
}

async function sessionFacts(workspace: Workspace): Promise<SessionFacts> {
  const db = await dbReady();
  const [open] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, workspace.id), isNull(sessions.endedAt)))
    .limit(1);
  return { attached: Boolean(open) };
}

/**
 * D13: a sandbox that is cloning, restoring or running the user's
 * `postCreateCommand` counts as active, so the idle sweep never stops it
 * mid-bootstrap — for at most {@link BUSY_EXTENDS_MS} after the session began.
 */
function isBusy(workspace: Workspace, report: ActivityReport, now: number): boolean {
  if (!(report.busy || report.phase !== "ready")) return false;
  const startedAt = workspace.sessionStartedAt?.getTime() ?? now;
  return now - startedAt <= BUSY_EXTENDS_MS;
}

/**
 * The instant this ping says the workspace was last active. `busy` counts as
 * activity (D13); otherwise the server's `last_input_at` wins — clamped into
 * `[sessionStartedAt, now + skew]` and only while the control plane knows an
 * editor session was opened on this VM session (input without a client is
 * not input) — and a ping that reports neither leaves the previous value
 * alone.
 */
async function activityInstant(
  workspace: Workspace,
  report: ActivityReport,
  facts: SessionFacts,
  now: number,
): Promise<number> {
  if (isBusy(workspace, report, now)) return now;
  const floor = workspace.sessionStartedAt?.getTime() ?? 0;
  if (typeof report.lastInputAt === "number" && facts.attached) {
    return Math.min(Math.max(report.lastInputAt, floor), now + CLOCK_SKEW_MS);
  }
  const previous = Number((await kv().get(keys.activity(workspace.id))) ?? 0);
  return Math.max(previous, floor, workspace.lastActiveAt.getTime());
}

async function writeActivityKeys(
  workspace: Workspace,
  report: ActivityReport,
  facts: SessionFacts,
  now: number,
  activityAt: number,
): Promise<void> {
  const store = kv();
  const activityTtlMs = Math.max(PING_TTL_MS, 2 * workspace.idleMinutes * 60_000);
  const busy = isBusy(workspace, report, now);
  await store.set(keys.activity(workspace.id), String(activityAt), { exMs: activityTtlMs });
  if (busy) {
    await store.set(keys.busy(workspace.id), report.phase, { exMs: PING_TTL_MS });
  } else {
    await store.del(keys.busy(workspace.id));
  }
  await store.set(keys.health(workspace.id), String(now), { exMs: PING_TTL_MS });
  if (report.listening) {
    const ports = [...new Set(report.listening.map((entry) => entry.port))].sort((a, b) => a - b);
    await store.set(keys.listening(workspace.id), JSON.stringify(ports), { exMs: PING_TTL_MS });
  }
  // The abuse rule (§4.10) only counts pings with no session and no lifecycle
  // command running: a postCreateCommand pinning the CPU is not abuse. "No
  // session" is the control plane's own knowledge, never the report's flag.
  const cpu = report.cpuBusyPct;
  if (typeof cpu === "number" && !facts.attached && !busy && cpu > 80) {
    await store.incr(keys.cpu(workspace.id), CPU_STRIKE_TTL_MS);
  } else if (typeof cpu === "number") {
    await store.del(keys.cpu(workspace.id));
  }
}

async function syncWorkspaceRow(
  workspace: Workspace,
  report: ActivityReport,
  now: number,
  activityAt: number,
): Promise<void> {
  const db = await dbReady();
  const busy = isBusy(workspace, report, now);
  const reason = busy ? `boot:${report.phase}` : null;
  const patch: Partial<typeof workspaces.$inferInsert> = {};
  if (workspace.state === "running" && workspace.stateReason !== reason) patch.stateReason = reason;
  // `last_active_at` is the durable fallback for the (TTL-bound) activity key,
  // so it tracks the activity instant — never the ping's arrival time, which
  // would keep every workspace alive forever.
  if (activityAt - workspace.lastActiveAt.getTime() > LAST_ACTIVE_WRITE_MS) {
    patch.lastActiveAt = new Date(Math.min(activityAt, now + CLOCK_SKEW_MS));
  }
  if (Object.keys(patch).length === 0) return;
  await db
    .update(workspaces)
    .set({ ...patch, updatedAt: new Date(now) })
    .where(eq(workspaces.id, workspace.id));
}

function directiveFor(
  workspace: Workspace,
  report: ActivityReport,
  now: number,
  activityAt: number,
  keepaliveAt: number,
  forwards: Awaited<ReturnType<typeof forwardViews>>,
): ActivityDirective {
  const sessionStartedAt = workspace.sessionStartedAt?.getTime() ?? null;
  const lastActive = Math.max(
    activityAt,
    keepaliveAt,
    sessionStartedAt ?? 0,
    isBusy(workspace, report, now) ? now : 0,
    workspace.lastActiveAt.getTime(),
  );
  return {
    idleStopAt: lastActive + workspace.idleMinutes * 60_000,
    sessionCapAt: sessionStartedAt === null ? null : sessionStartedAt + env().ZS_SESSION_CAP_MS,
    // Backstop: if the SIGTERM of `stopWorkspace` never arrives, the supervisor
    // stops itself on the next ping (b8 §3.16 step 8).
    stop: workspace.state === "stopping",
    forwards,
    serverTime: now,
  };
}

/**
 * `POST /api/sandboxes/{name}/activity` – the lifecycle hinge (b9 §3.25). One
 * indexed read, one conditional write, and the `ActivityDirective` the
 * supervisor turns into its `IDLE_STOP_IN` / `SESSION_CAP_IN` notices. Every
 * field of the report is self-reported by the tenant VM and is therefore
 * bounded here rather than trusted.
 */
export const POST = handler(async (req: Request, ctx: RouteCtx<SandboxParams>) => {
  const principal = await requireSandboxParam(req, ctx, "sandbox.activity");
  const report = await parseBody(req, activityReport, { maxBytes: 64 * 1024 });
  const now = Date.now();
  const { workspace } = principal;
  const facts = await sessionFacts(workspace);
  const activityAt = await activityInstant(workspace, report, facts, now);
  await writeActivityKeys(workspace, report, facts, now, activityAt);
  await syncWorkspaceRow(workspace, report, now, activityAt);
  const keepaliveAt = Number((await kv().get(keys.keepalive(workspace.id))) ?? 0);
  const forwards = await forwardViews(workspace.id);
  return json(directiveFor(workspace, report, now, activityAt, keepaliveAt, forwards));
});
