import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { handler, noContent } from "@/lib/api";
import { dbReady } from "@/lib/db";
import { EDITOR_COOKIE, editorCookieAttributes, mintEditorCookie, verifyEditorCookie } from "@/lib/editor-cookie";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";
import { users } from "@/lib/schema";

export const runtime = "nodejs";

/** Serializes cookie attributes into a `Set-Cookie` header value. */
function setCookieHeader(workspaceId: string, value: string, expires: Date): string {
  const attrs = editorCookieAttributes(workspaceId, expires);
  const parts = [
    `${EDITOR_COOKIE}=${value}`,
    `Path=${attrs.path}`,
    `Expires=${attrs.expires.toUTCString()}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (attrs.secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * `POST /api/workspaces/{id}/session` – re-mints the `zs_editor` cookie.
 *
 * Compatibility with the built editor shell's periodic session refresh.
 * This internal cookie does not restrict access to the shared public space.
 */
export const POST = handler<Request, WorkspaceParams>(async (_req, ctx) => {
  const { viewer, workspace } = await requireWorkspaceParam(ctx, { allowEditorCookie: true });
  const db = await dbReady();
  const [user] = await db
    .select({ authEpoch: users.authEpoch })
    .from(users)
    .where(eq(users.id, viewer.userId))
    .limit(1);
  const current = viewer.via === "editor-cookie" ? await verifyEditorCookie(await cookies(), workspace.id) : null;
  const cookie = await mintEditorCookie(viewer.userId, workspace.id, {
    epoch: user?.authEpoch ?? 0,
    ...(current ? { originIat: current.oi } : {}),
  });
  const headers = new Headers();
  headers.append("set-cookie", setCookieHeader(workspace.id, cookie.value, cookie.expires));
  return noContent({ headers });
});
