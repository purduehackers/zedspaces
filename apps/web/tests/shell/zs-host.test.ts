import { describe, expect, it, vi } from "vitest";
import { ConnectError } from "@/app/(editor)/w/[id]/connect-client";
import { createHost, refreshFailureFor, type ShellController } from "@/app/(editor)/w/[id]/zs-host";
import type { ZsBootStage, ZsConnectInfo, ZsDocumentKind, ZsLifecycleKind } from "@/lib/zed-web";

const WORKSPACE = "ws_0123456789ABCDEFGHJK";

const CONNECT: ZsConnectInfo = {
  wsUrl: "wss://sb-test-8443.vercel.run/rpc",
  token: "zst_token",
  sessionId: "con_2",
  serverBuild: "b-1",
  sessionExpiresAt: "2026-09-02T12:00:00.000Z",
};

interface Recorded {
  url: string;
  method: string;
  body: unknown;
  keepalive: boolean | undefined;
}

function harness(overrides: Partial<ShellController> = {}, responder?: (call: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const versions: Record<ZsDocumentKind, number | null> = { settings: 3, keymap: null };
  const progress: Array<[ZsBootStage, string]> = [];
  const notices: Array<[ZsLifecycleKind, number]> = [];

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: Recorded = {
      url,
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      keepalive: init?.keepalive,
    };
    calls.push(call);
    return responder?.(call) ?? new Response(null, { status: 204 });
  };

  const controller: ShellController = {
    workspaceId: WORKSPACE,
    build: "b-1",
    bootProgress: (stage, detail) => progress.push([stage, detail]),
    lifecycle: (kind, seconds) => notices.push([kind, seconds]),
    refreshConnectInfo: async () => CONNECT,
    documentUrl: (kind) => (kind === "settings" ? "/api/me/settings" : "/api/me/keymap"),
    documentVersion: (kind) => versions[kind],
    setDocumentVersion: (kind, version) => {
      versions[kind] = version;
    },
    deps: { fetch: fetchImpl },
    ...overrides,
  };

  return { host: createHost(controller), calls, versions, progress, notices };
}

