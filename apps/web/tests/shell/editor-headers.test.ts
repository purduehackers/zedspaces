import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";
import nextConfig from "@/next.config";

const appRoot = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");

type HeaderRule = { source: string; headers: Array<{ key: string; value: string }> };
type ResolvedConfig = { headers?: () => Promise<HeaderRule[]> };
type ConfigFactory = (phase: string, context: { defaultConfig: Record<string, unknown> }) => Promise<ResolvedConfig> | ResolvedConfig;

/** `withWorkflow()` returns a phase-based config factory, so resolve it first. */
async function headerRules(): Promise<HeaderRule[]> {
  const exported = nextConfig as unknown as ResolvedConfig | ConfigFactory;
  const resolved =
    typeof exported === "function"
      ? await exported("phase-production-build", { defaultConfig: {} })
      : exported;
  if (!resolved.headers) throw new Error("next.config.ts declares no headers");
  return resolved.headers();
}

function rule(rules: HeaderRule[], source: string): Record<string, string> {
  const match = rules.find((entry) => entry.source === source);
  if (!match) throw new Error(`no header rule for ${source}`);
  return Object.fromEntries(match.headers.map((header) => [header.key, header.value]));
}

describe("editor headers", () => {
  // CONTRACTS.md §8.4 "Loader requirements": the shell checks `crossOriginIsolated`
  // before init(), which only holds when these three headers are on the document
  // *and* on every subresource of the bundle.
  it("the_editor_document_is_cross_origin_isolated", async () => {
    const headers = rule(await headerRules(), "/w/:id");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("the_bundle_is_isolated_and_immutable", async () => {
    const headers = rule(await headerRules(), "/editor/:build/:path*");
    expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
    expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
    expect(headers["Cache-Control"]).toBe("public, max-age=31536000, immutable");
  });

  it("the_service_worker_may_claim_the_editor_scope", async () => {
    const headers = rule(await headerRules(), "/sw.js");
    expect(headers["Service-Worker-Allowed"]).toBe("/w/");
    expect(headers["Cache-Control"]).toBe("no-cache");
  });

  it("api_responses_are_never_cached", async () => {
    expect(rule(await headerRules(), "/api/:path*")["Cache-Control"]).toBe("no-store");
  });
});

describe("PWA manifest", () => {
  it("is_installable_and_scoped_to_the_dashboard", () => {
    const value = manifest();
    expect(value.name).toBe("Zedspaces");
    expect(value.start_url).toBe("/workspaces");
    expect(value.display).toBe("standalone");
    expect(value.scope).toBe("/");
    expect(value.icons?.length).toBeGreaterThan(0);
    expect(value.icons?.some((icon) => icon.purpose === "maskable")).toBe(true);
  });
});

describe("service worker", () => {
  it("only_answers_editor_bundle_requests", async () => {
    const source = await readFile(path.join(appRoot, "public/sw.js"), "utf8");
    expect(source).toContain('url.pathname.startsWith("/editor/")');
    expect(source).toContain("self.location.origin");
    // It must never sit in front of the control plane or the editor document.
    expect(source).not.toContain('"/api/');
    expect(source).not.toContain('"/w/');
  });
});

describe("bundle placeholder", () => {
  it("the_stub_marks_itself_so_the_shell_can_say_bundle_not_built", async () => {
    const source = await readFile(path.join(appRoot, "public/editor/dev-0/zed_web.js"), "utf8");
    expect(source).toContain("export const zsStub = true");
    for (const name of ["start", "flush_client_state", "set_hidden", "has_unsaved_changes", "build_id"]) {
      expect(source).toContain(name);
    }
  });

  it("the_readme_documents_the_drop_in", async () => {
    const readme = await readFile(path.join(appRoot, "public/editor/README.md"), "utf8");
    expect(readme).toContain("ZS_CLIENT_BUILD_ID");
    expect(readme).toContain("zed-assets.tar");
  });
});
