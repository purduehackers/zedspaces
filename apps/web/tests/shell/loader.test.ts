import { afterEach, describe, expect, it, vi } from "vitest";
import { bundleUrl, BundleError, fetchAssets, loadZedWeb } from "@/app/(editor)/w/[id]/loader";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("editor bundle loader", () => {
  it("builds_same_origin_bundle_urls", () => {
    expect(bundleUrl("2026-09-02-abc", "zed_web.js")).toBe("/editor/2026-09-02-abc/zed_web.js");
    expect(bundleUrl("a/b", "zed_web_bg.wasm")).toBe("/editor/a%2Fb/zed_web_bg.wasm");
  });

  it("an_absent_bundle_is_a_bundle_missing_error", async () => {
    const err = await loadZedWeb("does-not-exist").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleError);
    expect((err as BundleError).code).toBe("bundle_missing");
  });

  it("fetches_the_asset_tarball_when_cache_storage_is_unavailable", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    globalThis.fetch = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;

    const assets = await fetchAssets("b-1");
    expect(Array.from(assets)).toEqual([1, 2, 3, 4]);
    expect(globalThis.fetch).toHaveBeenCalledWith("/editor/b-1/zed-assets.tar", { cache: "force-cache" });
  });

  it("a_missing_asset_tarball_is_a_bundle_missing_error", async () => {
    globalThis.fetch = vi.fn(async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(fetchAssets("b-1")).rejects.toMatchObject({ code: "bundle_missing" });
  });
});
