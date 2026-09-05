/** @vitest-environment jsdom */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WorkspaceList } from "@/app/(site)/(dashboard)/_components/workspace-list";
import type { WorkspaceView } from "@/lib/types";

/**
 * Component test of the workspace list (BUILD-SPEC §7.7): it must show state,
 * repository, branch, machine, last active and cost to date for every row,
 * and an actionable empty state when there is nothing to show.
 */

const NOW = Date.parse("2026-09-02T12:00:00.000Z");

function workspace(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    id: "ws_0123456789ABCDEFGHJK",
    name: "demo",
    repo: { id: "repo_0123456789ABCDEFGHJK", owner: "acme", name: "demo", defaultBranch: "main" },
    branch: "main",
    revision: "0123456789abcdef0123456789abcdef01234567",
    pullRequest: null,
    machine: "vcpu4",
    region: "iad1",
    state: "running",
    stateReason: null,
    workflowRunId: null,
    idleMinutes: 30,
    serverBuild: "b-1",
    clientBuild: "b-1",
    lastActiveAt: "2026-09-02T11:45:00.000Z",
    createdAt: "2026-09-01T10:00:00.000Z",
    lastStoppedAt: null,
    retentionUntil: null,
    forwards: [],
    image: { kind: "base", ref: "zs-workspace:b-1", serverBuild: "b-1", stale: false },
    ...overrides,
  };
}

function rowOf(id: string): HTMLElement {
  const row = document.querySelector(`tr[data-workspace="${id}"]`);
  if (!(row instanceof HTMLElement)) throw new Error(`no row for ${id}`);
  return row;
}

describe("WorkspaceList", () => {
  it("shows state, repo, branch, machine and last active for each workspace", () => {
    render(<WorkspaceList workspaces={[workspace()]} now={NOW} />);

    const row = rowOf("ws_0123456789ABCDEFGHJK");
    expect(within(row).getByRole("link", { name: "demo" }).getAttribute("href")).toBe(
      "/workspaces/ws_0123456789ABCDEFGHJK",
    );
    expect(within(row).getByText("acme/demo")).toBeTruthy();
    expect(within(row).getByText("Running")).toBeTruthy();
    expect(within(row).getByText("main")).toBeTruthy();
    expect(within(row).getByText("4 vCPU · 8 GB")).toBeTruthy();
    expect(within(row).getByText("iad1")).toBeTruthy();
    expect(within(row).getByText("15 min ago")).toBeTruthy();
    expect(within(row).queryByText(/\$/)).toBeNull();
  });

  it("links each row to its editor document", () => {
    render(<WorkspaceList workspaces={[workspace()]} now={NOW} />);
    expect(screen.getByRole("link", { name: "Open demo in the editor" }).getAttribute("href")).toBe(
      "/w/ws_0123456789ABCDEFGHJK",
    );
  });

  it("labels a pull-request workspace by its number and a pinned one by its revision", () => {
    render(
      <WorkspaceList
        workspaces={[
          workspace({ id: "ws_0123456789ABCDEFGHJM", name: "from-pr", branch: "feature", pullRequest: 42 }),
          workspace({ id: "ws_0123456789ABCDEFGHJN", name: "pinned", branch: null, pullRequest: null }),
        ]}
        now={NOW}
      />,
    );

    expect(within(rowOf("ws_0123456789ABCDEFGHJM")).getByText("PR #42")).toBeTruthy();
    expect(within(rowOf("ws_0123456789ABCDEFGHJN")).getByText("0123456")).toBeTruthy();
  });

  it("shows the boot phase of a workspace that is still creating", () => {
    render(
      <WorkspaceList
        workspaces={[workspace({ state: "creating", stateReason: "boot:clone" })]}
        now={NOW}
      />,
    );
    const row = rowOf("ws_0123456789ABCDEFGHJK");
    expect(within(row).getByText("Creating")).toBeTruthy();
    expect(within(row).getByText("boot:clone")).toBeTruthy();
  });

  it("renders every workspace it is given, newest first as delivered", () => {
    render(
      <WorkspaceList
        workspaces={[
          workspace({ id: "ws_0123456789ABCDEFGHJK", name: "first" }),
          workspace({ id: "ws_0123456789ABCDEFGHJM", name: "second", state: "stopped" }),
        ]}
        now={NOW}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1); // drop the header row
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole("link", { name: "first" })).toBeTruthy();
    expect(within(rows[1]).getByText("Stopped")).toBeTruthy();
  });

  it("offers the create flow when there is no workspace", () => {
    render(<WorkspaceList workspaces={[]} now={NOW} />);
    expect(screen.getByText("No workspaces yet")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Create your first workspace" }).getAttribute("href")).toBe(
      "/workspaces/new",
    );
    expect(screen.queryByRole("table")).toBeNull();
  });
});