describe("createHost", () => {
  it("forwards_boot_progress_and_lifecycle", () => {
    const { host, progress, notices } = harness();
    host.bootProgress("connecting", "");
    host.onLifecycle("idle_stop_in", 120);
    expect(progress).toEqual([["connecting", ""]]);
    expect(notices).toEqual([["idle_stop_in", 120]]);
  });

  it("refresh_connect_info_resolves_the_transport_fields", async () => {
    const { host } = harness();
    await expect(host.refreshConnectInfo()).resolves.toEqual(CONNECT);
  });

  // D2: `stopped` and `unauthorized` are terminal for b1; everything else is retried.
  it("refresh_failures_carry_the_three_codes_b1_branches_on", async () => {
    expect(refreshFailureFor(new ConnectError("stopped", "gone")).code).toBe("stopped");
    expect(refreshFailureFor(new ConnectError("deleted", "gone")).code).toBe("stopped");
    expect(refreshFailureFor(new ConnectError("build_mismatch", "old")).code).toBe("stopped");
    expect(refreshFailureFor(new ConnectError("unauthorized", "no")).code).toBe("unauthorized");
    expect(refreshFailureFor(new ConnectError("forbidden", "no")).code).toBe("unauthorized");
    expect(refreshFailureFor(new ConnectError("session_active", "busy")).code).toBe("unavailable");
    expect(refreshFailureFor(new Error("offline")).code).toBe("unavailable");

    const { host } = harness({
      refreshConnectInfo: async () => {
        throw new ConnectError("stopped", "the workspace is stopped");
      },
    });
    await expect(host.refreshConnectInfo()).rejects.toEqual({
      code: "stopped",
      message: "the workspace is stopped",
    });
  });

  it("dispatches_a_flush_immediately_and_serializes_overlapping_writes_with_the_acknowledged_version", async () => {
    const responses: Array<(response: Response) => void> = [];
    const { host, calls, versions } = harness({}, () => new Promise((resolve) => responses.push(resolve)));
    const first = host.saveDocument("settings", '{"a":1}');
    const second = host.saveDocument("settings", '{"a":2}');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "/api/me/settings", method: "PUT", body: { content: '{"a":1}', version: 3 } });
    responses[0](new Response(JSON.stringify({ content: '{"a":1}', version: 4 }), { status: 200 }));
    await first;
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toEqual({ content: '{"a":2}', version: 4 });
    expect(versions.settings).toBe(4);
    responses[1](new Response(JSON.stringify({ content: '{"a":2}', version: 5 }), { status: 200 }));
    await second;
    expect(versions.settings).toBe(5);
  });

  it("a_pending_settings_write_does_not_delay_the_keymap_flush", async () => {
    let finishSettings!: (response: Response) => void;
    const { host, calls } = harness({}, (call) => call.url.endsWith("settings")
      ? new Promise((resolve) => { finishSettings = resolve; })
      : new Response(JSON.stringify({ content: "[]", version: 1 }), { status: 200 }));
    const settings = host.saveDocument("settings", "{}");
    await host.saveDocument("keymap", "[]");
    expect(calls.map((call) => call.url)).toEqual(["/api/me/settings", "/api/me/keymap"]);
    finishSettings(new Response(JSON.stringify({ content: "{}", version: 4 }), { status: 200 }));
    await settings;
  });

  it("save_document_omits_the_version_when_none_is_known", async () => {
    const { host, calls } = harness({}, () =>
      new Response(JSON.stringify({ content: "{}", version: 1 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await host.saveDocument("keymap", "[]");
    expect(calls[0]).toMatchObject({ url: "/api/me/keymap", body: { content: "[]" } });
  });

  it("preserves_documents_larger_than_the_keepalive_budget_on_the_ordinary_fetch_path", async () => {
    const content = JSON.stringify({ note: "é".repeat(128 * 1024) });
    const { host, calls } = harness({}, () =>
      new Response(JSON.stringify({ content, version: 4 }), { status: 200 }));
    await host.saveDocument("settings", content);
    expect(calls[0].body).toEqual({ content, version: 3 });
    expect(calls[0].keepalive).not.toBe(true);
  });

  it("save_document_rejects_on_version_conflict", async () => {
    const { host } = harness({}, () =>
      new Response(JSON.stringify({ error: { code: "version_conflict", message: "stale" } }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(host.saveDocument("settings", "{}")).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("a_failed_write_rejects_its_caller_without_poisoning_later_saves", async () => {
    let attempts = 0;
    const { host, calls } = harness({}, () => {
      if (++attempts === 1) throw new TypeError("Load failed");
      return new Response(JSON.stringify({ content: "{}", version: 4 }), { status: 200 });
    });
    const first = host.saveDocument("settings", '{"a":1}');
    const second = host.saveDocument("settings", '{"a":2}');
    await expect(first).rejects.toThrow("Load failed");
    await second;
    expect(calls[1].body).toEqual({ content: '{"a":2}', version: 3 });
  });

  it("report_error_and_on_closed_post_client_errors", async () => {
    const { host, calls } = harness();
    host.reportError("panic", "boom", "at zed_web");
    host.onClosed({ code: 4001, reason: "superseded" });
    await vi.waitFor(() => expect(calls).toHaveLength(2));

    expect(calls[0]).toMatchObject({
      url: `/api/workspaces/${WORKSPACE}/client-errors`,
      method: "POST",
      body: { kind: "panic", message: "boom", stack: "at zed_web", build: "b-1" },
    });
    // onClosed is telemetry only (b9 §3.26 bullet 4): the shell never branches on the close code.
    expect(calls[1].body).toMatchObject({ kind: "close", message: "close 4001: superseded" });
  });
});
