import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", async (importOriginal) => (await import("./helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));

const { config } = await import("@/proxy");

/** The matcher as Next compiles it: the whole path must match `/(<inner>)`. */
function matcherRegExp(): RegExp {
  const [pattern] = config.matcher;
  const inner = pattern.slice("/(".length, -1);
  return new RegExp(`^/${inner}$`);
}

describe("proxy origin-guard matcher", () => {
  const re = matcherRegExp();

  it("skips static files, the editor bundle and the self-authenticating routes", () => {
    for (const path of [
      "/editor/abc/zed_web.js",
      "/editor/abc/zed_web_bg.wasm",
      "/sw.js",
      "/manifest.webmanifest",
      "/favicon.ico",
      "/_next/static/chunks/x.js",
      "/api/sandboxes/sb-x/activity",
      "/api/cron/sweep",
      "/.well-known/workflow/x",
      "/logo.png",
    ]) {
      expect(re.test(path), path).toBe(false);
    }
  });

  it("still protects an API path whose dynamic segment carries a dotted extension", () => {
    for (const path of [
      "/api/workspaces/ws_x.png",
      "/api/repos/x.css",
      "/api/me/settings",
      "/api/workspaces",
      "/workspaces/new",
      "/w/ws_0123456789ABCDEFGHJK",
      "/api/workspaces/ws_x/ports/3000/open",
      "/api/workspaces/ws_x.js/connect",
    ]) {
      expect(re.test(path), path).toBe(true);
    }
  });
});
