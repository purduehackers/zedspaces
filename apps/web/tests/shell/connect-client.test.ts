import { describe, expect, it } from "vitest";
import {
  CONNECT_POLL_MS,
  ConnectError,
  connectWorkspace,
  type ConnectDeps,
} from "@/app/(editor)/w/[id]/connect-client";

const WORKSPACE = "ws_0123456789ABCDEFGHJK";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const connectInfo = {
  wsUrl: "wss://sb-test-8443.vercel.run/rpc",
  token: "zst_token",
  sessionId: "con_1",
  workspaceId: WORKSPACE,
  serverBuild: "b-1",
  clientBuild: "b-1",
  sessionExpiresAt: "2026-09-02T12:00:00.000Z",
  sessionCapAt: "2026-09-03T12:00:00.000Z",
  audience: "sb-test",
};

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

/** A `fetch` stub answering from a scripted list, recording every call. */
function scripted(responses: Array<(call: Recorded) => Response>): {
  deps: ConnectDeps;
  calls: Recorded[];
  clock: () => number;
} {
  const calls: Recorded[] = [];
  let clock = 0;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call: Recorded = { url, method: init?.method ?? "GET", body };
    calls.push(call);
    const next = responses[calls.length - 1];
    if (!next) throw new Error(`unscripted request ${call.method} ${call.url}`);
    return next(call);
  };
  return {
    calls,
    clock: () => clock,
    deps: {
      fetch: fetchImpl,
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
  };
}

const request = { workspaceId: WORKSPACE, build: "b-1", tabId: "tab-12345678", reason: "open" as const };

describe("connect()", () => {
  it("posts_the_contract_body_and_returns_connect_info", async () => {
    const { deps, calls } = scripted([() => json(200, connectInfo)]);
    const info = await connectWorkspace(request, deps);

    expect(info.sessionId).toBe("con_1");
    expect(calls[0].url).toBe(`/api/workspaces/${WORKSPACE}/connect`);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].body).toEqual({ takeover: false, clientBuild: "b-1", reason: "open", tabId: "tab-12345678" });
  });

  it("polls_the_workspace_while_a_resume_runs_then_reconnects", async () => {
    const progress: string[] = [];
    const { deps, calls } = scripted([
      () => json(202, { status: "resuming", runId: "run_1" }),
      () => json(200, { workspace: { state: "creating", stateReason: "boot:clone", workflowRunId: "run_1" } }),
      () => json(200, { workspace: { state: "running", stateReason: "boot:warm", workflowRunId: "run_1" } }),
      () => json(200, { workspace: { state: "running", stateReason: null, workflowRunId: null } }),
      () => json(200, connectInfo),
    ]);

    const info = await connectWorkspace({ ...request, onProgress: (detail) => progress.push(detail) }, deps);

    expect(info.token).toBe("zst_token");
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET", "GET", "GET", "POST"]);
    expect(progress).toEqual(["boot:resuming", "boot:clone", "boot:warm"]);
  });

  it("session_active_is_the_takeover_dialog", async () => {
    const { deps } = scripted([
      () => json(409, { error: { code: "session_active", message: "held", details: { holder: { startedAt: "x" } } } }),
    ]);
    await expect(connectWorkspace(request, deps)).rejects.toMatchObject({ code: "session_active" });
  });

  // b9 §3.26 bullet 2 + D2: a stopped workspace is terminal, never a resume.
  it("workspace_stopped_rejects_with_stopped", async () => {
    const { deps } = scripted([() => json(409, { error: { code: "workspace_stopped", message: "stopped" } })]);
    const err = await connectWorkspace({ ...request, reason: "reconnect" }, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect((err as ConnectError).code).toBe("stopped");
  });

  it("client_build_mismatch_rejects_with_build_mismatch", async () => {
    const { deps } = scripted([() => json(409, { error: { code: "client_build_mismatch", message: "old" } })]);
    await expect(connectWorkspace(request, deps)).rejects.toMatchObject({ code: "build_mismatch" });
  });

  it("401_re_mints_the_editor_cookie_once_then_retries", async () => {
    const { deps, calls } = scripted([
      () => json(401, { error: { code: "unauthenticated", message: "no session" } }),
      () => new Response(null, { status: 204 }),
      () => json(200, connectInfo),
    ]);
    const info = await connectWorkspace(request, deps);
    expect(info.sessionId).toBe("con_1");
    expect(calls[1].url).toBe(`/api/workspaces/${WORKSPACE}/session`);
  });

  it("401_after_a_failed_re_mint_is_terminal", async () => {
    const { deps } = scripted([
      () => json(401, { error: { code: "unauthenticated", message: "no session" } }),
      () => json(401, { error: { code: "unauthenticated", message: "still nothing" } }),
    ]);
    await expect(connectWorkspace(request, deps)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("423_waits_and_retries", async () => {
    const { deps, clock } = scripted([
      () => json(423, { error: { code: "workspace_busy", message: "busy" } }),
      () => json(200, connectInfo),
    ]);
    const info = await connectWorkspace(request, deps);
    expect(info.sessionId).toBe("con_1");
    expect(clock()).toBe(CONNECT_POLL_MS);
  });

  it("gives_up_when_the_deadline_passes", async () => {
    const busy = () => json(423, { error: { code: "workspace_busy", message: "busy" } });
    const { deps } = scripted(Array.from({ length: 20 }, () => busy));
    await expect(connectWorkspace({ ...request, deadlineMs: 3_000 }, deps)).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("maps_the_non_retryable_statuses", async () => {
    for (const [status, code] of [
      [402, "plan_limit"],
      [403, "forbidden"],
      [410, "deleted"],
      [500, "unavailable"],
    ] as const) {
      const { deps } = scripted([() => json(status, { error: { code: "x", message: "no" } })]);
      await expect(connectWorkspace(request, deps)).rejects.toMatchObject({ code });
    }
  });

  it("a_failed_resume_run_surfaces_the_state_reason", async () => {
    const { deps } = scripted([
      () => json(202, { status: "resuming", runId: "run_1" }),
      () => json(200, { workspace: { state: "error", stateReason: "snapshot_expired", workflowRunId: null } }),
    ]);
    await expect(connectWorkspace(request, deps)).rejects.toMatchObject({
      code: "unavailable",
      message: "snapshot_expired",
    });
  });
});
