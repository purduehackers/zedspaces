import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

// The editor document and every file it loads must be cross-origin isolated
// (SharedArrayBuffer for the wasm threads); the bundle is therefore same-origin.
const isolation = [
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

/**
 * The plain config, before the Workflow wrapper. Headers live here rather
 * than in vercel.ts because `next dev` honours next.config.ts; the
 * per-request nonce CSP is in proxy.ts. Exported so tests can read the
 * header rules without invoking the workflow bundler.
 */
export const baseConfig: NextConfig = {
  // The local Sandbox adapter reads arbitrary developer paths. Those are runtime
  // local files, never Function dependencies; WASM/assets belong on the static CDN.
  outputFileTracingExcludes: {
    "/*": ["./public/**/*", "./.zs-dev/**/*", "./test-results/**/*", "./tests/**/*", "./.env*"],
    "/.well-known/workflow/**": ["./public/**/*", "./.zs-dev/**/*", "./test-results/**/*", "./tests/**/*", "./.env*"],
  },
  // `scripts/dev-local.sh browser` runs a second `next dev` (its own port, database and
  // sandboxes) beside a developer's `dev` session; Next holds one dev-server lock per
  // `distDir`, so that mode builds into `.next-browser` instead (ZS_NEXT_DIST_DIR).
  distDir: process.env.ZS_NEXT_DIST_DIR || ".next",
  headers: async () => [
    {
      // Every page (dashboard forms included) refuses to be framed; the editor
      // route adds its full nonce CSP in proxy.ts on top of this.
      source: "/:path*",
      headers: [
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
      ],
    },
    {
      source: "/w/:id",
      headers: [
        ...isolation,
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "no-referrer" },
      ],
    },
    {
      source: "/editor/:build/:path*",
      headers: [
        ...isolation,
        {
          key: "Cache-Control",
          // Bundles are content-addressed by build id, so a deployed bundle is immutable. Local
          // dev ids carry a hash of the dirty tree, which is content-addressed too, but a rebuild
          // under a repeated id (`--build-id`, a same-content rename) must not serve stale bytes:
          // `no-cache` keeps the copy and revalidates it, so a reload costs a 304 instead of
          // re-downloading and re-compiling a bundle that can exceed 100 MB.
          value:
            process.env.ZS_SANDBOX_BACKEND === "local" && process.env.NODE_ENV !== "production"
              ? "no-cache"
              : "public, max-age=31536000, immutable",
        },
      ],
    },
    {
      source: "/sw.js",
      headers: [
        { key: "Service-Worker-Allowed", value: "/w/" },
        { key: "Cache-Control", value: "no-cache" },
      ],
    },
    { source: "/api/:path*", headers: [{ key: "Cache-Control", value: "no-store" }] },
  ],
};

export default withWorkflow(baseConfig);
