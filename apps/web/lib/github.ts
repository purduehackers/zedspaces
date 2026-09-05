import { Octokit } from "@octokit/rest";
import { publicGithubError } from "./github-api-error";
import { isLocalRepo, localCloneUrl, localFetchRepo, localResolveRef } from "./sandbox-local";

const github = new Octokit({ userAgent: "zedspaces", request: { timeout: 15_000 } });
github.hook.error("request", (error) => { throw publicGithubError(error); });

export interface InstallationRepo {
  id: number;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
}
export type RefRequest = { branch?: string; pullRequest?: number; revision?: string };
export interface ResolvedRef { branch: string | null; sha: string; gitRef: string | null }

export function cloneUrl(owner: string, name: string): string {
  return isLocalRepo(owner) ? localCloneUrl(name) : `https://github.com/${owner}/${name}.git`;
}

export async function fetchRepo(_sourceId: number, owner: string, name: string): Promise<InstallationRepo | null> {
  if (isLocalRepo(owner)) return localFetchRepo(name);
  try {
    const { data } = await github.rest.repos.get({ owner, repo: name });
    return data.private ? null : {
      id: data.id, owner: data.owner.login, name: data.name,
      defaultBranch: data.default_branch, private: false,
    };
  } catch (error) {
    if ((error as { status?: number }).status === 404) return null;
    throw error;
  }
}

export async function resolveRef(_sourceId: number, owner: string, repo: string, ref: RefRequest): Promise<ResolvedRef> {
  if (isLocalRepo(owner)) return localResolveRef(repo, ref);
  if (ref.pullRequest !== undefined) {
    const { data } = await github.rest.pulls.get({ owner, repo, pull_number: ref.pullRequest });
    return { branch: data.head.ref, sha: data.head.sha, gitRef: `refs/pull/${ref.pullRequest}/head` };
  }
  if (ref.revision) {
    const { data } = await github.rest.repos.getCommit({ owner, repo, ref: ref.revision });
    return { branch: null, sha: data.sha, gitRef: null };
  }
  const branch = ref.branch ?? (await github.rest.repos.get({ owner, repo })).data.default_branch;
  const { data } = await github.rest.repos.getBranch({ owner, repo, branch });
  return { branch, sha: data.commit.sha, gitRef: null };
}
