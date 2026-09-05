import type { InstallationRepo, RefRequest } from "@/lib/github";
import { ApiError } from "@/lib/api";

interface FakeGithubState {
  repos: InstallationRepo[];
  headSha: string;
  tokenCalls: unknown[];
}
const KEY = "__zsFakeGithub";
export function githubState(): FakeGithubState {
  const global = globalThis as typeof globalThis & { [KEY]?: FakeGithubState };
  return global[KEY] ??= defaults();
}
function defaults(): FakeGithubState {
  return { repos: [{ id: 42, owner: "test", name: "repo", defaultBranch: "main", private: false }],
    headSha: "a".repeat(40), tokenCalls: [] };
}
export function resetGithub(): void { Object.assign(githubState(), defaults()); }

export function createGithubMock() {
  const find = (owner: string, name: string) => githubState().repos.find((repo) => repo.owner === owner && repo.name === name) ?? null;
  return {
    cloneUrl: (owner: string, name: string) => `https://github.com/${owner}/${name}.git`,
    fetchRepo: async (_sourceId: number, owner: string, name: string) => find(owner, name),
    resolveRef: async (_sourceId: number, owner: string, name: string, ref: RefRequest) => {
      const repo = find(owner, name);
      if (!repo) throw new ApiError(404, "repo_not_found", "Repository not found");
      const sha = "revision" in ref ? ref.revision : githubState().headSha;
      if ("pullRequest" in ref) return { branch: `pr-${ref.pullRequest}`, sha, gitRef: `refs/pull/${ref.pullRequest}/head` };
      return { branch: "revision" in ref ? null : ("branch" in ref ? ref.branch : repo.defaultBranch), sha, gitRef: null };
    },
  };
}
