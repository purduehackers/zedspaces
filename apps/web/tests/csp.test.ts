import { describe, expect, it } from "vitest";
import { editorCsp, newCspNonce } from "@/lib/csp";

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split("; ").map((part) => {
      const [name, ...rest] = part.split(" ");
      return [name, rest.join(" ")];
    }),
  );
}

describe("editor CSP", () => {
  it("nonce_present_and_no_unsafe_inline", () => {
    const nonce = newCspNonce();
    const csp = editorCsp(nonce, { dev: false, unsafeEval: false });
    const d = directives(csp);

    expect(d.get("script-src")).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'`);
    expect(d.get("style-src")).toBe(`'self' 'nonce-${nonce}'`);
    expect(csp).not.toContain("'unsafe-inline'");
    expect(d.get("connect-src")).toBe("'self' wss://*.vercel.run https://*.vercel.run");
    expect(d.get("worker-src")).toBe("'self' blob:");
    expect(d.get("frame-ancestors")).toBe("'none'");
    expect(d.get("object-src")).toBe("'none'");
    expect(csp.endsWith("upgrade-insecure-requests")).toBe(true);
  });

  it("unsafe_eval_only_when_flagged", () => {
    const nonce = "n";
    expect(editorCsp(nonce, { dev: false, unsafeEval: true })).toContain("'unsafe-eval'");
    expect(editorCsp(nonce, { dev: true, unsafeEval: false })).toContain("'unsafe-eval'");
    expect(editorCsp(nonce, { dev: false, unsafeEval: false })).not.toContain("'unsafe-eval'");
  });

  it("nonces_are_unique", () => {
    expect(newCspNonce()).not.toBe(newCspNonce());
  });

  // Bug (b): `next dev` injects nonce-less inline <style> elements (dozens of "Applying inline
  // style violates style-src" errors per page). The dev policy relaxes style-src; the
  // production policy is pinned verbatim so the relaxation can never ship.
  it("production_policy_is_pinned_verbatim", () => {
    const nonce = "pinned";
    expect(editorCsp(nonce, { dev: false, unsafeEval: false })).toBe(
      [
        "default-src 'self'",
        "script-src 'self' 'nonce-pinned' 'strict-dynamic' 'wasm-unsafe-eval'",
        "connect-src 'self' wss://*.vercel.run https://*.vercel.run",
        "worker-src 'self' blob:",
        "img-src 'self' blob: data:",
        "style-src 'self' 'nonce-pinned'",
        "font-src 'self' blob: data:",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        "manifest-src 'self'",
        "upgrade-insecure-requests",
      ].join("; "),
    );
  });

  it("dev_relaxes_runtime_sources_and_does_not_upgrade_http_assets", () => {
    const nonce = newCspNonce();
    const dev = directives(editorCsp(nonce, { dev: true, unsafeEval: false }));
    const prod = directives(editorCsp(nonce, { dev: false, unsafeEval: false }));
    // Browsers ignore 'unsafe-inline' next to a nonce, so the dev style-src drops the nonce.
    expect(dev.get("style-src")).toBe("'self' 'unsafe-inline'");
    expect(dev.get("script-src")).toBe(`'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval' 'unsafe-eval'`);
    expect(dev.get("script-src")).not.toContain("'unsafe-inline'");
    expect(dev.has("upgrade-insecure-requests")).toBe(false);
    expect(prod.has("upgrade-insecure-requests")).toBe(true);
    for (const [name, value] of prod) {
      if (name === "style-src" || name === "script-src" || name === "upgrade-insecure-requests") continue;
      expect(dev.get(name), name).toBe(value);
    }
  });

  it("local_sandbox_adds_loopback_connect_sources_without_touching_the_rest", () => {
    const nonce = "n";
    const local = directives(editorCsp(nonce, { dev: false, unsafeEval: false, localSandbox: true }));
    const prod = directives(editorCsp(nonce, { dev: false, unsafeEval: false }));
    expect(local.get("connect-src")).toBe(
      "'self' wss://*.vercel.run https://*.vercel.run ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*",
    );
    for (const [name, value] of prod) {
      if (name === "connect-src") continue;
      expect(local.get(name), name).toBe(value);
    }
  });
});
