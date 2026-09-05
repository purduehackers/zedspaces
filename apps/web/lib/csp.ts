/**
 * Content-Security-Policy for the editor document (`/w/[id]`, b9 §4.9;
 * CONTRACTS.md §8.4). Nonce-based scripts and styles, no `'unsafe-inline'`;
 * `'unsafe-eval'` only while `opts.unsafeEval` (b7 risk 2) or in dev.
 */

/** Knobs of {@link editorCsp}; the production policy is `{ dev: false, unsafeEval: false }`. */
export interface EditorCspOptions {
  /** `next dev`: Next's dev runtime injects inline styles, so style-src relaxes (never in production). */
  dev: boolean;
  /** `ZS_CSP_UNSAFE_EVAL=1`. */
  unsafeEval: boolean;
  /**
   * `ZS_SANDBOX_BACKEND=local` (refused in a production build by `lib/sandbox-local.ts`):
   * the rpc socket and the `/files` routes are loopback listeners, not `*.vercel.run`.
   */
  localSandbox?: boolean;
}

const PRODUCTION_CONNECT_SRC = "connect-src 'self' wss://*.vercel.run https://*.vercel.run";
const LOCAL_CONNECT_SRC = `${PRODUCTION_CONNECT_SRC} ws://127.0.0.1:* http://127.0.0.1:* ws://localhost:* http://localhost:*`;

export function editorCsp(nonce: string, opts: EditorCspOptions): string {
  const evalSource = opts.dev || opts.unsafeEval ? " 'unsafe-eval'" : "";
  // `next dev` injects nonce-less inline `<style>` elements (the error overlay, HMR, React's
  // dev hooks), which a nonce-only style-src reports as dozens of violations per page. Browsers
  // ignore 'unsafe-inline' whenever a nonce is present in the same directive, so the dev policy
  // drops the style nonce instead of adding to it. `dev` is `NODE_ENV === "development"`
  // (proxy.ts), which a production build never is: the shipped policy stays nonce-only.
  const styleSrc = opts.dev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`;
  const connectSrc = opts.localSandbox ? LOCAL_CONNECT_SRC : PRODUCTION_CONNECT_SRC;
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${evalSource}`,
    connectSrc,
    "worker-src 'self' blob:",
    "img-src 'self' blob: data:",
    styleSrc,
    "font-src 'self' blob: data:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    // WebKit upgrades even loopback HTTP assets to HTTPS. The local dev server
    // has no TLS listener; keep the production requirement, omit it in next dev.
    ...(!opts.dev ? ["upgrade-insecure-requests"] : []),
  ].join("; ");
}

/** A fresh base64 nonce for one editor document response. */
export function newCspNonce(): string {
  return Buffer.from(globalThis.crypto.randomUUID()).toString("base64");
}
