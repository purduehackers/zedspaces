import { and, eq, inArray } from "drizzle-orm";
import { ApiError } from "./api";
import { dbReady, type DbLike } from "./db";
import { env, isInfraPort, proxySlots } from "./env";
import { keys } from "./kv";
import { allocateSlot, privateForwardUrl, publicSlotUrl } from "./ports";
import { forwards, kvEntries, type PortVisibility, type Workspace } from "./schema";
import type { ActivityReport, ForwardView } from "./types";
import { toForwardView } from "./views";

export interface CreateForwardRequest {
  port: number;
  visibility: PortVisibility;
  label?: string | null;
}

function assertForwardablePort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ApiError(400, "invalid_port", `${port} is not a port number`);
  }
  if (isInfraPort(port)) {
    throw new ApiError(400, "infra_port", `Port ${port} is reserved by the platform`);
  }
}

async function mutedPorts(db: DbLike, workspaceId: string): Promise<Set<number>> {
  const [row] = await db.select().from(kvEntries).where(eq(kvEntries.key, keys.mutedPorts(workspaceId)));
  return new Set(row && (row.expiresAt === null || row.expiresAt > Date.now()) ? JSON.parse(row.value) : []);
}

async function saveMutedPorts(db: DbLike, workspaceId: string, ports: Set<number>): Promise<void> {
  const key = keys.mutedPorts(workspaceId);
  if (!ports.size) { await db.delete(kvEntries).where(eq(kvEntries.key, key)); return; }
  const values = { value: JSON.stringify([...ports]), expiresAt: Date.now() + 30 * 86_400_000 };
  await db.insert(kvEntries).values({ key, ...values }).onConflictDoUpdate({ target: kvEntries.key, set: values });
}

/** Both public and private previews use a proxy, so localhost and IPv6 work too. */
export async function createForward(workspace: Workspace, request: CreateForwardRequest): Promise<ForwardView> {
  assertForwardablePort(request.port);
  const db = await dbReady();
  return db.transaction(async (tx) => {
    const muted = await mutedPorts(tx, workspace.id);
    if (muted.delete(request.port)) await saveMutedPorts(tx, workspace.id, muted);
    const slot = await allocateSlot(tx, workspace.id, request.port);
    const values = {
      visibility: request.visibility,
      label: request.label ?? null,
      slot,
      url: request.visibility === "private"
        ? privateForwardUrl(workspace.id, request.port)
        : publicSlotUrl(workspace, slot),
    };
    const [row] = await tx.insert(forwards)
      .values({ workspaceId: workspace.id, port: request.port, ...values })
      .onConflictDoUpdate({ target: [forwards.workspaceId, forwards.port], set: values })
      .returning();
    return toForwardView(row);
  });
}

/** Reconcile discovery in one write transaction, retaining live URLs and private choices. */
export async function syncListeningForwards(workspace: Workspace, listening: ActivityReport["listening"]): Promise<void> {
  // Local development shares the owner's machine, not an isolated VM.
  if (workspace.state !== "running" || !listening || env().ZS_SANDBOX_BACKEND === "local") return;
  const ports = new Set(listening.map(({ port }) => port).filter((port) => !isInfraPort(port)));
  const db = await dbReady();
  await db.transaction(async (tx) => {
    const muted = await mutedPorts(tx, workspace.id);
    const stillListening = new Set([...muted].filter((port) => ports.has(port)));
    if (muted.size !== stillListening.size) await saveMutedPorts(tx, workspace.id, stillListening);
    const rows = await tx.select().from(forwards).where(eq(forwards.workspaceId, workspace.id));
    const closed = rows.filter((row) => row.visibility === "public" && !ports.has(row.port));
    if (closed.length) {
      await tx.delete(forwards).where(and(
        eq(forwards.workspaceId, workspace.id),
        inArray(forwards.port, closed.map((row) => row.port)),
      ));
    }
    const kept = rows.filter((row) => !closed.includes(row));
    const taken = new Set(kept.map((row) => row.slot));
    const available = proxySlots().filter((slot) => !taken.has(slot));
    let pending = 0;
    for (const port of [...ports].sort((a, b) => a - b)) {
      if (stillListening.has(port)) continue;
      const existing = kept.find((row) => row.port === port);
      // Never undo an explicit private choice.
      if (existing?.visibility === "private") continue;
      const slot = existing?.slot ?? available.shift();
      if (slot === undefined) { pending++; continue; }
      const url = publicSlotUrl(workspace, slot);
      if (!url || (existing?.url === url && existing.slot === slot)) continue;
      await tx.insert(forwards)
        .values({ workspaceId: workspace.id, port, visibility: "public", slot, url })
        .onConflictDoUpdate({ target: [forwards.workspaceId, forwards.port], set: { slot, url } });
    }
    if (pending) console.warn("Preview port limit reached", { workspaceId: workspace.id, pending });
  });
}

/** An explicit unforward stays off until that listener closes or the user forwards it again. */
export async function removeForward(workspaceId: string, port: number): Promise<void> {
  assertForwardablePort(port);
  const db = await dbReady();
  await db.transaction(async (tx) => {
    const muted = await mutedPorts(tx, workspaceId);
    muted.add(port);
    await saveMutedPorts(tx, workspaceId, muted);
    await tx.delete(forwards).where(and(eq(forwards.workspaceId, workspaceId), eq(forwards.port, port)));
  });
}
