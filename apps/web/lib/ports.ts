import { and, eq, isNotNull } from "drizzle-orm";
import { ApiError } from "./api";
import type { DbLike } from "./db";
import { controlApiBase, proxySlots } from "./env";
import { forwards, workspaces, type Workspace } from "./schema";

/** Number of private-port proxy slots per workspace (D8). */
export const PROXY_SLOT_COUNT = 4;

/** Proxy-slot port (as a string key) → host of `domain(slot)` for the current sandbox session. */
export type SlotHosts = Record<string, string>;

/**
 * Allocates a proxy slot for a private forward of `port`. Must run inside
 * the caller's transaction: it locks the workspace row (`SELECT … FOR
 * UPDATE`, so two parallel private forwards of one workspace serialize even
 * when no forward exists yet), returns the slot an existing forward of `port`
 * already holds, else the first free slot of `proxySlots()`, and throws
 * `ApiError(409, "no_free_slot")` when all four are in use.
 */
export async function allocateSlot(db: DbLike, workspaceId: string, port: number): Promise<number> {
  await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, workspaceId));
  const held = await db
    .select({ port: forwards.port, slot: forwards.slot })
    .from(forwards)
    .where(and(eq(forwards.workspaceId, workspaceId), isNotNull(forwards.slot)));
  const existing = held.find((row) => row.port === port && row.slot !== null);
  if (existing && existing.slot !== null) return existing.slot;
  const taken = new Set(held.map((row) => row.slot));
  const free = proxySlots().find((slot) => !taken.has(slot));
  if (free === undefined) {
    throw new ApiError(
      409,
      "no_free_slot",
      "all four private-port slots are in use – unforward one first",
      { slots: proxySlots() },
    );
  }
  return free;
}

/** The public host of `slot` for the workspace's current session, or `null` while stopped. */
export function slotHost(ws: Pick<Workspace, "currentSlotHosts">, slot: number): string | null {
  return ws.currentSlotHosts?.[String(slot)] ?? null;
}

/**
 * `${controlApiBase()}/workspaces/${workspaceId}/ports/${port}/open` – the
 * value shown in the UI, stored in `forwards.url` and sent to the supervisor
 * for a private forward (D8).
 */
export function privateForwardUrl(workspaceId: string, port: number): string {
  return `${controlApiBase()}/workspaces/${workspaceId}/ports/${port}/open`;
}

/**
 * `https://<slotHostname>/__zs/auth?zs_port_token=<token>&next=<next>` – the
 * 303 target of the `/open` route (b8 §3.11 `AUTH_PATH`).
 */
export function authRedirect(slotHostname: string, token: string, next = "/"): string {
  return `https://${slotHostname}/__zs/auth?zs_port_token=${encodeURIComponent(token)}&next=${encodeURIComponent(next)}`;
}
