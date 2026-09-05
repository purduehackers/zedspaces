import { describe, expect, it } from "vitest";
import { toShellWorkspace, workspaceDir, workspacePaths } from "@/lib/shell";
import type { Repo, Workspace } from "@/lib/schema";

const REPO = { id: "repo_1", owner: "acme", name: "demo" } as unknown as Repo;

const WORKSPACE = {
  id: "ws_0123456789ABCDEFGHJK",
  name: "demo",
  repoId: "repo_1",
  branch: "main",
  machine: "vcpu4",
  region: "iad1",
  state: "running",
  stateReason: null,
  idleMinutes: 30,
  serverBuild: "b-1",
  clientBuild: "b-1",
} as unknown as Workspace;

describe("editor page props", () => {
  it("opens_the_clone_inside_the_sandbox", () => {
    expect(workspaceDir(REPO)).toBe("/workspaces/demo");
    expect(workspacePaths(REPO)).toEqual(["/workspaces/demo"]);
  });

  it("carries_only_non_secret_workspace_facts_to_the_client", () => {
    const shell = toShellWorkspace(WORKSPACE, REPO);
    expect(shell).toEqual({
      id: "ws_0123456789ABCDEFGHJK",
      name: "demo",
      repo: "acme/demo",
      branch: "main",
      machine: "vcpu4",
      region: "iad1",
      state: "running",
      stateReason: null,
      idleMinutes: 30,
      serverBuild: "b-1",
      clientBuild: "b-1",
    });
    // The shell never learns the sandbox name, the audience or any token (b9 §3.26 bullet 7).
    expect(JSON.stringify(shell)).not.toContain("sandbox");
  });

  it("survives_a_repo_row_that_disappeared", () => {
    expect(toShellWorkspace(WORKSPACE, null).repo).toBe("demo");
  });
});
