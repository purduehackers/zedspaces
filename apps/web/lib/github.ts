import { Octokit } from "@octokit/rest";
import { ApiError } from "./api";
import { publicGithubError } from "./github-api-error";
import { kv, withLock } from "./kv";
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
  return cachedLookup(["repo", owner.toLowerCase(), name.toLowerCase()], () => loadRepo(owner, name));
}

async function loadRepo(owner: string, name: string): Promise<InstallationRepo | null> {
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
  return cachedLookup(["ref", owner.toLowerCase(), repo.toLowerCase(), ref], () => loadRef(owner, repo, ref));
}

async function loadRef(owner: string, repo: string, ref: RefRequest): Promise<ResolvedRef> {
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

/** Coalesce a roomful of students onto one unauthenticated GitHub lookup per minute. */
async function cachedLookup<T>(identity: unknown[], fetchValue: () => Promise<T>): Promise<T> {
  const key = `zs:github:${JSON.stringify(identity)}`;
  const store = kv();
  const deadline = Date.now() + 18_000;
  do {
    const cached = await store.get(key);
    if (cached !== null) return JSON.parse(cached) as T;
    const result = await withLock(`${key}:lock`, 35_000, async () => {
      const cached = await store.get(key);
      if (cached !== null) return { value: JSON.parse(cached) as T };
      const value = await fetchValue();
      await store.set(key, JSON.stringify(value), { exMs: 60_000 });
      return { value };
    });
    if (result) return result.value;
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  throw new ApiError(503, "repository_busy", "The workshop repository is being checked. Try again in a moment.", undefined, { "Retry-After": "2" });
}
