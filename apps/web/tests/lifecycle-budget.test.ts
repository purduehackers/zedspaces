import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetEnvForTests } from "@/lib/env";
import { _resetKvForTests } from "@/lib/kv";
import { workspaces } from "@/lib/schema";
import { routeDb, seedWorkspace } from "./helpers/route-db";
const execution = vi.hoisted(() => ({ start: vi.fn() }));
vi.mock("workflow/api", () => ({ start: execution.start, getRun: () => ({ status: Promise.resolve("running") }) }));
const { startLifecycle } = await import("@/lib/lifecycle");

beforeEach(async () => {
  process.env.ZS_MAX_RUNNING_WORKSPACES = "2";
  _resetEnvForTests(); _resetKvForTests();
  await routeDb();
  execution.start.mockReset().mockImplementation(async () => ({ runId: `run_${crypto.randomUUID()}` }));
});

describe("shared resume admission", () => {
  it("counts stopped workspaces with admitted resume runs against the global cap", async () => {
    const db = await routeDb();
    const rows = await Promise.all(Array.from({ length: 6 }, () => seedWorkspace(db, { state: "stopped" })));
    const results = await Promise.allSettled(rows.map((ws) => startLifecycle(ws.id, "connectWorkspace", { workspaceId: ws.id })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 429, code: "workspace_limit" });
    expect(execution.start).toHaveBeenCalledTimes(2);
  });
  it("releases a pending reservation if the workflow service fails", async () => {
    const db = await routeDb();
    const ws = await seedWorkspace(db, { state: "stopped" });
    execution.start.mockRejectedValueOnce(new Error("service unavailable"));
    await expect(startLifecycle(ws.id, "connectWorkspace", {})).rejects.toThrow("service unavailable");
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row.workflowRunId).toBeNull();
    await expect(startLifecycle(ws.id, "connectWorkspace", {})).resolves.toHaveProperty("runId");
  });
  it("does not resurrect a run ID if a fast workflow already cleared it", async () => {
    const db = await routeDb();
    const ws = await seedWorkspace(db, { state: "stopped" });
    execution.start.mockImplementationOnce(async () => {
      await db.update(workspaces).set({ workflowRunId: null, workflowRunStartedAt: null }).where(eq(workspaces.id, ws.id));
      return { runId: "finished-before-start-returned" };
    });
    await startLifecycle(ws.id, "connectWorkspace", {});
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row.workflowRunId).toBeNull();
  });
});
