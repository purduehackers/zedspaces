import { ApiError } from "./api";
import type { Viewer } from "./auth";
import { dbReady } from "./db";
import { fetchRepo } from "./github";
import { newId } from "./ids";
import { PUBLIC_INSTALLATION_ID } from "./public-space";
import { repos, type Repo } from "./schema";

export async function registerRepo(
  _viewer: Viewer,
  input: { installationId?: number; owner: string; name: string },
): Promise<Repo> {
  const source = input.owner === "local" ? (input.installationId ?? 1) : PUBLIC_INSTALLATION_ID;
  const meta = await fetchRepo(source, input.owner, input.name);
  if (!meta || meta.private) throw new ApiError(404, "repo_not_found", `${input.owner}/${input.name} is not a public repository`);
  const fields = {
    installationId: source, githubRepoId: meta.id, owner: meta.owner, name: meta.name,
    defaultBranch: meta.defaultBranch, private: false, updatedAt: new Date(),
  };
  const [repo] = await (await dbReady()).insert(repos).values({ id: newId("repo"), ...fields })
    .onConflictDoUpdate({ target: repos.githubRepoId, set: fields }).returning();
  return repo;
}
