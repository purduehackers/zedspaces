import { z } from "zod";
import { handler, json, parseBody } from "@/lib/api";
import { assertNotFlagged, requireViewer } from "@/lib/auth";
import { githubOwner, githubName } from "@/lib/github-repo";
import { limit } from "@/lib/ratelimit";
import { registerRepo } from "@/lib/repos";
import { toRepoView, visibleRepos } from "@/lib/views";

export const runtime = "nodejs";

export const GET = handler(async () => {
  const viewer = await requireViewer();
  await limit("user.repos", viewer.userId);
  return json({ repos: await visibleRepos(viewer.userId) });
});

export const POST = handler(async (req) => {
  const viewer = await requireViewer();
  assertNotFlagged(viewer);
  await limit("user.repos", viewer.userId);
  const input = await parseBody(req, z.object({ owner: githubOwner, name: githubName }));
  return json({ repo: toRepoView(await registerRepo(viewer, input)) });
});
