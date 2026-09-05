/** Synthetic principals for focused route/permission unit tests.
 * Production always uses the real shared viewer. tests/public-space.test.ts covers that seam.
 */
import { and, eq } from "drizzle-orm";
import { ApiError } from "@/lib/api";
import { dbReady } from "@/lib/db";
import { memberships, users } from "@/lib/schema";
import { verifyEditorCookie } from "@/lib/editor-cookie";
import type * as Auth from "@/lib/auth";

interface State { userId: string | null; email: string | null; githubId: number | null; githubLogin: string | null; oauthToken: string | null }
const KEY = "__zsTestViewer";
function state(): State {
  const g = globalThis as typeof globalThis & { [KEY]?: State };
  return g[KEY] ??= { userId: null, email: null, githubId: null, githubLogin: null, oauthToken: "unused" };
}
export function setViewer(userId: string | null, patch: Partial<State> = {}): void { Object.assign(state(), { userId, ...patch }); }
export function setGithubOauthToken(token: string | null): void { state().oauthToken = token; }
export function resetViewer(): void { Object.assign(state(), { userId: null, email: null, githubId: null, githubLogin: null }); }

export function createViewerMock(actual: typeof Auth): typeof Auth {
  return {
    ...actual,
    async requireViewer(opts) {
      let id = state().userId;
      let epoch: number | undefined;
      if (!id && opts?.allowEditorCookie && opts.workspaceId) {
        const { cookies } = await import("next/headers");
        const claims = await verifyEditorCookie(await cookies(), opts.workspaceId);
        if (claims) { id = claims.sub; epoch = claims.ep; }
      }
      if (!id) throw new ApiError(401, "unauthenticated", "Synthetic test principal missing");
      const db = await dbReady();
      const [account] = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (account?.deletedAt) throw new ApiError(403, "account_deleted", "This test principal was deleted");
      if (epoch !== undefined && epoch !== (account?.authEpoch ?? 0)) throw new ApiError(401, "unauthenticated", "Expired test cookie");
      const rows = await db.select().from(memberships).where(eq(memberships.userId, id));
      return { userId: id, orgIds: rows.map((r) => r.orgId), via: epoch !== undefined ? "editor-cookie" : "test", flaggedAt: account?.flaggedAt ?? null };
    },
    async ensureUser(viewer) {
      const db = await dbReady();
      const s = state();
      await db.insert(users).values({ id: viewer.userId, email: s.email ?? viewer.userId + "@example.com", githubId: s.githubId, githubLogin: s.githubLogin }).onConflictDoNothing();
      const [row] = await db.select().from(users).where(and(eq(users.id, viewer.userId))).limit(1);
      return row;
    },
  };
}
