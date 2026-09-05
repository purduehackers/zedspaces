import { NextResponse, type NextRequest } from "next/server";
import { editorCsp, newCspNonce } from "@/lib/csp";
import { devRequestRefusal } from "@/lib/dev-auth";
import { EDITOR_COOKIE, editorCookieAttributes, mintEditorCookie } from "@/lib/editor-cookie";
import { env } from "@/lib/env";
import { WORKSPACE_ID_RE } from "@/lib/ids";
import { PUBLIC_USER_ID } from "@/lib/public-space";

/** Login-free proxy: local-machine origin protection and the editor's isolation/CSP. */
export default async function proxy(req: NextRequest): Promise<NextResponse> {
  if (env().ZS_SANDBOX_BACKEND === "local") {
    const refusal = devRequestRefusal(req.headers);
    if (refusal) return NextResponse.json({ error: { code: "dev_origin_refused", message: refusal } }, { status: 403 });
  }
  // Public access is intentional, but third-party forms must not spend the Sandbox budget.
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    const origin = req.headers.get("origin");
    const site = req.headers.get("sec-fetch-site");
    // Next dev can normalize 127.0.0.1 to localhost in nextUrl; Host is the
    // browser-facing authority (also preserves custom domains on Vercel).
    let originMatches = !origin;
    if (origin) {
      try {
        const url = new URL(origin);
        originMatches = ["http:", "https:"].includes(url.protocol) && url.host === req.headers.get("host");
      } catch { originMatches = false; }
    }
    if (!originMatches || (site && site !== "same-origin" && site !== "none")) {
      return NextResponse.json({ error: { code: "origin_refused", message: "Use this site's own workspace controls" } }, { status: 403 });
    }
  }
  if (!/^\/w\//.test(req.nextUrl.pathname)) return NextResponse.next();
  return editorDocumentResponse(req, PUBLIC_USER_ID);
}

/** The `/w/:id` document response: nonce CSP plus the `zs_editor` cookie for `userId`. */
async function editorDocumentResponse(req: NextRequest, userId: string): Promise<NextResponse> {
  const nonce = newCspNonce();
  const csp = editorCsp(nonce, {
    dev: process.env.NODE_ENV === "development",
    unsafeEval: env().ZS_CSP_UNSAFE_EVAL === "1",
    // The local backend's loopback rpc listener (never in a production build, lib/sandbox-local.ts).
    localSandbox: env().ZS_SANDBOX_BACKEND === "local" && process.env.NODE_ENV !== "production",
  });
  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);
  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("Content-Security-Policy", csp);

  const wsId = req.nextUrl.pathname.split("/")[2] ?? "";
  // Document requests only: the cookie proves "userId"; workspace access is checked in page.tsx.
  if (WORKSPACE_ID_RE.test(wsId) && req.headers.get("sec-fetch-dest") !== "empty") {
    // A fresh lineage: `page.tsx` re-stamps the cookie with the user's current auth epoch.
    const cookie = await mintEditorCookie(userId, wsId);
    res.cookies.set(EDITOR_COOKIE, cookie.value, editorCookieAttributes(wsId, cookie.expires));
  }
  return res;
}

export const config = {
  matcher: [
    // Skip assets and independently authenticated VM, cron and Workflow endpoints.
    // API paths still pass the origin guard even when a segment has a file suffix.
    "/((?!_next|editor/|sw\\.js|manifest\\.webmanifest|\\.well-known/workflow/|api/sandboxes/|api/cron/|api/ai/|(?!api/).*\\.(?:html?|css|js|wasm|tar|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)$).*)",
  ],
};
