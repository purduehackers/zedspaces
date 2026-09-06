/** @vitest-environment jsdom */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorShell, hostOsOf, NEXT_BOOT_KEY, TAB_ID_KEY } from "@/app/(editor)/w/[id]/editor-shell";
import { BundleError, type BootInput, type BootRunner, type EditorRuntime } from "@/app/(editor)/w/[id]/loader";
import type { ZsHost } from "@/lib/zed-web";
import type { ShellWorkspace } from "@/lib/types";

const WORKSPACE_ID = "ws_0123456789ABCDEFGHJK";

const WORKSPACE: ShellWorkspace = {
  id: WORKSPACE_ID,
  name: "demo",
  repo: "acme/demo",
  branch: "main",
  machine: "vcpu4",
  region: "iad1",
  state: "running",
  stateReason: null,
  idleMinutes: 30,
  serverBuild: "b-1",
  clientBuild: "b-1",
};

const CONNECT_INFO = {
  wsUrl: "wss://sb-demo-8443.vercel.run/rpc",
  token: "zst_token",
  sessionId: "con_1",
  workspaceId: WORKSPACE_ID,
  serverBuild: "b-1",
  clientBuild: "b-1",
  sessionExpiresAt: "2026-09-02T12:00:00.000Z",
  sessionCapAt: "2026-09-03T12:00:00.000Z",
  audience: "sb-demo",
};

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

interface Harness {
  calls: Recorded[];
  bootCalls: BootInput[];
  runtime: EditorRuntime;
  navigation: { reload: ReturnType<typeof vi.fn>; assign: ReturnType<typeof vi.fn> };
  container: HTMLElement;
  host: () => Promise<ZsHost>;
  rejectStart: (failure: unknown) => void;
}

function renderShell(options: { isolated?: boolean; failBootWith?: unknown } = {}): Harness {
  const calls: Recorded[] = [];
  const bootCalls: BootInput[] = [];
  const navigation = { reload: vi.fn(), assign: vi.fn() };
  const runtime: EditorRuntime = {
    flushClientState: vi.fn(async () => {}),
    setHidden: vi.fn(),
    hasUnsavedChanges: vi.fn(() => false),
    buildId: () => "b-1",
  };
  let rejectStart: (failure: unknown) => void = () => {};
  const started = new Promise<void>((_resolve, reject) => {
    rejectStart = reject;
  });
  started.catch(() => undefined);

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.endsWith("/connect")) return json(200, CONNECT_INFO);
    if (url === "/api/me/settings") return json(200, { content: '{"theme":"One Dark"}', version: 2 });
    if (url === "/api/me/keymap") return json(200, { content: "[]", version: 1 });
    if (url.endsWith("/keepalive")) return json(200, { keptAliveUntil: "2026-09-02T13:00:00.000Z" });
    if (url.endsWith("/stop")) return json(202, { runId: "run_1" });
    return new Response(null, { status: 204 });
  };

  const boot: BootRunner = async (input) => {
    bootCalls.push(input);
    if (options.failBootWith) throw options.failBootWith;
    return { runtime, started };
  };

  const view = render(
    <EditorShell
      workspaceId={WORKSPACE_ID}
      build="b-1"
      initial={WORKSPACE}
      paths={["/workspaces/demo"]}
      settingsUrl="/api/me/settings"
      keymapUrl="/api/me/keymap"
      overrides={{
        boot,
        fetch: fetchImpl,
        crossOriginIsolated: options.isolated ?? true,
        navigation,
        registerServiceWorker: false,
      }}
    />,
  );

  return {
    calls,
    bootCalls,
    runtime,
    navigation,
    container: view.container,
    rejectStart,
    host: async () => {
      await waitFor(() => expect(bootCalls).toHaveLength(1));
      return bootCalls[0].host;
    },
  };
}

function overlay(container: HTMLElement): HTMLElement {
  const node = container.querySelector<HTMLElement>('[data-zs="overlay"]');
  if (!node) throw new Error("no overlay");
  return node;
}

beforeEach(() => {
  sessionStorage.clear();
});

