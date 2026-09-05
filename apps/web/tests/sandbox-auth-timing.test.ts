import { beforeEach, describe, expect, it, vi } from "vitest";
import { insertWorkspaceWithToken, request, seedFixtures } from "./helpers/routes";

const compare = vi.hoisted(() => ({ calls: 0 }));

vi.mock("@/lib/ids", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ids")>();
  return {
    ...actual,
    timingSafeEqualHex: (a: string, b: string) => {
      compare.calls += 1;
      return actual.timingSafeEqualHex(a, b);
    },
  };
});

const { requireSandbox } = await import("@/lib/sandbox-auth");

describe("sandbox bearer comparison", () => {
  beforeEach(async () => {
    await seedFixtures();
    compare.calls = 0;
  });

  it("compares the token digest in constant time", async () => {
    const { workspace, token } = await insertWorkspaceWithToken();
    await requireSandbox(request("/", { bearer: token }), workspace.sandboxName);
    expect(compare.calls).toBe(1);
    await expect(requireSandbox(request("/", { bearer: "zsb_wrong" }), workspace.sandboxName)).rejects.toMatchObject({
      status: 401,
    });
    expect(compare.calls).toBe(2);
  });
});
