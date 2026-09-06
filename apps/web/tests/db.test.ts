import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import { forwards, sessions, workspaces } from "@/lib/schema";
import { SEED, seedWorkspace, testDb } from "./helpers/db";

describe("schema and migrations", () => {
  it("migrates_into_libsql_and_round_trips_rows", async () => {
    const db = await testDb();
    const ws = await seedWorkspace(db, { installedExtensions: ["toml", "html"] });
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id));
    expect(row.state).toBe("running");
    expect(row.installedExtensions).toEqual(["toml", "html"]);
    expect(row.sandboxGeneration).toBe(1);
    expect(row.createdAt).toBeInstanceOf(Date);

  });

  it("allows_multiple_tabs_but_only_one_open_session_per_tab", async () => {
    const db = await testDb();
    const ws = await seedWorkspace(db);
    const base = { workspaceId: ws.id, userId: SEED.userId, sandboxGeneration: 1, holderTabId: "tab-1", wsHost: "h" };
    await db.insert(sessions).values({ id: newId("ses"), ...base });
    await db.insert(sessions).values({ id: newId("ses"), ...base, holderTabId: "tab-2" });
    await expect(db.insert(sessions).values({ id: newId("ses"), ...base })).rejects.toThrow();
    await db.update(sessions).set({ endedAt: new Date(), endReason: "stopped" }).where(eq(sessions.workspaceId, ws.id));
    await db.insert(sessions).values({ id: newId("ses"), ...base });
    const open = await db.select().from(sessions).where(eq(sessions.workspaceId, ws.id));
    expect(open).toHaveLength(3);
  });

  it("forward_slots_are_unique_per_workspace_but_nulls_do_not_collide", async () => {
    const db = await testDb();
    const ws = await seedWorkspace(db);
    await db.insert(forwards).values({ workspaceId: ws.id, port: 3000, visibility: "private", slot: 8444 });
    await expect(
      db.insert(forwards).values({ workspaceId: ws.id, port: 3001, visibility: "private", slot: 8444 }),
    ).rejects.toThrow();
    await db.insert(forwards).values({ workspaceId: ws.id, port: 5173, visibility: "public", slot: null });
    await db.insert(forwards).values({ workspaceId: ws.id, port: 8000, visibility: "public", slot: null });
    const rows = await db.select().from(forwards).where(eq(forwards.workspaceId, ws.id));
    expect(rows).toHaveLength(3);
  });
});