describe("EditorShell", () => {
  it("refuses_to_boot_without_cross_origin_isolation", async () => {
    const shell = renderShell({ isolated: false });
    await waitFor(() => expect(overlay(shell.container).dataset.phase).toBe("unsupported-browser"));
    expect(shell.bootCalls).toHaveLength(0);
    expect(screen.getByText(/cross-origin isolation/i)).toBeTruthy();
  });

  it("connects_loads_the_documents_and_hands_start_a_boot_config", async () => {
    const shell = renderShell();
    await shell.host();

    const connect = shell.calls.find((call) => call.url.endsWith("/connect"));
    expect(connect?.method).toBe("POST");
    expect(connect?.body).toMatchObject({ clientBuild: "b-1", reason: "open" });
    expect(sessionStorage.getItem(TAB_ID_KEY)).toBeTruthy();

    const config = shell.bootCalls[0].config;
    expect(config.buildId).toBe("b-1");
    expect(config.workspace).toEqual({ id: WORKSPACE_ID, paths: ["/workspaces/demo"] });
    expect(config.connect).toMatchObject({ wsUrl: CONNECT_INFO.wsUrl, token: "zst_token", sessionId: "con_1" });
    expect(config.settingsJson).toBe('{"theme":"One Dark"}');
    expect(config.keymapJson).toBe("[]");

    // The overlay dissolves only when the wasm side reports `ready`.
    expect(overlay(shell.container).dataset.phase).toBe("booting");
    const host = await shell.host();
    act(() => host.bootProgress("ready", ""));
    await waitFor(() => expect(overlay(shell.container).dataset.phase).toBe("ready"));
  });

  it("reconnect_intent_from_session_storage_drives_the_connect_reason", async () => {
    sessionStorage.setItem(NEXT_BOOT_KEY, JSON.stringify({ resume: true }));
    const shell = renderShell();
    await shell.host();

    const connect = shell.calls.find((call) => call.url.endsWith("/connect"));
    expect(connect?.body).toMatchObject({ reason: "resume" });
    // Read once, then cleared, so a plain reload is a normal open.
    expect(sessionStorage.getItem(NEXT_BOOT_KEY)).toBeNull();
  });

  it("shows_the_boot_stages_and_the_reconnect_overlay", async () => {
    const shell = renderShell();
    const host = await shell.host();

    act(() => host.bootProgress("languages", "rust"));
    await waitFor(() => expect(screen.getByText("Loading languages")).toBeTruthy());
    expect(overlay(shell.container).querySelector(".zs-progress")?.getAttribute("data-progress")).toBe("0.75");

    act(() => host.bootProgress("reconnecting", "3"));
    await waitFor(() => expect(overlay(shell.container).dataset.phase).toBe("reconnecting"));
    expect(screen.getByText(/Attempt 3 of 20/)).toBeTruthy();
  });


  it("a_replaced_connection_does_not_offer_to_take_over", async () => {
    const shell = renderShell();
    await shell.host();

    await act(async () => {
      shell.rejectStart({ code: "connection_replaced", message: "replaced" });
      await Promise.resolve();
    });
    await waitFor(() => expect(overlay(shell.container).dataset.phase).toBe("error"));
    expect(screen.queryByRole("button", { name: /Take back|Take over/ })).toBeNull();
  });

  it("lifecycle_notices_toast_keep_alive_and_end_in_the_stopped_state", async () => {
    const shell = renderShell();
    const host = await shell.host();

    act(() => host.onLifecycle("idle_stop_in", 90));
    await waitFor(() => expect(screen.getByText(/stops in 90s/)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Keep alive" }));
    await waitFor(() => expect(shell.calls.some((call) => call.url.endsWith("/keepalive"))).toBe(true));
    await waitFor(() => expect(screen.queryByText(/stops in 90s/)).toBeNull());

    act(() => host.onLifecycle("idle_stop_in", 20));
    act(() => host.onLifecycle("stopping", 0));
    await waitFor(() => expect(overlay(shell.container).dataset.phase).toBe("stopped"));
    expect(screen.getByText(/stopped because it was idle/)).toBeTruthy();

    // The stopped overlay offers a fresh boot (D30), without duplicate shell chrome.
    expect(screen.getAllByRole("button", { name: "Resume" })).toHaveLength(1);
    fireEvent.click(within(overlay(shell.container)).getByRole("button", { name: "Resume" }));
    expect(sessionStorage.getItem(NEXT_BOOT_KEY)).toBe(JSON.stringify({ resume: true }));
    expect(shell.navigation.reload).toHaveBeenCalledTimes(1);
  });

  it("session_cap_countdown_becomes_the_restarting_phase", async () => {
    const shell = renderShell();
    const host = await shell.host();

    act(() => host.onLifecycle("session_cap_in", 120));
    await waitFor(() => expect(screen.getByText(/restarts in 120s/)).toBeTruthy());
    expect(overlay(shell.container).dataset.phase).toBe("booting");

    act(() => host.onLifecycle("session_cap_in", 25));
    await waitFor(() => expect(overlay(shell.container).dataset.phase).toBe("restarting"));

    act(() => host.onLifecycle("resumed", 0));
    await waitFor(() => expect(screen.queryByText(/restarts in/)).toBeNull());
  });

  it("a_missing_bundle_renders_the_bundle_not_built_state", async () => {
    const shell = renderShell({ failBootWith: new BundleError("bundle_not_built", "stub in place") });
    await waitFor(() => expect(overlay(shell.container).dataset.phase).toBe("error"));

    expect(screen.getByText(/has not been built/)).toBeTruthy();
    expect(screen.getByText("bundle_not_built")).toBeTruthy();
    // Structural failure: a reconnect cannot fix it.
    expect(screen.queryByRole("button", { name: "Reconnect" })).toBeNull();
  });

  it("leaves_the_ready_editor_unobstructed_by_shell_chrome", async () => {
    const shell = renderShell();
    const host = await shell.host();
    act(() => host.bootProgress("ready", ""));
    expect(shell.container.querySelector('[data-zs="strip"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Stop" })).toBeNull();
    expect(screen.queryByText("Open in desktop")).toBeNull();
    expect(overlay(shell.container).dataset.phase).toBe("ready");
  });

  it("hiding_the_tab_flushes_the_client_state", async () => {
    const shell = renderShell();
    await shell.host();

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(shell.runtime.setHidden).toHaveBeenCalledWith(true);
    expect(shell.runtime.flushClientState).toHaveBeenCalled();
  });

  it("never_flushes_after_losing_the_session", async () => {
    const shell = renderShell();
    const host = await shell.host();
    act(() => host.bootProgress("stopped", "connection_replaced"));

    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(shell.runtime.flushClientState).not.toHaveBeenCalled();
  });

  it("registers_the_service_worker_for_this_build", async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register } });

    render(
      <EditorShell
        workspaceId={WORKSPACE_ID}
        build="b-9"
        initial={WORKSPACE}
        paths={["/workspaces/demo"]}
        settingsUrl="/api/me/settings"
        keymapUrl="/api/me/keymap"
        overrides={{
          boot: async (input: BootInput) => ({
            runtime: {
              flushClientState: async () => {},
              setHidden: () => {},
              hasUnsavedChanges: () => false,
              buildId: () => input.build,
            },
            started: new Promise<void>(() => {}),
          }),
          fetch: async () => json(200, CONNECT_INFO),
          crossOriginIsolated: true,
          navigation: { reload: () => {}, assign: () => {} },
          registerServiceWorker: true,
        }}
      />,
    );

    await waitFor(() => expect(register).toHaveBeenCalledWith("/sw.js?build=b-9", { scope: "/w/" }));
  });

  // Outside a production build (`next dev`, this test runner) the same build id can be
  // republished with new bytes, so the shell never registers the worker and drops leftovers.
  it("unregisters_leftover_service_workers_outside_production", async () => {
    const register = vi.fn(async () => ({}) as ServiceWorkerRegistration);
    const unregister = vi.fn(async () => true);
    const getRegistrations = vi.fn(async () => [{ unregister }] as unknown as ServiceWorkerRegistration[]);
    Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register, getRegistrations } });

    render(
      <EditorShell
        workspaceId={WORKSPACE_ID}
        build="b-9"
        initial={WORKSPACE}
        paths={["/workspaces/demo"]}
        settingsUrl="/api/me/settings"
        keymapUrl="/api/me/keymap"
        overrides={{
          boot: async (input: BootInput) => ({
            runtime: {
              flushClientState: async () => {},
              setHidden: () => {},
              hasUnsavedChanges: () => false,
              buildId: () => input.build,
            },
            started: new Promise<void>(() => {}),
          }),
          fetch: async () => json(200, CONNECT_INFO),
          crossOriginIsolated: true,
          navigation: { reload: () => {}, assign: () => {} },
        }}
      />,
    );

    await waitFor(() => expect(unregister).toHaveBeenCalled());
    expect(register).not.toHaveBeenCalled();
  });

  // b9 §3.26 bullet 9 / §4.9: style-src has no 'unsafe-inline', so the SSR tree carries no style attribute.
  it("server_rendered_markup_has_no_style_attribute", () => {
    const html = renderToStaticMarkup(
      <EditorShell
        workspaceId={WORKSPACE_ID}
        build="b-1"
        initial={WORKSPACE}
        paths={["/workspaces/demo"]}
        settingsUrl="/api/me/settings"
        keymapUrl="/api/me/keymap"
      />,
    );
    expect(html).not.toContain("style=");
    expect(html).toContain('data-phase="booting"');
    expect(html).toContain('data-progress="');
  });

  it("maps_the_platform_string_to_a_keymap_layer", () => {
    expect(hostOsOf("macOS")).toBe("mac");
    expect(hostOsOf("MacIntel")).toBe("mac");
    expect(hostOsOf("Windows")).toBe("windows");
    expect(hostOsOf("Linux x86_64")).toBe("linux");
    expect(hostOsOf(undefined)).toBe("linux");
  });
});
