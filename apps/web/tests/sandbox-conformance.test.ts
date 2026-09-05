import { Sandbox, Snapshot } from "@vercel/sandbox";
import { describe, expect, it } from "vitest";
import { hostOf, realSandboxHandle, toSandboxError, type CreateSandboxInput, type SandboxStatus } from "@/lib/sandbox";
import { SandboxError } from "@/lib/sandbox-error";

/**
 * Compile-time conformance between `lib/sandbox.ts` and `@vercel/sandbox`. An
 * SDK rename or a widened status union fails `tsc --noEmit` here rather than
 * in production (b9 §6.4).
 */

/** Every status the SDK reports must be one our union names, and vice versa. */
type SdkStatus = Sandbox["status"];
const OUR_STATUSES: SandboxStatus[] = [
  "pending",
  "running",
  "stopping",
  "stopped",
  "failed",
  "aborted",
  "snapshotting",
];
const SDK_STATUSES: SdkStatus[] = OUR_STATUSES;
const BACK_TO_OURS: SandboxStatus[] = SDK_STATUSES;

/** The exact argument the real driver builds for `Sandbox.getOrCreate`. */
type GetOrCreateParams = NonNullable<Parameters<typeof Sandbox.getOrCreate>[0]>;
const input: CreateSandboxInput = {
  name: "sb-dev-conformance-g1",
  region: "iad1",
  vcpus: 4,
  ports: [8443, 8444, 8445, 8446, 8447, 8448, 3000],
  timeoutMs: 4 * 3600_000,
  image: "zs-workspace:test-0",
  env: { ZS_WORKSPACE_ID: "ws_x" },
  networkPolicy: "allow-all",
  tags: { zs: "development" },
  snapshotExpirationMs: 30 * 86_400_000,
  keepLastSnapshots: 1,
};
const getOrCreateArg = {
  name: input.name,
  resume: true,
  persistent: true,
  ports: input.ports,
  timeout: input.timeoutMs,
  region: input.region,
  resources: { vcpus: input.vcpus },
  env: input.env,
  networkPolicy: input.networkPolicy,
  tags: input.tags,
  snapshotExpiration: input.snapshotExpirationMs ?? 0,
  keepLastSnapshots: { count: input.keepLastSnapshots ?? 1 },
  image: input.image,
} satisfies GetOrCreateParams;

/** The snapshot-source variant of the same call. */
const snapshotArg = {
  name: input.name,
  resume: true,
  persistent: true,
  ports: input.ports,
  timeout: input.timeoutMs,
  region: input.region,
  resources: { vcpus: input.vcpus },
  env: input.env,
  networkPolicy: input.networkPolicy,
  tags: input.tags,
  snapshotExpiration: input.snapshotExpirationMs ?? 0,
  keepLastSnapshots: { count: input.keepLastSnapshots ?? 1 },
  source: { type: "snapshot", snapshotId: "snap_1" },
} satisfies GetOrCreateParams;

/** `Sandbox.get` and `Snapshot.get` argument shapes. */
const getArg = { name: input.name, resume: false } satisfies NonNullable<Parameters<typeof Sandbox.get>[0]>;
const snapshotGetArg = { snapshotId: "snap_1" } satisfies Parameters<typeof Snapshot.get>[0];
const listArg = { tags: { zs: "preview" } } satisfies NonNullable<Parameters<typeof Sandbox.list>[0]>;
const updateArg = { ports: [8443, 3000] } satisfies Parameters<Sandbox["update"]>[0];

describe("sandbox conformance", () => {
  it("maps our create input onto the SDK parameters", () => {
    expect(getOrCreateArg.keepLastSnapshots).toEqual({ count: 1 });
    expect(snapshotArg.source).toEqual({ type: "snapshot", snapshotId: "snap_1" });
    expect(getArg.resume).toBe(false);
    expect(snapshotGetArg.snapshotId).toBe("snap_1");
    expect(listArg.tags).toEqual({ zs: "preview" });
    expect(updateArg.ports).toEqual([8443, 3000]);
  });

  it("agrees with the SDK's status union in both directions", () => {
    expect(BACK_TO_OURS).toEqual(OUR_STATUSES);
  });

  it("classifies a snapshot expiry as fatal and a 5xx as retryable", () => {
    const expired = toSandboxError(
      Object.assign(new Error("gone"), {
        name: "APIError",
        response: new Response(null, { status: 410 }),
      }),
    );
    // A plain Error (not an SDK APIError) is never retried.
    expect(expired).toBeInstanceOf(SandboxError);
    expect(expired.retryable).toBe(false);
  });

  it("reduces a sandbox domain to its hostname", () => {
    expect(hostOf("https://sb-x-8443.vercel.run")).toBe("sb-x-8443.vercel.run");
  });

  /**
   * b10 §6.4 `builder_command_carries_budget`, on the REAL handle: the SDK
   * enforces `timeoutMs` at exec time (detached commands included), so the
   * builder's 45-minute hard budget exists only if the driver forwards it to
   * `Sandbox.runCommand` — for `runDetached` (the driver) and `run` alike.
   */
  it("forwards RunInput.timeoutMs to Sandbox.runCommand for runDetached and run", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const stub = {
      runCommand: async (params: Record<string, unknown>) => {
        calls.push(params);
        if (params.detached) return { cmdId: "cmd_1", exitCode: null };
        return { exitCode: 0, stdout: async () => "out", stderr: async () => "" };
      },
    } as unknown as Sandbox;
    const handle = realSandboxHandle(stub);
    const budget = 45 * 60_000;
    expect(budget).toBe(45 * 60_000);

    const detached = await handle.runDetached({
      cmd: "/usr/local/bin/zs-build-devcontainer",
      args: [],
      env: { ZS_IMAGE_BUILD_ID: "img_x" },
      cwd: "/vercel",
      sudo: false,
      timeoutMs: budget,
    });
    expect(detached).toEqual({ cmdId: "cmd_1" });
    const finished = await handle.run({ cmd: "true", args: ["--version"], timeoutMs: budget });
    expect(finished).toEqual({ exitCode: 0, stdout: "out", stderr: "" });

    expect(calls).toEqual([
      {
        cmd: "/usr/local/bin/zs-build-devcontainer",
        args: [],
        env: { ZS_IMAGE_BUILD_ID: "img_x" },
        cwd: "/vercel",
        sudo: false,
        detached: true,
        timeoutMs: budget,
      },
      { cmd: "true", args: ["--version"], env: undefined, cwd: undefined, sudo: undefined, timeoutMs: budget },
    ]);
    // Without a budget nothing is invented: the SDK's own default applies.
    await handle.run({ cmd: "true", args: [] });
    expect(calls[2].timeoutMs).toBeUndefined();
  });
});
