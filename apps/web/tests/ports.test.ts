import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { proxySlots } from "@/lib/env";
import { allocateSlot, authRedirect, privateForwardUrl, slotHost } from "@/lib/ports";
import { forwards } from "@/lib/schema";
import { seedWorkspace, testDb } from "./helpers/db";

describe("proxy-slot allocation (D8)", () => {
  it("slot_allocation", async () => {
    const db = await testDb();
    const ws = await seedWorkspace(db);
    const slots = proxySlots();

    async function forwardPrivate(port: number): Promise<number> {
      return db.transaction(async (tx) => {
        const slot = await allocateSlot(tx, ws.id, port);
        await tx
          .insert(forwards)
          .values({ workspaceId: ws.id, port, visibility: "private", slot, url: privateForwardUrl(ws.id, port) });
        return slot;
      });
    }

    const ports = [3000, 3001, 4000, 5000];
    for (let i = 0; i < ports.length; i += 1) {
      expect(await forwardPrivate(ports[i])).toBe(slots[i]);
    }

    // A fifth private forward has no slot.
    let caught: unknown;
    try {
      await forwardPrivate(5173);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(409);
    expect((caught as ApiError).code).toBe("no_free_slot");

    // Re-allocating for a port that already holds a slot returns that slot.
    expect(await db.transaction((tx) => allocateSlot(tx, ws.id, 3001))).toBe(slots[1]);

    // Unforwarding frees the slot and the next private forward reuses it.
    await db.delete(forwards).where(and(eq(forwards.workspaceId, ws.id), eq(forwards.port, 3001)));
    expect(await forwardPrivate(5173)).toBe(slots[1]);

    // A public forward has no slot.
    await db.insert(forwards).values({ workspaceId: ws.id, port: 8000, visibility: "public", slot: null, url: "https://x" });
    const [pub] = await db.select().from(forwards).where(and(eq(forwards.workspaceId, ws.id), eq(forwards.port, 8000)));
    expect(pub.slot).toBeNull();

    expect(privateForwardUrl(ws.id, 3000)).toBe(`https://zs.test/api/workspaces/${ws.id}/ports/3000/open`);
    expect(authRedirect("sb-abc-8444.vercel.run", "tok/en")).toBe(
      "https://sb-abc-8444.vercel.run/__zs/auth?zs_port_token=tok%2Fen&next=%2F",
    );
    expect(slotHost({ currentSlotHosts: { "8444": "host-a" } }, 8444)).toBe("host-a");
    expect(slotHost({ currentSlotHosts: null }, 8444)).toBeNull();
  });
});
