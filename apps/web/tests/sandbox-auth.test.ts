import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api";
import { dbReady } from "@/lib/db";
import { requireSandbox, rotateSandboxToken } from "@/lib/sandbox-auth";
import { workspaces } from "@/lib/schema";
import { insertWorkspaceWithToken, request, seedFixtures } from "./helpers/routes";

async function expectApiError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ status, code });
}

describe("sandbox bearer", () => {
  beforeEach(async () => {
    await seedFixtures();
  });

  it("accepts the token only for its own sandbox", async () => {
    const a = await insertWorkspaceWithToken();
    const b = await insertWorkspaceWithToken();
    const principal = await requireSandbox(request("/", { bearer: a.token }), a.workspace.sandboxName);
    expect(principal.kind).toBe("workspace");
    if (principal.kind === "workspace") expect(principal.workspace.id).toBe(a.workspace.id);
    await expectApiError(
      requireSandbox(request("/", { bearer: a.token }), b.workspace.sandboxName),
      401,
      "sandbox_unauthorized",
    );
  });

  it("rejects a missing header, a wrong token and a rotated token", async () => {
    const { workspace, token } = await insertWorkspaceWithToken();
    await expectApiError(requireSandbox(request("/"), workspace.sandboxName), 401, "sandbox_unauthorized");
    await expectApiError(
      requireSandbox(request("/", { bearer: "zsb_nope" }), workspace.sandboxName),
      401,
      "sandbox_unauthorized",
    );
    await rotateSandboxToken({ kind: "workspace", id: workspace.id });
    await expectApiError(
      requireSandbox(request("/", { bearer: token }), workspace.sandboxName),
      401,
      "sandbox_unauthorized",
    );
  });

  it("answers 410 once the workspace is soft-deleted", async () => {
    const { workspace, token } = await insertWorkspaceWithToken();
    const db = await dbReady();
    await db.update(workspaces).set({ deletedAt: new Date() }).where(eq(workspaces.id, workspace.id));
    await expectApiError(
      requireSandbox(request("/", { bearer: token }), workspace.sandboxName),
      410,
      "sandbox_retired",
    );
  });

  it("rejects a name that is neither sb- nor pb-", async () => {
    await expect(requireSandbox(request("/", { bearer: "zsb_x" }), "x-nope")).rejects.toBeInstanceOf(ApiError);
  });

  it("bumps the generation on every rotation and returns the plaintext once", async () => {
    const { workspace } = await insertWorkspaceWithToken();
    const first = await rotateSandboxToken({ kind: "workspace", id: workspace.id });
    const second = await rotateSandboxToken({ kind: "workspace", id: workspace.id });
    expect(second.generation).toBe(first.generation + 1);
    expect(second.token).not.toBe(first.token);
    const db = await dbReady();
    const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspace.id)).limit(1);
    expect(row.sandboxTokenHash).not.toContain(second.token);
  });
});
