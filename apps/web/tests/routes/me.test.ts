import { beforeEach, describe, expect, it, vi } from "vitest";
import { _resetKvForTests } from "@/lib/kv";
import { DEFAULT_KEYMAP, DEFAULT_SETTINGS } from "@/lib/settings-docs";
import { resetViewer, setViewer } from "../helpers/viewer-mock";
import { clearRequestCookies, ctx, errorBody, jsonBody, req } from "../helpers/request";
import { routeDb, SEED } from "../helpers/route-db";

vi.mock("@/lib/auth", async (importOriginal) => (await import("../helpers/viewer-mock")).createViewerMock(await importOriginal<typeof import("@/lib/auth")>()));
vi.mock("next/headers", async () => (await import("../helpers/request")).createHeadersMock());

const settings = await import("@/app/api/me/settings/route");
const keymap = await import("@/app/api/me/keymap/route");
const dotfiles = await import("@/app/api/me/dotfiles/route");

beforeEach(async () => {
  await routeDb();
  resetViewer();
  _resetKvForTests();
  clearRequestCookies();
  setViewer(SEED.userId);
});

describe("/api/me/settings", () => {
  it("starts at the built-in default with version 0", async () => {
    const res = await settings.GET(req("GET", "/api/me/settings"), ctx({}));
    expect(await jsonBody(res)).toEqual({ content: DEFAULT_SETTINGS, version: 0 });
  });

  it("stores JSONC verbatim, comments and trailing commas included", async () => {
    const content = '{\n  // vim, please\n  "vim_mode": true,\n}\n';
    const put = await settings.PUT(req("PUT", "/api/me/settings", { body: { content } }), ctx({}));
    expect(put.status).toBe(200);
    expect(await jsonBody(put)).toEqual({ content, version: 1 });

    const get = await settings.GET(req("GET", "/api/me/settings"), ctx({}));
    expect(await jsonBody(get)).toEqual({ content, version: 1 });
  });

  it("refuses a document that does not parse", async () => {
    const res = await settings.PUT(
      req("PUT", "/api/me/settings", { body: { content: '{ "unclosed": ' } }),
      ctx({}),
    );
    expect(res.status).toBe(400);
    expect((await errorBody(res)).code).toBe("invalid_body");
  });

  it("refuses a stale version and hands back the current document", async () => {
    await settings.PUT(req("PUT", "/api/me/settings", { body: { content: "{}" } }), ctx({}));
    const stale = await settings.PUT(
      req("PUT", "/api/me/settings", { body: { content: "{}", version: 0 } }),
      ctx({}),
    );
    expect(stale.status).toBe(409);
    const err = await errorBody(stale);
    expect(err.code).toBe("version_conflict");
    expect(err.details).toMatchObject({ version: 1, content: "{}" });
  });
});

describe("/api/me/keymap", () => {
  it("round-trips a keymap array", async () => {
    const first = await keymap.GET(req("GET", "/api/me/keymap"), ctx({}));
    expect(await jsonBody(first)).toEqual({ content: DEFAULT_KEYMAP, version: 0 });

    const content = '[\n  { "bindings": { "ctrl-b": "workspace::ToggleLeftDock" } },\n]\n';
    const put = await keymap.PUT(req("PUT", "/api/me/keymap", { body: { content } }), ctx({}));
    expect(await jsonBody(put)).toEqual({ content, version: 1 });
  });
});

describe("/api/me/dotfiles", () => {
  it("starts unset and stores an https repository", async () => {
    const before = await dotfiles.GET(req("GET", "/api/me/dotfiles"), ctx({}));
    expect(await jsonBody(before)).toEqual({ repoUrl: null, installCommand: null });

    const value = { repoUrl: "https://github.com/test/dotfiles", installCommand: "./install.sh" };
    const put = await dotfiles.PUT(req("PUT", "/api/me/dotfiles", { body: value }), ctx({}));
    expect(await jsonBody(put)).toEqual(value);

    const after = await dotfiles.GET(req("GET", "/api/me/dotfiles"), ctx({}));
    expect(await jsonBody(after)).toEqual(value);
  });

  it("refuses a non-https repository", async () => {
    const res = await dotfiles.PUT(
      req("PUT", "/api/me/dotfiles", { body: { repoUrl: "git@github.com:test/dotfiles.git", installCommand: null } }),
      ctx({}),
    );
    expect(res.status).toBe(400);
  });
});
