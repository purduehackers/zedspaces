import { describe, expect, it } from "vitest";
import { baseConfig } from "@/next.config";

/** Every page must refuse to be framed (dashboard forms included), not only the editor. */
describe("next.config headers", () => {
  it("frame_ancestors_everywhere", async () => {
    const rules = await baseConfig.headers!();
    const site = rules.find((rule) => rule.source === "/:path*");
    expect(site?.headers).toEqual(
      expect.arrayContaining([
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      ]),
    );
    const editor = rules.find((rule) => rule.source === "/w/:id");
    expect(editor?.headers.map((header) => header.key)).toEqual(
      expect.arrayContaining(["Cross-Origin-Opener-Policy", "Cross-Origin-Embedder-Policy", "X-Frame-Options"]),
    );
    const bundle = rules.find((rule) => rule.source === "/editor/:build/:path*");
    expect(bundle?.headers.map((header) => header.key)).toContain("Cross-Origin-Resource-Policy");
    // Never `no-store`: the bundle is content-addressed, and re-downloading ~100 MB on every
    // reload is what made the local editor look like it hung at "Starting the editor".
    const bundleCache = bundle?.headers.find((header) => header.key === "Cache-Control")?.value;
    expect(bundleCache).toBeDefined();
    expect(bundleCache).not.toBe("no-store");
    expect(rules.find((rule) => rule.source === "/sw.js")?.headers).toContainEqual({
      key: "Service-Worker-Allowed",
      value: "/w/",
    });
  });
});
