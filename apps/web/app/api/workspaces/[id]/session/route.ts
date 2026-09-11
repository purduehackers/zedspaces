import { handler, noContent } from "@/lib/api";
import { login } from "@/lib/login";
import { requireWorkspaceParam, type WorkspaceParams } from "@/lib/route-context";

export const runtime = "nodejs";

/** The editor's periodic heartbeat refreshes the account session cookie. */
export const POST = handler<Request, WorkspaceParams>(async (req, ctx) => {
  await requireWorkspaceParam(ctx);
  const refreshed = await (await login()).api.getSession({ headers: req.headers, asResponse: true });
  const headers = new Headers();
  for (const cookie of refreshed.headers.getSetCookie()) headers.append("set-cookie", cookie);
  return noContent({ headers });
});
