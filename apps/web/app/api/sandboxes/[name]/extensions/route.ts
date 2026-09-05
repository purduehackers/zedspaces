import { eq } from "drizzle-orm";
import { handler, noContent, parseBody, type RouteCtx } from "@/lib/api";
import { dbReady } from "@/lib/db";
import { requireSandboxParam, type SandboxParams } from "@/lib/sandbox-request";
import { workspaces } from "@/lib/schema";
import { installedExtensions } from "@/lib/types";

export const runtime = "nodejs";

/**
 * `POST /api/sandboxes/{name}/extensions` – the supervisor's relay of the
 * server's installed-extension list (D18/D19). The list is replayed into the
 * next manifest so a rebuilt workspace reinstalls the same extensions.
 */
export const POST = handler(async (req: Request, ctx: RouteCtx<SandboxParams>) => {
  const principal = await requireSandboxParam(req, ctx, "sandbox.extensions");
  const body = await parseBody(req, installedExtensions, { maxBytes: 32 * 1024 });
  const db = await dbReady();
  const installed = [...new Set(body.installed)].sort();
  await db
    .update(workspaces)
    .set({ installedExtensions: installed, updatedAt: new Date() })
    .where(eq(workspaces.id, principal.workspace.id));
  return noContent();
});
