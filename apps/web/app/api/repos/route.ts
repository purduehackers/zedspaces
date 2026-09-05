import { eq } from "drizzle-orm";
import { z } from "zod";
import { handler, json, parseBody } from "@/lib/api";
import { assertNotFlagged, requireViewer } from "@/lib/auth";
import { dbReady } from "@/lib/db";
import { githubOwner, githubName } from "@/lib/github-repo";
import { limit } from "@/lib/ratelimit";
import { registerRepo } from "@/lib/repos";
import { repos } from "@/lib/schema";
import { toRepoView } from "@/lib/views";

export const runtime = "nodejs";

export const GET = handler(async () => {
  const viewer = await requireViewer();
  await limit("user.repos", viewer.userId);
  const db = await dbReady();
  const rows = await db.select().from(repos).where(eq(repos.private, false)).orderBy(repos.owner, repos.name);
  return json({ repos: rows.map(toRepoView) });
});

export const POST = handler(async (req) => {
  const viewer = await requireViewer();
  assertNotFlagged(viewer);
  await limit("user.repos", viewer.userId);
  const input = await parseBody(req, z.object({ owner: githubOwner, name: githubName }));
  return json({ repo: toRepoView(await registerRepo(viewer, input)) });
});
